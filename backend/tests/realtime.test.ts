import { buildSessionUpdate, normalizeRealtimeEvent, sendJson } from '../src/agent/realtime.js'
import { SILENCE_DURATION_MS } from '../src/agent/playbook.js'

it('configures μ-law in both directions so no resampling is ever needed', () => {
  const s = buildSessionUpdate('INSTRUCTIONS') as any
  expect(s.session.input_audio_format).toBe('g711_ulaw')
  expect(s.session.output_audio_format).toBe('g711_ulaw')
})

it('uses the tuned silence duration', () => {
  const s = buildSessionUpdate('x') as any
  expect(s.session.turn_detection.silence_duration_ms).toBe(SILENCE_DURATION_MS)
})

it('enables server-side turn detection so we never write endpointing ourselves', () => {
  expect((buildSessionUpdate('x') as any).session.turn_detection.type).toBe('server_vad')
})

it('passes the instructions and all three tools', () => {
  const s = buildSessionUpdate('INSTRUCTIONS') as any
  expect(s.session.instructions).toBe('INSTRUCTIONS')
  expect(s.session.tools).toHaveLength(3)
})

it('requests transcription so transcript turns can be stored', () => {
  expect((buildSessionUpdate('x') as any).session.input_audio_transcription).toBeTruthy()
})

it('normalizes an audio delta', () => {
  const raw = JSON.stringify({ type: 'response.audio.delta', delta: 'QUJD' })
  expect(normalizeRealtimeEvent(raw)).toEqual({ kind: 'audio', payload: 'QUJD' })
})

it('normalizes prospect speech start and stop', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({ type: 'input_audio_buffer.speech_started' })))
    .toEqual({ kind: 'prospect_speech_started' })
  expect(normalizeRealtimeEvent(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' })))
    .toEqual({ kind: 'prospect_speech_stopped' })
})

it('normalizes a completed function call', () => {
  const raw = JSON.stringify({
    type: 'response.function_call_arguments.done',
    call_id: 'fc1', name: 'book_meeting', arguments: '{"slot_id":"s1"}',
  })
  expect(normalizeRealtimeEvent(raw)).toEqual({
    kind: 'tool_call', toolCallId: 'fc1', name: 'book_meeting', args: { slot_id: 's1' },
  })
})

it('treats unparseable tool arguments as empty rather than crashing the call', () => {
  const raw = JSON.stringify({
    type: 'response.function_call_arguments.done', call_id: 'fc1', name: 'end_call', arguments: '{{{',
  })
  expect(normalizeRealtimeEvent(raw)).toEqual({ kind: 'tool_call', toolCallId: 'fc1', name: 'end_call', args: {} })
})

it('normalizes transcripts from both sides', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed', transcript: 'who is this',
  }))).toEqual({ kind: 'transcript', role: 'prospect', text: 'who is this' })

  expect(normalizeRealtimeEvent(JSON.stringify({
    type: 'response.audio_transcript.done', transcript: 'Hi, this is Sara',
  }))).toEqual({ kind: 'transcript', role: 'agent', text: 'Hi, this is Sara' })
})

it('normalizes errors', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({ type: 'error', error: { message: 'bad' } })))
    .toEqual({ kind: 'error', message: 'bad' })
})

it('ignores unknown and malformed events', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({ type: 'rate_limits.updated' }))).toBeNull()
  expect(normalizeRealtimeEvent('nonsense')).toBeNull()
})

// This function is the boundary that keeps a malformed model event from killing
// a live call. Every hostile shape below is asserted, not merely reasoned about.

it('drops a tool call with no call_id — a result would have nowhere to go', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({
    type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}',
  }))).toBeNull()
})

it('drops a tool call with no name', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({
    type: 'response.function_call_arguments.done', call_id: 'fc1', arguments: '{}',
  }))).toBeNull()
})

it('treats absent tool arguments as empty rather than dropping the call', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({
    type: 'response.function_call_arguments.done', call_id: 'fc1', name: 'end_call',
  }))).toEqual({ kind: 'tool_call', toolCallId: 'fc1', name: 'end_call', args: {} })
})

it('ignores an audio delta whose payload is not a string', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({ type: 'response.audio.delta', delta: 42 })))
    .toBeNull()
})

it('ignores JSON that parses to something other than an object', () => {
  expect(normalizeRealtimeEvent('null')).toBeNull()
  expect(normalizeRealtimeEvent('42')).toBeNull()
  expect(normalizeRealtimeEvent('[1,2]')).toBeNull()
  expect(normalizeRealtimeEvent('"a string"')).toBeNull()
})

it('ignores an event whose type is not a string', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({ type: 7 }))).toBeNull()
  expect(normalizeRealtimeEvent(JSON.stringify({ type: null }))).toBeNull()
})

// A message dropped because the socket is not open strands whatever was being
// sent. The worst case is a tool result: the model holds the floor waiting for a
// function output that never arrives and the prospect hears dead air. Silent was
// the wrong behaviour; the drop has to be observable.

const OPEN = 1
const CLOSED = 3

it('sends an event when the socket is open', () => {
  const sent: string[] = []
  const ok = sendJson({ readyState: OPEN, send: (d) => sent.push(d) }, { type: 'response.create' })
  expect(ok).toBe(true)
  expect(sent).toEqual(['{"type":"response.create"}'])
})

it('reports and logs a drop when the socket is not open', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const sent: string[] = []
  const ok = sendJson({ readyState: CLOSED, send: (d) => sent.push(d) },
    { type: 'conversation.item.create' })
  expect(ok).toBe(false)
  expect(sent).toEqual([])
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('conversation.item.create'))
  warn.mockRestore()
})
