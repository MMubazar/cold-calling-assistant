import { AudioAccounting, framesToMs, talkRatio, FRAME_MS, ULAW_FRAME_BYTES } from '../src/media/audio.js'

it('pins the frame constants', () => {
  expect(FRAME_MS).toBe(20)
  expect(ULAW_FRAME_BYTES).toBe(160)
})

it('converts frames to milliseconds', () => {
  expect(framesToMs(50)).toBe(1000)
})

it('computes talk ratio', () => {
  expect(talkRatio(3000, 7000)).toBeCloseTo(0.3)
})

it('reports a zero talk ratio when no one spoke, rather than dividing by zero', () => {
  expect(talkRatio(0, 0)).toBe(0)
})

it('ignores inbound frames while the prospect is silent', () => {
  const a = new AudioAccounting()
  for (let i = 0; i < 100; i++) a.noteInboundFrame()
  expect(a.snapshot().prospectMs).toBe(0)
})

it('counts inbound frames only between prospect speech start and stop', () => {
  const a = new AudioAccounting()
  a.noteInboundFrame()               // silence, ignored
  a.noteProspectSpeechStart()
  for (let i = 0; i < 25; i++) a.noteInboundFrame()   // 500 ms of speech
  a.noteProspectSpeechStop()
  for (let i = 0; i < 40; i++) a.noteInboundFrame()   // silence, ignored
  expect(a.snapshot().prospectMs).toBe(500)
})

it('counts every outbound frame as agent speech', () => {
  const a = new AudioAccounting()
  a.noteOutboundFrames(10)
  a.noteOutboundFrames(5)
  expect(a.snapshot().agentMs).toBe(300)
})

it('counts an interruption when the agent starts while the prospect is speaking', () => {
  const a = new AudioAccounting()
  a.noteProspectSpeechStart()
  a.noteAgentAudioStart()
  expect(a.snapshot().agentInterruptions).toBe(1)
})

it('does not count an interruption when the prospect has stopped', () => {
  const a = new AudioAccounting()
  a.noteProspectSpeechStart()
  a.noteProspectSpeechStop()
  a.noteAgentAudioStart()
  expect(a.snapshot().agentInterruptions).toBe(0)
})

it('counts one interruption per agent start, not per frame', () => {
  const a = new AudioAccounting()
  a.noteProspectSpeechStart()
  a.noteAgentAudioStart()
  a.noteOutboundFrames(30)
  a.noteAgentAudioStart()
  expect(a.snapshot().agentInterruptions).toBe(2)
})

it('tolerates a stop event with no matching start', () => {
  const a = new AudioAccounting()
  a.noteProspectSpeechStop()
  a.noteInboundFrame()
  expect(a.snapshot().prospectMs).toBe(0)
})

it('reports talk ratio in the snapshot', () => {
  const a = new AudioAccounting()
  a.noteProspectSpeechStart()
  for (let i = 0; i < 50; i++) a.noteInboundFrame()   // 1000 ms
  a.noteProspectSpeechStop()
  a.noteOutboundFrames(50)                            // 1000 ms
  expect(a.snapshot().talkRatio).toBeCloseTo(0.5)
})
