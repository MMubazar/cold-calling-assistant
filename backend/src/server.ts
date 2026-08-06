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
import { persistCallResult } from './call/teardown.js'
import { parseTwilioMessage } from './media/twilio-frames.js'

const AGENT_NAME = 'Sara'
const COMPANY_NAME = 'Northwind'
const MAX_SLOTS = 12

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
        machineDetection: 'Enable',
        asyncAmd: 'true',
        asyncAmdStatusCallback: `${base}/amd?callId=${call.id}`,
        asyncAmdStatusCallbackMethod: 'POST',
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

interface Live { session: CallSession; startedAtMs: number }
const live = new Map<string, Live>()

function socketTransport(ws: WebSocket): Transport {
  return {
    send: (raw) => { if (ws.readyState === ws.OPEN) ws.send(raw) },
    close: () => ws.close(),
    onMessage: (cb) => ws.on('message', (d) => cb(d.toString())),
    onClose: (cb) => ws.on('close', cb),
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString()
}

function parseForm(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body))
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
        const verdict = parseForm(await readBody(req)).AnsweredBy ?? 'unknown'
        console.log(`[amd] call=${callId} verdict=${verdict}`)
        live.get(callId)?.session.applyAmdVerdict(verdict)
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && url.pathname === '/status') {
        await readBody(req)
        const entry = live.get(callId)
        if (entry) {
          await persistCallResult(db, callId, entry.session.result(), entry.startedAtMs)
          live.delete(callId)
        }
        return json(res, 200, { ok: true })
      }

      // Live audio counters, read from the in-memory session. The console's
      // talk band needs these mid-call; call_scores is only written at
      // teardown, so without this the band sits blank until hangup.
      const statsFor = parseStatsPath(url.pathname)
      if (req.method === 'GET' && statsFor !== null) {
        const entry = live.get(statsFor)
        if (!entry) return json(res, 404, { error: 'no live call with that id' })
        return json(res, 200, statsPayload(entry.session.result()))
      }

      return json(res, 404, { error: 'not found' })
    } catch (err) {
      console.error('[http] handler failed', err)
      return json(res, 500, { error: 'internal error' })
    }
  })

  const wss = new WebSocketServer({ server, path: '/media' })

  wss.on('connection', (ws) => {
    // The callId arrives in the start event's customParameters, so hold the socket
    // until then before building the session.
    const onFirst = async (data: unknown) => {
      const msg = parseTwilioMessage(String(data))
      if (msg?.event !== 'start') return
      ws.off('message', onFirst)

      const callId = msg.customParameters.callId ?? ''
      const startedAtMs = Date.now()

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

        const session = new CallSession({
          transport: socketTransport(ws), realtime, db, callId, leadId: lead.id, slots, voicemailFrames,
        })
        live.set(callId, { session, startedAtMs })

        session.onFinished(() => {
          void persistCallResult(db, callId, session.result(), startedAtMs)
            .then(() => live.delete(callId))
        })

        // Replay the start event the session did not see while we were setting up.
        session.handleTwilioMessage(String(data))
        realtime.requestResponse()
        console.log(`[media] session live call=${callId} lead=${lead.name}`)
      } catch (err) {
        console.error('[media] failed to start session', err)
        ws.close()
      }
    }

    ws.on('message', onFirst)
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
