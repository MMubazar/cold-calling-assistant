import { encodePcm16ToUlaw, chunkUlawToFrames } from '../src/media/ulaw.js'
import { ULAW_FRAME_BYTES } from '../src/media/audio.js'

it('encodes one μ-law byte per PCM sample', () => {
  expect(encodePcm16ToUlaw(new Int16Array(320)).length).toBe(320)
})

it('encodes silence to the μ-law silence byte', () => {
  expect(encodePcm16ToUlaw(new Int16Array([0]))[0]).toBe(0xff)
})

it('encodes positive and negative peaks to different bytes', () => {
  const [hi] = encodePcm16ToUlaw(new Int16Array([32000]))
  const [lo] = encodePcm16ToUlaw(new Int16Array([-32000]))
  expect(hi).not.toBe(lo)
})

it('splits a buffer into 160-byte frames', () => {
  const frames = chunkUlawToFrames(Buffer.alloc(ULAW_FRAME_BYTES * 3))
  expect(frames).toHaveLength(3)
  expect(Buffer.from(frames[0]!, 'base64').length).toBe(ULAW_FRAME_BYTES)
})

it('pads a trailing partial frame to a full frame', () => {
  const frames = chunkUlawToFrames(Buffer.alloc(ULAW_FRAME_BYTES + 40))
  expect(frames).toHaveLength(2)
  expect(Buffer.from(frames[1]!, 'base64').length).toBe(ULAW_FRAME_BYTES)
})

it('returns no frames for an empty buffer', () => {
  expect(chunkUlawToFrames(Buffer.alloc(0))).toEqual([])
})
