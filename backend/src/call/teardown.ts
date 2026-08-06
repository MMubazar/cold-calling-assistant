import type { Db } from '../lib/db.js'
import type { CallResult } from './session.js'

/**
 * Single write at call end — never per frame (spec §9). Failures are logged, never thrown.
 *
 * The duration is computed inside the transaction from `calls.started_at`, so
 * this needs no start timestamp of its own; measuring from the media stream's
 * start excluded ring time and made the console's clock jump backwards at hangup.
 */
export async function persistCallResult(
  db: Db,
  callId: string,
  result: CallResult,
): Promise<void> {
  try {
    await db.finalizeCall(callId, {
      disposition: result.disposition,
      voicemailDropped: result.voicemailDropped,
      amdVerdict: result.amdVerdict,
      audio: result.audio,
    })
  } catch (err) {
    console.error('[teardown] failed to persist call result', err)
  }
}

/**
 * Closes out a call whose media stream never bridged (no answer, busy, declined,
 * or a socket that died during setup). Failures are logged, never thrown — for
 * the same reason as above: a teardown must not take the server with it.
 */
export async function persistUnbridgedCall(
  db: Db,
  callId: string,
  disposition: string,
): Promise<void> {
  try {
    await db.finalizeUnbridgedCall(callId, disposition)
  } catch (err) {
    console.error('[teardown] failed to finalize an unbridged call', err)
  }
}

/**
 * Twilio's terminal `CallStatus` for a call that never bridged, mapped to a
 * disposition. `no_answer` is a required outcome in the design spec and was
 * previously written by nothing at all.
 */
export function dispositionForCallStatus(callStatus: string): string {
  return callStatus === 'failed' ? 'failed' : 'no_answer'
}
