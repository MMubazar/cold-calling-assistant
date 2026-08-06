import type { CallRow } from '@/lib/db'
import {
  PITCHING,
  dispositionClass,
  dispositionLabel,
  formatClock,
  formatTime,
  talkShare,
} from '@/lib/call-state'

/**
 * The log answers one question across calls rather than within one: is the
 * playbook working? Ratio and interruptions repeat the live panel's colour
 * coding so a scan down the column reads the same way as the band above.
 */
export function CallLog({ calls }: { calls: CallRow[] }) {
  return (
    <section className="panel log">
      <div className="panel-head">
        <span className="eyebrow">Call log</span>
        <span className="panel-count">last {calls.length}</span>
      </div>

      {calls.length === 0 ? (
        <p className="log-empty">
          No calls yet. The first one you place will be logged here with its outcome.
        </p>
      ) : (
        <table className="log-table">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Outcome</th>
              <th className="log-hide-sm">Talk split</th>
              <th style={{ textAlign: 'right' }}>Ratio</th>
              <th style={{ textAlign: 'right' }} className="log-hide-sm">
                Cut-ins
              </th>
              <th style={{ textAlign: 'right' }}>Length</th>
              <th style={{ textAlign: 'right' }} className="log-hide-sm">
                Started
              </th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => {
              const agentMs = call.agent_ms ?? 0
              const prospectMs = call.prospect_ms ?? 0
              const share = talkShare(agentMs, prospectMs)
              const spoke = agentMs + prospectMs > 0
              const over = share > PITCHING

              return (
                <tr key={call.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{call.lead_name}</div>
                    <div className="lead-phone">{call.lead_phone}</div>
                  </td>
                  <td>
                    <span className={`chip ${dispositionClass(call.disposition)}`}>
                      {dispositionLabel(call.disposition)}
                    </span>
                  </td>
                  <td className="log-hide-sm">
                    {spoke ? (
                      <div
                        className="minibar"
                        role="img"
                        aria-label={`Agent ${Math.round(share * 100)} percent`}
                      >
                        <div
                          className={`minibar-agent${over ? ' minibar-agent-over' : ''}`}
                          style={{ width: `${share * 100}%` }}
                        />
                        <div className="minibar-prospect" style={{ width: `${(1 - share) * 100}%` }} />
                      </div>
                    ) : (
                      <span className="lead-phone">no speech</span>
                    )}
                  </td>
                  <td className="log-num" style={over ? { color: 'var(--alert)' } : undefined}>
                    {spoke ? `${Math.round(share * 100)}%` : String.fromCharCode(0x2014)}
                  </td>
                  <td
                    className="log-num log-hide-sm"
                    style={
                      (call.agent_interruptions ?? 0) > 0 ? { color: 'var(--alert)' } : undefined
                    }
                  >
                    {call.agent_interruptions ?? String.fromCharCode(0x2014)}
                  </td>
                  <td className="log-num">
                    {call.duration_s === null ? 'running' : formatClock(call.duration_s)}
                  </td>
                  <td className="log-num log-hide-sm">{formatTime(call.started_at)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
