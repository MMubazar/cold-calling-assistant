import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import twilio from 'twilio'
import { loadEnv, type Env } from './lib/env.js'
import { createDb, type Db } from './lib/db.js'
import { isAllowed, normalizeE164 } from './lib/allowlist.js'
import { buildInstructions } from './agent/playbook.js'
import { connectRealtime } from './agent/realtime.js'
import { loadVoicemailFrames } from './media/ulaw.js'
import { CallSession, type CallResult, type Transport } from './call/session.js'
import {
  persistCallResult,
  persistUnbridgedCall,
  dispositionForCallStatus,
} from './call/teardown.js'
import { parseTwilioMessage } from './media/twilio-frames.js'

const AGENT_NAME = 'Sara'
const COMPANY_NAME = 'Northwind'
const MAX_SLOTS = 12
/** Spec §5's call-duration ceiling, enforced by Twilio's own timeLimit. */
export const MAX_CALL_SECONDS = 300

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function buildTwiml({ wsUrl, callId }: { wsUrl: string; callId: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}">
      <Parameter name="callId" value="${escapeXml(callId)}"/>
    </Stream>
  </Connect>
</Response>`
}

/** `/calls/<id>/stats` → `<id>`, or null for any other path. */
export function parseStatsPath(pathname: string): string | null {
  const match = /^\/calls\/([^/]+)\/stats$/.exec(pathname)
  return match?.[1] ?? null
}

/** What the console reads mid-call. Frame-derived, never persisted. */
export function statsPayload(result: CallResult): Record<string, unknown> {
  return {
    agentMs: result.audio.agentMs,
    prospectMs: result.audio.prospectMs,
    talkRatio: result.audio.talkRatio,
    agentInterruptions: result.audio.agentInterruptions,
    disposition: result.disposition,
    voicemailDropped: result.voicemailDropped,
    amdVerdict: result.amdVerdict,
  }
}

export interface CallRequest { leadId?: string; to?: string }
export interface HandlerResponse { status: number; body: unknown }

export interface CallHandlerDeps {
  env: Env
  db: Db
  placeCall(args: Record<string, unknown>): Promise<{ sid: string }>
}

export function createCallHandler(deps: CallHandlerDeps) {
  return async function handleCreateCall(req: CallRequest): Promise<HandlerResponse> {
    if (!req.leadId) return { status: 400, body: { error: 'leadId is required' } }

    const lead = await deps.db.getLead(req.leadId)
    if (!lead) return { status: 404, body: { error: 'lead not found' } }

    const destination = req.to ?? lead.phone
    // Spec §3: the allowlist is checked before any Twilio request and is not bypassable.
    if (!isAllowed(destination, deps.env.verifiedNumbers)) {
      return { status: 403, body: { error: 'destination is not on VERIFIED_NUMBERS' } }
    }

    const call = await deps.db.createCall(lead.id)
    const base = deps.env.publicBaseUrl

    try {
      const created = await deps.placeCall({
        to: normalizeE164(destination)!,
        from: deps.env.twilioPhoneNumber,
        url: `${base}/twiml?callId=${call.id}`,
        statusCallback: `${base}/status?callId=${call.id}`,
        statusCallbackEvent: ['completed'],
        // Async so the media stream opens immediately; sync detection would add 2-4 s to
        // every human-answered call (spec §7).
        // DetectMessageEnd, not Enable: 'Enable' reports machine_start when the
        // greeting BEGINS, so we would talk over it and the voicemail drop's
        // energy gate would see the machine's own greeting and abort. Waiting for
        // the greeting to end costs nothing on human-answered calls because the
        // detection is async — only the verdict is delayed, never the connection.
        machineDetection: 'DetectMessageEnd',
        asyncAmd: 'true',
        asyncAmdStatusCallback: `${base}/amd?callId=${call.id}`,
        asyncAmdStatusCallbackMethod: 'POST',
        // Hard ceiling from the design spec. Twilio hangs up at 300 s, which is
        // the only duration limit this system has now that the backend is a
        // long-running process rather than a serverless function.
        timeLimit: MAX_CALL_SECONDS,
      })
      await deps.db.attachTwilioSid(call.id, created.sid)
      return { status: 201, body: { callId: call.id, twilioSid: created.sid } }
    } catch (err) {
      console.error('[calls] Twilio rejected the call', err)
      return { status: 502, body: { error: 'failed to place call' } }
    }
  }
}

// ---------------------------------------------------------------- live sessions

const live = new Map<string, CallSession>()

/** AMD verdicts that arrived before their session finished connecting. */
const earlyVerdicts = new Map<string, string>()

export interface BufferingTransport extends Transport {
  /** Deliver everything received so far, in order, then stream live. */
  flush(): void
}

/**
 * Buffers from the moment the socket opens.
 *
 * Twilio starts streaming audio immediately, but building a session needs three
 * database round trips and a realtime handshake. Without buffering there is no
 * listener attached during that window and the frames are simply lost — `ws`
 * queues nothing — costing the prospect's first second or two of speech on every
 * single call.
 */
export function socketTransport(ws: WebSocket): BufferingTransport {
  const queued: string[] = []
  let handler: ((raw: string) => void) | null = null
  let flushed = false

  ws.on('message', (d) => {
    const raw = d.toString()
    // Keep queueing until flush, so a message arriving between session
    // construction and flush cannot overtake the ones already waiting.
    if (flushed && handler) handler(raw)
    else queued.push(raw)
  })

  return {
    send: (raw) => { if (ws.readyState === ws.OPEN) ws.send(raw) },
    close: () => ws.close(),
    onMessage: (cb) => { handler = cb },
    onClose: (cb) => ws.on('close', cb),
    flush: () => {
      flushed = true
      for (const raw of queued.splice(0)) handler?.(raw)
    },
  }
}

/** 64 KiB. These routes are reachable through a public tunnel. */
const MAX_BODY_BYTES = 64 * 1024

export class BodyTooLarge extends Error {}

/**
 * Reads a request body, refusing to buffer more than the cap.
 *
 * Deliberately does NOT destroy the request: in HTTP/1.x the request and the
 * response share a socket, so tearing it down here means the 413 never reaches
 * the caller — they see a hang-up instead of a status code. The dispatcher
 * responds first and closes afterwards.
 *
 * Takes an async iterable rather than an IncomingMessage so the cap is testable
 * without a socket.
 */
export async function readBody(source: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of source) {
    const chunk = typeof c === 'string' ? Buffer.from(c) : c
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      throw new BodyTooLarge(`body exceeded ${MAX_BODY_BYTES} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString()
}

