import { Console } from '@/components/Console'
import { CallLog } from '@/components/CallLog'
import { activeCall, listLeads, recentCalls, turnsSince, type CallRow } from '@/lib/db'
import type { CallSnapshot } from '@/lib/call-state'

export const dynamic = 'force-dynamic'

const AGENT_NAME = 'Sara'
const COMPANY_NAME = 'Northwind'

function toSnapshot(row: CallRow): CallSnapshot {
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
    agentMs: row.agent_ms ?? 0,
    prospectMs: row.prospect_ms ?? 0,
    agentInterruptions: row.agent_interruptions ?? 0,
    meetingAt: row.meeting_at ? new Date(row.meeting_at).toISOString() : null,
  }
}

export default async function ConsolePage() {
  let leads: Awaited<ReturnType<typeof listLeads>> = []
  let log: CallRow[] = []
  let live: CallRow | null = null
  let offline = false

  try {
    ;[leads, log, live] = await Promise.all([listLeads(), recentCalls(), activeCall()])
  } catch {
    offline = true
  }

  const turns = live ? await turnsSince(live.id, '0') : []

  return (
    <main className="shell">
      <header className="masthead">
        <span className="masthead-mark">Cold Line</span>
        <span className="masthead-rule" aria-hidden="true" />
        <div className="masthead-meta">
          <span className="masthead-field">
            <span className="eyebrow">Agent</span>
            <span>{AGENT_NAME}</span>
          </span>
          <span className="masthead-field">
            <span className="eyebrow">Calling for</span>
            <span>{COMPANY_NAME}</span>
          </span>
        </div>
      </header>

      {offline ? (
        <p className="notice">
          Cannot reach the database. Start it with{' '}
          <span className="mono">
            pg_ctl -D ~/.coldcall-pg -o &quot;-p 5470 -k /tmp&quot; start
          </span>{' '}
          and reload.
        </p>
      ) : (
        <>
          <Console
            initialLeads={leads}
            initialCall={live ? toSnapshot(live) : null}
            initialTurns={turns.map((t) => ({ id: t.id, role: t.role, text: t.text }))}
          />
          <CallLog calls={log} />
        </>
      )}
    </main>
  )
}
