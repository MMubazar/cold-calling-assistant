import {
  encodePcm16ToUlaw,
  chunkUlawToFrames,
  decodeUlawByte,
  frameEnergy,
  SPEECH_ENERGY_THRESHOLD,
} from '../src/media/ulaw.js'
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

it('decodes a μ-law byte back to its original sample', () => {
  for (const sample of [0, 100, -100, 5000, -5000, 30000, -30000]) {
    const [byte] = encodePcm16ToUlaw(new Int16Array([sample]))
    const decoded = decodeUlawByte(byte!)
    // μ-law is lossy by design; 4 % of full scale is well inside its error band.
    expect(Math.abs(decoded - sample)).toBeLessThan(1300)
    expect(Math.sign(decoded)).toBe(Math.sign(sample))
  }
})

it('reports zero energy for a silent frame', () => {
  const silence = encodePcm16ToUlaw(new Int16Array(160)).toString('base64')
  expect(frameEnergy(silence)).toBeLessThan(SPEECH_ENERGY_THRESHOLD)
})

it('reports energy above the speech threshold for a loud frame', () => {
  const loud = new Int16Array(160)
  for (let i = 0; i < loud.length; i++) loud[i] = i % 2 === 0 ? 8000 : -8000
  expect(frameEnergy(encodePcm16ToUlaw(loud).toString('base64')))
    .toBeGreaterThan(SPEECH_ENERGY_THRESHOLD)
})

it('reports zero energy for an empty payload', () => {
  expect(frameEnergy('')).toBe(0)
})
