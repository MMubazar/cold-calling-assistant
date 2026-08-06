import { CallSession, type Transport } from '../src/call/session.js'
import type { RealtimeClient, RealtimeEvent } from '../src/agent/realtime.js'
import type { Db, Slot } from '../src/lib/db.js'

const SLOTS: Slot[] = [{ id: 's1', startsAt: new Date('2026-08-10T09:00:00Z') }]

function fakeTransport() {
  const sent: string[] = []
  let onMsg: (raw: string) => void = () => {}
  let onClose: () => void = () => {}
  const transport: Transport = {
    send: (raw) => { sent.push(raw) },
    close: () => { onClose() },
    onMessage: (cb) => { onMsg = cb },
    onClose: (cb) => { onClose = cb },
  }
  return { transport, sent, inject: (raw: string) => onMsg(raw), fireClose: () => onClose() }
}

function fakeRealtime() {
  const calls: string[] = []
  let handler: (e: RealtimeEvent) => void = () => {}
  const client: RealtimeClient = {
    sendAudio: (b64) => { calls.push(`audio:${b64}`) },
    sendToolResult: (id, out) => { calls.push(`toolresult:${id}:${JSON.stringify(out)}`) },
    cancelResponse: () => { calls.push('cancel') },
    requestResponse: () => { calls.push('response') },
    on: (h) => { handler = h },
    close: () => { calls.push('close') },
  }
  return { client, calls, emit: (e: RealtimeEvent) => handler(e) }
}

// Parameters are annotated because the `as unknown as Db` cast happens after the
// literal is built, so nothing contextually types these callbacks. Without the
// annotations `noImplicitAny` fails the typecheck.
function fakeDb(): Db {
  return {
    insertTranscriptTurn: async () => {},
    getMeetingByCall: async () => null,
    takeSlot: async () => true,
    insertMeeting: async (_c: string, _l: string, s: Slot) =>
      ({ id: 'm1', slotId: s.id, startsAt: s.startsAt }),
    upsertQualification: async () => {},
  } as unknown as Db
}

function startMessage(callId = 'call-1') {
  return JSON.stringify({
    event: 'start',
    streamSid: 'MZ1',
    start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { callId } },
  })
}

const mediaMsg = (payload: string) =>
  JSON.stringify({ event: 'media', streamSid: 'MZ1', media: { track: 'inbound', payload } })

function build() {
  const t = fakeTransport()
  const r = fakeRealtime()
  const session = new CallSession({
    transport: t.transport,
    realtime: r.client,
    db: fakeDb(),
    callId: 'call-1',
    leadId: 'lead-1',
    slots: SLOTS,
    voicemailFrames: ['VM1', 'VM2'],
  })
  return { session, t, r }
}

it('forwards inbound media to the model', () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  t.inject(mediaMsg('AAAA'))
  expect(r.calls).toContain('audio:AAAA')
})

it('ignores media that arrives before the start event', () => {
  const { t, r } = build()
  t.inject(mediaMsg('AAAA'))
  expect(r.calls).not.toContain('audio:AAAA')
})

it('relays model audio back to Twilio as a media message on the right stream', () => {
  const { t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'audio', payload: 'BBBB' })
  const parsed = t.sent.map((s) => JSON.parse(s))
  expect(parsed).toEqual(expect.arrayContaining([
    { event: 'media', streamSid: 'MZ1', media: { payload: 'BBBB' } },
  ]))
})

it('on barge-in sends a clear to Twilio AND cancels the model response', () => {
  const { t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'audio', payload: 'BBBB' })
  r.emit({ kind: 'prospect_speech_started' })
  expect(t.sent.map((s) => JSON.parse(s).event)).toContain('clear')
  expect(r.calls).toContain('cancel')
})

it('does not send a clear when the agent was not speaking', () => {
  const { t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'prospect_speech_started' })
  expect(t.sent.map((s) => JSON.parse(s).event)).not.toContain('clear')
})

it('counts an interruption when model audio starts while the prospect is speaking', () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'prospect_speech_started' })
  r.emit({ kind: 'audio', payload: 'BBBB' })
  expect(session.result().audio.agentInterruptions).toBe(1)
})

it('counts prospect speech only between speech start and stop', () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  t.inject(mediaMsg('X'))                    // silence, not counted
  r.emit({ kind: 'prospect_speech_started' })
  t.inject(mediaMsg('X'))
  t.inject(mediaMsg('X'))                    // 40 ms counted
  r.emit({ kind: 'prospect_speech_stopped' })
  t.inject(mediaMsg('X'))                    // silence, not counted
  expect(session.result().audio.prospectMs).toBe(40)
})

