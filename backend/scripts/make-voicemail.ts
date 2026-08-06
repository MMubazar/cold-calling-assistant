/**
 * Build assets/voicemail.ulaw.
 *
 *   npx tsx scripts/make-voicemail.ts --synth
 *       Generates a 3-second 440 Hz tone. Proves the pipeline end to end
 *       without needing a recording. Use for the first test call.
 *
 *   npx tsx scripts/make-voicemail.ts recording.wav
 *       Converts a 16-bit mono 8 kHz PCM WAV. If your recording is any other
 *       format, convert it first:
 *         ffmpeg -i recording.m4a -ar 8000 -ac 1 -c:a pcm_s16le recording.wav
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { encodePcm16ToUlaw } from '../src/media/ulaw.js'

const OUT = 'assets/voicemail.ulaw'
const SAMPLE_RATE = 8000

function synthTone(seconds: number): Int16Array {
  const samples = new Int16Array(SAMPLE_RATE * seconds)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 8000)
  }
  return samples
}

function parseWav(buf: Buffer): Int16Array {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }
  let offset = 12
  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      const channels = buf.readUInt16LE(offset + 10)
      const rate = buf.readUInt32LE(offset + 12)
      const bits = buf.readUInt16LE(offset + 22)
      if (channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) {
        throw new Error(
          `Need 16-bit mono 8000 Hz, got ${bits}-bit ${channels}ch ${rate}Hz. ` +
          'Convert with: ffmpeg -i in.wav -ar 8000 -ac 1 -c:a pcm_s16le out.wav',
        )
      }
    }
    if (id === 'data') {
      const pcm = buf.subarray(offset + 8, offset + 8 + size)
      return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('No data chunk found')
}

const arg = process.argv[2]
const samples = arg === '--synth' || arg === undefined
  ? synthTone(3)
  : parseWav(await readFile(arg))

await mkdir('assets', { recursive: true })
await writeFile(OUT, encodePcm16ToUlaw(samples))
console.log(`wrote ${OUT} (${(samples.length / SAMPLE_RATE).toFixed(1)}s)`)
