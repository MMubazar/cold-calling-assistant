import { readFile } from 'node:fs/promises'
import { ULAW_FRAME_BYTES } from './audio.js'

const BIAS = 0x84
const CLIP = 32635

/** Standard G.711 μ-law encoder. One byte out per 16-bit sample in. */
export function encodePcm16ToUlaw(samples: Int16Array): Buffer {
  const out = Buffer.alloc(samples.length)
  for (let i = 0; i < samples.length; i++) {
    let sample = samples[i]!
    const sign = sample < 0 ? 0x80 : 0x00
    if (sample < 0) sample = -sample
    if (sample > CLIP) sample = CLIP
    sample += BIAS

    let exponent = 7
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--

    const mantissa = (sample >> (exponent + 3)) & 0x0f
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff
  }
  return out
}

/** Base64 frames of exactly 20 ms each. A trailing partial frame is padded with μ-law silence. */
export function chunkUlawToFrames(buf: Buffer): string[] {
  const frames: string[] = []
  for (let offset = 0; offset < buf.length; offset += ULAW_FRAME_BYTES) {
    const slice = buf.subarray(offset, offset + ULAW_FRAME_BYTES)
    if (slice.length === ULAW_FRAME_BYTES) {
      frames.push(slice.toString('base64'))
    } else {
      const padded = Buffer.alloc(ULAW_FRAME_BYTES, 0xff)
      slice.copy(padded)
      frames.push(padded.toString('base64'))
    }
  }
  return frames
}

/** Decode one μ-law byte back to a 16-bit sample. Inverse of the encoder above. */
export function decodeUlawByte(byte: number): number {
  const u = ~byte & 0xff
  const sign = u & 0x80
  const exponent = (u >> 4) & 0x07
  const mantissa = u & 0x0f
  const sample = (((mantissa << 3) + BIAS) << exponent) - BIAS
  return sign ? -sample : sample
}

/**
 * Mean absolute amplitude of one base64 μ-law frame, 0–32635.
 *
 * This exists because Twilio streams inbound audio continuously whether or not
 * anyone is speaking (see media/audio.ts). During a voicemail drop the model
 * session is closed, so there is no VAD to consult — "a frame arrived" cannot
 * stand in for "a human spoke", and energy is the only signal left.
 */
export function frameEnergy(payloadB64: string): number {
  const buf = Buffer.from(payloadB64, 'base64')
  if (buf.length === 0) return 0
  let total = 0
  for (const byte of buf) total += Math.abs(decodeUlawByte(byte))
  return total / buf.length
}

/**
 * Mean amplitude above which a frame counts as sound rather than line noise.
 * Tune against real calls; the runbook says how.
 */
export const SPEECH_ENERGY_THRESHOLD = 500

/** Consecutive loud frames required before believing a human is there: 200 ms. */
export const SPEECH_FRAMES_TO_ABORT = 10

export async function loadVoicemailFrames(path: string): Promise<string[]> {
  try {
    return chunkUlawToFrames(await readFile(path))
  } catch (err) {
    console.error(`[voicemail] could not read ${path}; voicemail drop disabled`, err)
    return []
  }
}
