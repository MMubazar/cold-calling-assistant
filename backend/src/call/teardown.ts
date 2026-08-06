import type { Db } from '../lib/db.js'
import type { CallResult } from './session.js'

/** Single write at call end — never per frame (spec §9). Failures are logged, never thrown. */
export async function persistCallResult(
  db: Db,
  callId: string,
  result: CallResult,
  startedAtMs: number,
): Promise<void> {
  try {
    await db.finalizeCall(callId, {
      disposition: result.disposition,
      durationS: Math.round((Date.now() - startedAtMs) / 1000),
      voicemailDropped: result.voicemailDropped,
      amdVerdict: result.amdVerdict,
      audio: result.audio,
    })
  } catch (err) {
    console.error('[teardown] failed to persist call result', err)
  }
}