it('executes a tool call and returns its result to the model', async () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'tool_call', toolCallId: 'fc1', name: 'book_meeting', args: { slot_id: 's1' } })
  await session.settled()
  expect(r.calls.find((c) => c.startsWith('toolresult:fc1'))).toMatch(/"booked":true/)
})

it('sets disposition booked when a meeting is booked', async () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'tool_call', toolCallId: 'fc1', name: 'book_meeting', args: { slot_id: 's1' } })
  await session.settled()
  expect(session.result().disposition).toBe('booked')
})

it('closes the call when end_call is invoked', async () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'tool_call', toolCallId: 'fc1', name: 'end_call', args: { reason: 'refused twice' } })
  await session.settled()
  expect(r.calls).toContain('close')
  expect(session.result().disposition).toBe('not_interested')
})

it('stores transcript turns for both sides', async () => {
  const stored: [string, string][] = []
  const t = fakeTransport()
  const r = fakeRealtime()
  const session = new CallSession({
    transport: t.transport, realtime: r.client, callId: 'c', leadId: 'l', slots: SLOTS,
    voicemailFrames: [],
    db: {
      insertTranscriptTurn: async (_c: string, role: 'agent' | 'prospect', text: string) => {
        stored.push([role, text])
      },
    } as unknown as Db,
  })
  t.inject(startMessage())
  r.emit({ kind: 'transcript', role: 'agent', text: 'Hi, this is Sara' })
  r.emit({ kind: 'transcript', role: 'prospect', text: 'Who is this' })
  await session.settled()
  expect(stored).toEqual([['agent', 'Hi, this is Sara'], ['prospect', 'Who is this']])
})

it('ignores empty transcripts', async () => {
  const stored: unknown[] = []
  const t = fakeTransport()
  const r = fakeRealtime()
  const session = new CallSession({
    transport: t.transport, realtime: r.client, callId: 'c', leadId: 'l', slots: SLOTS,
    voicemailFrames: [],
    db: { insertTranscriptTurn: async () => { stored.push(1) } } as unknown as Db,
  })
  t.inject(startMessage())
  r.emit({ kind: 'transcript', role: 'agent', text: '   ' })
  await session.settled()
  expect(stored).toHaveLength(0)
})

it('marks disposition failed when the model session errors out', () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'error', message: 'session died' })
  expect(session.result().disposition).toBe('failed')
})

it('finishes on the Twilio stop event and notifies listeners exactly once', () => {
  const { session, t } = build()
  let finished = 0
  session.onFinished(() => { finished++ })
  t.inject(startMessage())
  t.inject(JSON.stringify({ event: 'stop' }))
  t.fireClose()
  expect(finished).toBe(1)
})

it('ignores malformed Twilio messages without throwing', () => {
  const { session, t } = build()
  expect(() => { t.inject('{broken'); t.inject(JSON.stringify({ event: 'dtmf' })) }).not.toThrow()
  expect(session.result().disposition).toBe('failed')
})

// A booked meeting exists in the database. Nothing that happens afterwards may
// cause the call to be recorded as anything other than booked.
it('keeps disposition booked when end_call follows a successful booking', async () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'tool_call', toolCallId: 'fc1', name: 'book_meeting', args: { slot_id: 's1' } })
  await session.settled()
  r.emit({ kind: 'tool_call', toolCallId: 'fc2', name: 'end_call', args: { reason: 'done' } })
  await session.settled()
  expect(session.result().disposition).toBe('booked')
})

it('keeps disposition booked when the model session errors after a booking', async () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'tool_call', toolCallId: 'fc1', name: 'book_meeting', args: { slot_id: 's1' } })
  await session.settled()
  r.emit({ kind: 'error', message: 'socket died' })
  expect(session.result().disposition).toBe('booked')
})

it('sends nothing to Twilio when model audio arrives before the start event', () => {
  const { session, t, r } = build()
  r.emit({ kind: 'audio', payload: 'BBBB' })
  expect(t.sent).toEqual([])
  expect(session.result().audio.agentMs).toBe(0)
})

it('does not count an empty audio delta as 20 ms of speech', () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'audio', payload: '' })
  expect(session.result().audio.agentMs).toBe(0)
})
