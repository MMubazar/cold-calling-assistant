import { CallSession, type Transport } from '../src/call/session.js'
import type { RealtimeClient, RealtimeEvent } from '../src/agent/realtime.js'
import type { Db } from '../src/lib/db.js'
import { encodePcm16ToUlaw, SPEECH_FRAMES_TO_ABORT } from '../src/media/ulaw.js'

function harness(voicemailFrames = ['VM1', 'VM2', 'VM3']) {
  const sent: string[] = []
  const rtCalls: string[] = []
  let onMsg: (raw: string) => void = () => {}
  let onClose: () => void = () => {}
  let emit: (e: RealtimeEvent) => void = () => {}

  const transport: Transport = {
    send: (raw) => { sent.push(raw) },
    close: () => { onClose() },
    onMessage: (cb) => { onMsg = cb },
    onClose: (cb) => { onClose = cb },
  }
  const realtime: RealtimeClient = {
    sendAudio: (b) => { rtCalls.push(`audio:${b}`) },
    sendToolResult: () => {},
    cancelResponse: () => { rtCalls.push('cancel') },
    requestResponse: () => {},
    on: (h) => { emit = h },
    close: () => { rtCalls.push('close') },
  }
  const session = new CallSession({
    transport, realtime, callId: 'c1', leadId: 'l1', slots: [], voicemailFrames,
    db: { insertTranscriptTurn: async () => {} } as unknown as Db,
  })

  onMsg(JSON.stringify({
    event: 'start', streamSid: 'MZ1',
    start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { callId: 'c1' } },
  }))

  // A full frame of μ-law silence, and one of loud tone. Energy, not mere
  // arrival, is what decides whether a human is on the line.
  const SILENT = encodePcm16ToUlaw(new Int16Array(160)).toString('base64')
  const loudSamples = new Int16Array(160)
  for (let i = 0; i < loudSamples.length; i++) loudSamples[i] = i % 2 === 0 ? 8000 : -8000
  const LOUD = encodePcm16ToUlaw(loudSamples).toString('base64')

  const frame = (payload: string) => onMsg(JSON.stringify({
    event: 'media', streamSid: 'MZ1', media: { track: 'inbound', payload },
  }))
  /** Twilio's continuous silence: what an answered-but-quiet line actually sends. */
  const silence = (n = SPEECH_FRAMES_TO_ABORT * 3) => { for (let i = 0; i < n; i++) frame(SILENT) }
  /** Sustained speech, enough to trip the abort threshold. */
  const speak = (n = SPEECH_FRAMES_TO_ABORT) => { for (let i = 0; i < n; i++) frame(LOUD) }
  const mark = (name: string) => onMsg(JSON.stringify({ event: 'mark', mark: { name } }))

  return { session, sent, rtCalls, emit, frame, silence, speak, mark, SILENT, LOUD }
}

const events = (sent: string[]) => sent.map((s) => JSON.parse(s).event)
const payloads = (sent: string[]) =>
  sent.map((s) => JSON.parse(s)).filter((m) => m.event === 'media').map((m) => m.media.payload)

it('does nothing on a human verdict', () => {
  const h = harness()
  h.session.applyAmdVerdict('human')
  expect(payloads(h.sent)).toEqual([])
  expect(h.session.result().voicemailDropped).toBe(false)
})

it('records the verdict even when it is human', () => {
  const h = harness()
  h.session.applyAmdVerdict('human')
  expect(h.session.result().amdVerdict).toBe('human')
})

it('on a machine verdict closes the model session and plays every voicemail frame', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  expect(h.rtCalls).toContain('close')
  expect(payloads(h.sent)).toEqual(['VM1', 'VM2', 'VM3'])
})

it('clears queued agent audio before playing the message', () => {
  const h = harness()
  h.emit({ kind: 'audio', payload: 'AGENT' })
  h.session.applyAmdVerdict('machine_start')
  const evs = events(h.sent)
  expect(evs.indexOf('clear')).toBeGreaterThan(-1)
  expect(evs.indexOf('clear')).toBeLessThan(evs.lastIndexOf('media'))
})

it('marks the end of playback so hangup can wait for it', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  const marks = h.sent.map((s) => JSON.parse(s)).filter((m) => m.event === 'mark')
  expect(marks.map((m) => m.mark.name)).toContain('voicemail-complete')
})

it('sets disposition voicemail once playback completes', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.mark('voicemail-complete')
  expect(h.session.result().disposition).toBe('voicemail')
  expect(h.session.result().voicemailDropped).toBe(true)
})

it('stops forwarding audio to the model during voicemail mode', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak()
  expect(h.rtCalls.some((c) => c.startsWith('audio:'))).toBe(false)
})

// The defect this replaced: aborting on any inbound frame. Twilio streams silence
// continuously, so that aborted every drop about 20 ms in and the feature was dead.
it('does not abort on continuous silence, which Twilio always sends', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.silence()
  expect(h.session.result().voicemailDropped).toBe(true)
  expect(h.session.result().amdVerdict).toBe('machine_start')
})

it('does not abort on a brief noise burst below the sustained threshold', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak(SPEECH_FRAMES_TO_ABORT - 1)
  expect(h.session.result().voicemailDropped).toBe(true)
})

it('resets the run when speech is interrupted by silence', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak(SPEECH_FRAMES_TO_ABORT - 1)
  h.silence(1)
  h.speak(SPEECH_FRAMES_TO_ABORT - 1)
  expect(h.session.result().voicemailDropped).toBe(true)
})

it('aborts the drop on sustained speech during playback — AMD false positive', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak()
  expect(h.session.result().voicemailDropped).toBe(false)
  expect(h.session.result().disposition).not.toBe('voicemail')
})

it('resumes forwarding audio to the model after an aborted drop', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak()            // trips the abort
  h.frame(h.LOUD)      // this one must reach the model
  expect(h.rtCalls).toContain(`audio:${h.LOUD}`)
})

it('keeps the verdict on record after an abort so false positives are countable', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak()
  expect(h.session.result().amdVerdict).toBe('machine_start_false_positive')
})

it('ignores a voicemail-complete mark that lands after an abort', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak()                    // abort: a human is on the line
  h.mark('voicemail-complete') // a mark already in flight
  expect(h.session.result().disposition).not.toBe('voicemail')
})

it('ignores a verdict arriving after the call already finished', () => {
  const h = harness()
  h.session.end('not_interested')
  h.session.applyAmdVerdict('machine_start')
  expect(payloads(h.sent)).toEqual([])
})

it('falls back to ending the call when no voicemail audio is configured', () => {
  const h = harness([])
  h.session.applyAmdVerdict('machine_start')
  expect(h.session.result().disposition).toBe('voicemail')
  expect(payloads(h.sent)).toEqual([])
})
