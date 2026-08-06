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

export async function loadVoicemailFrames(path: string): Promise<string[]> {
  try {
    return chunkUlawToFrames(await readFile(path))
  } catch (err) {
    console.error(`[voicemail] could not read ${path}; voicemail drop disabled`, err)
    return []
  }
}
