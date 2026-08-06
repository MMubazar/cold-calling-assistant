import {
  buildTwiml,
  createCallHandler,
  parseStatsPath,
  readBody,
  socketTransport,
  BodyTooLarge,
  statsPayload,
} from '../src/server.js'
import type { CallResult } from '../src/call/session.js'
import type { Db } from '../src/lib/db.js'

const ENV = {
  publicBaseUrl: 'https://abc.ngrok.app',
  twilioPhoneNumber: '+15550001111',
  verifiedNumbers: ['+923001234567'],
} as any

function deps(overrides: Record<string, unknown> = {}) {
  const created: any[] = []
  return {
    created,
    handler: createCallHandler({
      env: ENV,
      db: {
        getLead: async () => ({ id: 'l1', name: 'Ali', company: 'Acme', phone: '+923001234567' }),
        createCall: async () => ({ id: 'call-1', leadId: 'l1' }),
        attachTwilioSid: async () => {},
        ...(overrides.db as object),
      } as unknown as Db,
      placeCall: async (args: unknown) => { created.push(args); return { sid: 'CA1' } },
      ...overrides,
    }),
  }
}

it('builds TwiML that opens a bidirectional stream with the call id attached', () => {
  const xml = buildTwiml({ wsUrl: 'wss://abc.ngrok.app/media', callId: 'call-1' })
  expect(xml).toContain('<Connect>')
  expect(xml).toContain('<Stream url="wss://abc.ngrok.app/media">')
  expect(xml).toContain('<Parameter name="callId" value="call-1"/>')
})

it('escapes the call id in TwiML', () => {
  expect(buildTwiml({ wsUrl: 'wss://x/media', callId: 'a&b' })).toContain('a&amp;b')
})

it('rejects a number that is not on the allowlist with 403 and never dials', async () => {
  const d = deps()
  const res = await d.handler({ leadId: 'l1', to: '+923009999999' })
  expect(res.status).toBe(403)
  expect(d.created).toEqual([])
})

it('rejects an unparseable number with 403', async () => {
  const d = deps()
  expect((await d.handler({ leadId: 'l1', to: 'garbage' })).status).toBe(403)
})

it('rejects a missing lead with 404 and never dials', async () => {
  const d = deps({ db: { getLead: async () => null } })
  const res = await d.handler({ leadId: 'nope', to: '+923001234567' })
  expect(res.status).toBe(404)
  expect(d.created).toEqual([])
})

it('dials an allowlisted number and returns the call id', async () => {
  const d = deps()
  const res = await d.handler({ leadId: 'l1', to: '+923001234567' })
  expect(res.status).toBe(201)
  expect((res.body as any).callId).toBe('call-1')
})

it('falls back to the lead phone when no destination is supplied', async () => {
  const d = deps()
  expect((await d.handler({ leadId: 'l1' })).status).toBe(201)
  expect(d.created[0].to).toBe('+923001234567')
})

it('requests async machine detection so connection is never delayed', async () => {
  const d = deps()
  await d.handler({ leadId: 'l1', to: '+923001234567' })
  expect(d.created[0].machineDetection).toBe('DetectMessageEnd')
  expect(String(d.created[0].asyncAmd)).toBe('true')
  expect(d.created[0].asyncAmdStatusCallback).toContain('/amd')
})

it('never enables call recording', async () => {
  const d = deps()
  await d.handler({ leadId: 'l1', to: '+923001234567' })
  expect(d.created[0].record).toBeUndefined()
})

it('points Twilio at the twiml route with the call id', async () => {
  const d = deps()
  await d.handler({ leadId: 'l1', to: '+923001234567' })
  expect(d.created[0].url).toBe('https://abc.ngrok.app/twiml?callId=call-1')
})

it('returns 502 when Twilio rejects the call', async () => {
  const d = deps({ placeCall: async () => { throw new Error('twilio down') } })
  expect((await d.handler({ leadId: 'l1', to: '+923001234567' })).status).toBe(502)
})

it('parses a stats path to its call id', () => {
  expect(parseStatsPath('/calls/abc-123/stats')).toBe('abc-123')
})

it('ignores paths that are not stats requests', () => {
  expect(parseStatsPath('/calls')).toBeNull()
  expect(parseStatsPath('/calls/abc-123')).toBeNull()
  expect(parseStatsPath('/calls/abc/123/stats')).toBeNull()
  expect(parseStatsPath('/status')).toBeNull()
})

it('exposes frame-derived counters without persisting them', () => {
  const result: CallResult = {
    disposition: 'failed',
    audio: { agentMs: 4000, prospectMs: 6000, talkRatio: 0.4, agentInterruptions: 2 },
    voicemailDropped: false,
    amdVerdict: 'human',
  }
  expect(statsPayload(result)).toEqual({
    agentMs: 4000, prospectMs: 6000, talkRatio: 0.4, agentInterruptions: 2,
    disposition: 'failed', voicemailDropped: false, amdVerdict: 'human',
  })
})

it('reports zeroed counters before anyone has spoken', () => {
  const result: CallResult = {
    disposition: 'failed',
    audio: { agentMs: 0, prospectMs: 0, talkRatio: 0, agentInterruptions: 0 },
    voicemailDropped: false,
    amdVerdict: null,
  }
  expect(statsPayload(result)).toMatchObject({ agentMs: 0, prospectMs: 0, talkRatio: 0 })
})

// The buffering transport is what stops Twilio's first second of audio being
// dropped while the session is still connecting. It is testable without a socket.

function fakeWs() {
  const sent: string[] = []
  const listeners: Record<string, ((d: unknown) => void)[]> = {}
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => { sent.push(raw) },
    close: () => {},
    on: (event: string, cb: (d: unknown) => void) => { (listeners[event] ??= []).push(cb) },
    off: () => {},
  }
  return {
    ws: ws as unknown as Parameters<typeof socketTransport>[0],
    sent,
    deliver: (raw: string) => (listeners.message ?? []).forEach((cb) => cb(raw)),
  }
}

it('holds messages that arrive before a handler is attached', () => {
  const f = fakeWs()
  const transport = socketTransport(f.ws)
  f.deliver('one')
  f.deliver('two')
  const seen: string[] = []
  transport.onMessage((raw) => seen.push(raw))
  expect(seen).toEqual([]) // still buffered — flush has not run
})

it('replays buffered messages in arrival order on flush', () => {
  const f = fakeWs()
  const transport = socketTransport(f.ws)
  f.deliver('one')
  f.deliver('two')
  const seen: string[] = []
  transport.onMessage((raw) => seen.push(raw))
  transport.flush()
  expect(seen).toEqual(['one', 'two'])
})

// readBody takes an async iterable so the cap is testable without a socket.
async function* body(...chunks: string[]) {
  for (const c of chunks) yield Buffer.from(c)
}

it('reads a body that fits under the cap', async () => {
  expect(await readBody(body('{"a":', '1}'))).toBe('{"a":1}')
})

it('refuses a body over the cap instead of buffering it', async () => {
  const oversized = body('x'.repeat(40 * 1024), 'y'.repeat(40 * 1024))
  await expect(readBody(oversized)).rejects.toBeInstanceOf(BodyTooLarge)
})

it('does not let a late message overtake ones already buffered', () => {
  const f = fakeWs()
  const transport = socketTransport(f.ws)
  f.deliver('first')
  const seen: string[] = []
  transport.onMessage((raw) => seen.push(raw))
  f.deliver('second') // arrives after the handler but before flush
  transport.flush()
  expect(seen).toEqual(['first', 'second'])
})
