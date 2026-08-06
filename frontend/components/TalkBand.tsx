'use client'

import {
  PITCHING,
  formatCount,
  formatSeconds,
  framesOf,
  shareVerdict,
  talkShare,
} from '@/lib/call-state'

/**
 * The talk band.
 *
 * The one thing an operator must learn from a cold call is whether the agent
 * listened. Speaking time is counted in 20 ms media frames per party, so this
 * bar is the data model rendered directly rather than a chart drawn over it.
 * The bracket above marks the 40–50 % target; crossing 60 % flips the agent's
 * half to alert, because at that point the agent is pitching, not discovering.
 */
export function TalkBand({
  agentMs,
  prospectMs,
  interruptions,
}: {
  agentMs: number
  prospectMs: number
  interruptions: number
}) {
  const total = agentMs + prospectMs
  const share = talkShare(agentMs, prospectMs)
  const over = share > PITCHING
  const verdict = shareVerdict(agentMs, prospectMs)

  return (
    <section className="band" aria-label="Talk time">
      <div className="band-topline">
        <span className="eyebrow">Talk time</span>
        <span className={`band-verdict${over ? ' band-verdict-warn' : ''}`}>{verdict}</span>
      </div>

      <div className="band-gauge">
        <div className="band-target" aria-hidden="true" />
        <span className="band-target-label" aria-hidden="true">
          40–50 target
        </span>

        {total === 0 ? (
          <div className="band-empty">awaiting speech</div>
        ) : (
          <div
            className="band-bar"
            role="img"
            aria-label={`Agent spoke ${Math.round(share * 100)} percent of the time, prospect ${
              100 - Math.round(share * 100)
            } percent. ${verdict}.`}
          >
            <div
              className={`band-seg band-seg-agent${over ? ' band-seg-agent-over' : ''}`}
              style={{ width: `${share * 100}%` }}
            >
              {share > 0.14 && <span>agent {Math.round(share * 100)}%</span>}
            </div>
            <div className="band-seg band-seg-prospect" style={{ width: `${(1 - share) * 100}%` }}>
              {1 - share > 0.14 && <span>prospect {100 - Math.round(share * 100)}%</span>}
            </div>
          </div>
        )}
      </div>

      <div className="band-legend">
        <div className="band-stat">
          <span className="eyebrow">Agent</span>
          <span className="band-stat-value" style={{ color: 'var(--agent)' }}>
            {formatSeconds(agentMs)}
          </span>
        </div>
        <div className="band-stat">
          <span className="eyebrow">Prospect</span>
          <span className="band-stat-value" style={{ color: 'var(--prospect)' }}>
            {formatSeconds(prospectMs)}
          </span>
        </div>
        <div className="band-stat">
          <span className="eyebrow">Interruptions</span>
          <span className={`band-stat-value${interruptions > 0 ? ' band-stat-value-warn' : ''}`}>
            {interruptions}
          </span>
        </div>
        <div className="band-stat">
          <span className="eyebrow">Frames counted</span>
          <span className="band-stat-value" style={{ color: 'var(--ink-dim)' }}>
            {formatCount(framesOf(total))}
          </span>
        </div>
      </div>
    </section>
  )
}
