import { getCall, turnsSince, type CallRow } from '@/lib/db'
import type { CallSnapshot } from '@/lib/call-state'

export const dynamic = 'force-dynamic'

const POLL_MS = 700
/** A cold call that runs past this is past the backend's own 300 s ceiling. */
const MAX_MS = 6 * 60 * 1000

const BACKEND = process.env.BACKEND_URL ?? 'http://127.0.0.1:8080'

interface LiveCounters {
  agentMs: number
  prospectMs: number
  agentInterruptions: number
}

/**
 * Mid-call speaking time lives in the call server's memory, not in Postgres —
 * `call_scores` is written once at teardown. Without this the talk band would
 * sit blank for the whole call and only fill in after hangup, which is exactly
 * when the operator no longer needs it.
 *
 * Returns null when the call is not live there, or the endpoint is absent; the
 * caller then falls back to whatever the database holds.
 */
async function liveCounters(callId: string): Promise<LiveCounters | null> {
  try {
    const res = await fetch(`${BACKEND}/calls/${callId}/stats`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(500),
    })
    if (!res.ok) return null
    const body = await res.json()
    if (typeof body?.agentMs !== 'number' || typeof body?.prospectMs !== 'number') return null
    return {
      agentMs: body.agentMs,
      prospectMs: body.prospectMs,
      agentInterruptions: typeof body.agentInterruptions === 'number' ? body.agentInterruptions : 0,
    }
  } catch {
    return null
  }
}

function snapshot(row: CallRow, counters: LiveCounters | null): CallSnapshot {
  return {
    id: row.id,
    leadName: row.lead_name,
    leadCompany: row.lead_company,
    leadPhone: row.lead_phone,
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    durationS: row.duration_s,
    disposition: row.disposition,
    voicemailDropped: row.voicemail_dropped,
    amdVerdict: row.amd_verdict,
    // Live counters win while the call is up; the persisted scores are
    // authoritative once it has ended.
    agentMs: counters?.agentMs ?? row.agent_ms ?? 0,
    prospectMs: counters?.prospectMs ?? row.prospect_ms ?? 0,
    agentInterruptions: counters?.agentInterruptions ?? row.agent_interruptions ?? 0,
    meetingAt: row.meeting_at ? new Date(row.meeting_at).toISOString() : null,
  }
}

/**
 * Live feed for one call.
 *
 * The backend writes transcript turns to Postgres as they arrive, so the
 * console can tail the table over plain SSE instead of opening a second
 * WebSocket. Turns are sent incrementally by id; the call row is re-read each
 * tick because scores only land at teardown.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let lastTurnId = '0'
      let closed = false
      const startedAt = Date.now()

      const send = (payload: unknown) => {
        if (closed) return
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      }

      const finish = () => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          /* already closed by the client disconnecting */
        }
      }

      while (!closed) {
        let row: CallRow | null
        try {
          row = await getCall(id)
        } catch {
          send({ call: null, turns: [], done: true })
          finish()
          return
        }

        if (!row) {
          send({ call: null, turns: [], done: true })
          finish()
          return
        }

        let fresh: { id: string; role: 'agent' | 'prospect'; text: string }[] = []
        try {
          fresh = await turnsSince(id, lastTurnId)
        } catch {
          fresh = []
        }
        if (fresh.length > 0) lastTurnId = fresh[fresh.length - 1]!.id

        const done = row.ended_at !== null || Date.now() - startedAt > MAX_MS
        const counters = done ? null : await liveCounters(id)
        send({ call: snapshot(row, counters), turns: fresh, done })

        if (done) {
          finish()
          return
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