function parseForm(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body))
}

export interface SignatureCheck {
  authToken: string
  /** PUBLIC_BASE_URL — the host Twilio actually signed, not whatever Host header arrived. */
  publicBaseUrl: string
  /** e.g. `/amd?callId=abc`. Signed exactly as Twilio was configured to call it. */
  pathWithQuery: string
  signature: string | undefined
  params: Record<string, string>
}

/**
 * Whether a Twilio webhook really came from Twilio.
 *
 * `/amd` and `/status` are reachable by anyone who finds the ngrok URL, and both
 * are destructive: a forged `AnsweredBy=machine_start` drops a voicemail over a
 * live human conversation, and a forged `/status` claims the teardown so the real
 * one silently discards the call's disposition and scores.
 *
 * The URL is rebuilt from PUBLIC_BASE_URL rather than taken from the request,
 * because the signature covers the URL Twilio was told to call — a proxied Host
 * header would never match.
 */
export function twilioSignatureOk(check: SignatureCheck): boolean {
  if (typeof check.signature !== 'string' || check.signature.length === 0) return false
  return twilio.validateRequest(
    check.authToken,
    check.signature,
    `${check.publicBaseUrl}${check.pathWithQuery}`,
    check.params,
  )
}

export async function startServer(env: Env): Promise<void> {
  const db = createDb(env.databaseUrl)
  const client = twilio(env.twilioAccountSid, env.twilioAuthToken)
  const voicemailFrames = await loadVoicemailFrames(env.voicemailAudioPath)
  const wsUrl = `${env.publicBaseUrl.replace(/^https?:/, 'wss:')}/media`

  const handleCreateCall = createCallHandler({
    env,
    db,
    placeCall: (args) => client.calls.create(args as any).then((c) => ({ sid: c.sid })),
  })

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  /**
   * `/calls` is deliberately not checked: it is the operator's own curl-driven
   * route and is guarded by VERIFIED_NUMBERS. Twilio's webhooks are.
   */
  const signed = (req: IncomingMessage, url: URL, params: Record<string, string>) =>
    twilioSignatureOk({
      authToken: env.twilioAuthToken,
      publicBaseUrl: env.publicBaseUrl,
      pathWithQuery: `${url.pathname}${url.search}`,
      signature: req.headers['x-twilio-signature'] as string | undefined,
      params,
    })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const callId = url.searchParams.get('callId') ?? ''

    try {
      if (req.method === 'POST' && url.pathname === '/calls') {
        const out = await handleCreateCall(JSON.parse((await readBody(req)) || '{}'))
        return json(res, out.status, out.body)
      }

      if (url.pathname === '/twiml') {
        res.writeHead(200, { 'content-type': 'text/xml' })
        return res.end(buildTwiml({ wsUrl, callId }))
      }

      if (req.method === 'POST' && url.pathname === '/amd') {
        const params = parseForm(await readBody(req))
        if (!signed(req, url, params)) {
          console.warn(`[amd] call=${callId} rejected: bad Twilio signature`)
          return json(res, 403, { error: 'invalid Twilio signature' })
        }
        const verdict = params.AnsweredBy ?? 'unknown'
        console.log(`[amd] call=${callId} verdict=${verdict}`)
        const session = live.get(callId)
        if (session) {
          session.applyAmdVerdict(verdict)
        } else {
          // AMD detection and the media handshake are independent races off the
          // same answer event. A verdict that wins is held for the session to
          // collect, not discarded — dropping it would treat a machine as human
          // and silently defeat the voicemail drop.
          console.warn(`[amd] call=${callId} verdict arrived before the session; holding it`)
          earlyVerdicts.set(callId, verdict)
        }
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && url.pathname === '/status') {
        const params = parseForm(await readBody(req))
        if (!signed(req, url, params)) {
          console.warn(`[status] call=${callId} rejected: bad Twilio signature`)
          return json(res, 403, { error: 'invalid Twilio signature' })
        }
        // Delete before awaiting: the socket close and this callback are both
        // triggered by the call ending, so whichever arrives second must find
        // nothing left to persist. Map.delete returning true is the claim.
        const session = live.get(callId)
        if (session && live.delete(callId)) {
          // Drain in-flight tool and transcript work before snapshotting.
          // Without this a booking still being written persists as 'failed'
          // while its meetings row lands a moment later.
          await session.settled()
          await persistCallResult(db, callId, session.result())
        } else if (!session) {
          // No live entry means the media stream never bridged: no answer, busy,
          // or declined. The row must still be closed — left open, the console's
          // activeCall() returns it forever and the Call button never re-enables.
          // finalizeUnbridgedCall is guarded on `ended_at is null`, so this can
          // never overwrite a real outcome that a media teardown already wrote.
          const status = params.CallStatus ?? ''
          const disposition = dispositionForCallStatus(status)
          console.log(`[status] call=${callId} never bridged (CallStatus=${status || 'unknown'}) -> ${disposition}`)
          await persistUnbridgedCall(db, callId, disposition)
        }
        earlyVerdicts.delete(callId)
        return json(res, 200, { ok: true })
      }

      // Live audio counters, read from the in-memory session. The console's
      // talk band needs these mid-call; call_scores is only written at
      // teardown, so without this the band sits blank until hangup.
      const statsFor = parseStatsPath(url.pathname)
      if (req.method === 'GET' && statsFor !== null) {
        const session = live.get(statsFor)
        if (!session) return json(res, 404, { error: 'no live call with that id' })
        return json(res, 200, statsPayload(session.result()))
      }

      return json(res, 404, { error: 'not found' })
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        console.warn(`[http] rejected oversized body on ${url.pathname}`)
        // Respond BEFORE abandoning the request. The two share a socket, so
        // destroying the request first would replace the 413 with a hang-up.
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify({ error: 'request body too large' }))
        req.destroy()
        return
      }
      console.error('[http] handler failed', err)
      return json(res, 500, { error: 'internal error' })
    }
  })

  const wss = new WebSocketServer({ server, path: '/media' })

  wss.on('connection', (ws) => {
    // Buffering starts the instant the socket opens, before any await, so nothing
    // Twilio sends during setup is lost.
    const transport = socketTransport(ws)
    let starting = false

    // A second listener that only observes. The callId arrives in the start
    // event's customParameters and is needed before a session can be built.
    const detectStart = async (data: unknown) => {
      if (starting) return
      const msg = parseTwilioMessage(String(data))
      if (msg?.event !== 'start') return
      starting = true
      ws.off('message', detectStart)

      const callId = msg.customParameters.callId ?? ''

      try {
        const call = await db.query<{ lead_id: string }>(
          'select lead_id from calls where id = $1', [callId])
        const leadId = call[0]?.lead_id
        if (!leadId) throw new Error(`unknown callId ${callId}`)

        const lead = await db.getLead(leadId)
        if (!lead) throw new Error(`unknown leadId ${leadId}`)

        const slots = await db.getOpenSlots(MAX_SLOTS)
        const realtime = await connectRealtime({
          apiKey: env.openaiApiKey,
          model: env.realtimeModel,
          instructions: buildInstructions({
            lead, slots, agentName: AGENT_NAME, companyName: COMPANY_NAME,
          }),
        })

        // The Twilio socket can die during setup — three database round trips and
        // a realtime handshake happen above. CallSession registers its onClose in
        // the constructor, so on an already-closed socket finish() would never
        // run: both this live entry and the model socket would leak for the life
        // of the process. Check before committing to a session. The call row is
        // still closed out by /status, which now finalizes unbridged calls.
        if (ws.readyState !== ws.OPEN) {
          console.warn(`[media] socket closed during setup call=${callId}; discarding session`)
          realtime.close()
          earlyVerdicts.delete(callId)
          return
        }

        const session = new CallSession({
          transport, realtime, db, callId, leadId: lead.id, slots, voicemailFrames,
        })
        live.set(callId, session)

        session.onFinished(() => {
          // Claim the entry first; /status may be racing us for the same call.
          if (live.delete(callId)) {
            void (async () => {
              // Drain in-flight tool and transcript work before snapshotting, or
              // a booking mid-write persists as 'failed' with a real meeting row.
              await session.settled()
              await persistCallResult(db, callId, session.result())
            })()
          }
          earlyVerdicts.delete(callId)
        })

        // Releases the start event and every frame buffered since, in order.
        transport.flush()

        // A verdict that beat the handshake was held rather than dropped.
        const held = earlyVerdicts.get(callId)
        if (held !== undefined) {
          earlyVerdicts.delete(callId)
          console.log(`[amd] call=${callId} applying held verdict=${held}`)
          session.applyAmdVerdict(held)
        }

        realtime.requestResponse()
        console.log(`[media] session live call=${callId} lead=${lead.name}`)
      } catch (err) {
        console.error('[media] failed to start session', err)
        earlyVerdicts.delete(callId)
        ws.close()
      }
    }

    ws.on('message', detectStart)
  })

  server.listen(env.port, () => {
    console.log(`backend listening on :${env.port}`)
    console.log(`expose it:  ngrok http ${env.port}`)
    console.log(`then set PUBLIC_BASE_URL to the https URL ngrok prints`)
  })
}

if (process.argv[1]?.endsWith('server.ts')) {
  startServer(loadEnv(process.env)).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
