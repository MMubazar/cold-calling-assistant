'use client'

import { useEffect, useRef } from 'react'
import { TalkBand } from './TalkBand'
import {
  type CallSnapshot,
  type Phase,
  formatClock,
  formatMeeting,
  phaseLabel,
  phaseOf,
  LIVE_PHASES,
} from '@/lib/call-state'

export interface Turn {
  id: string
  role: 'agent' | 'prospect'
  text: string
}

/**
 * The live panel. When nothing is running it is an invitation, not an empty
 * box; when a call is up it is the reason the operator has this page open.
 */
export function LivePanel({
  call,
  turns,
  elapsed,
  notice,
}: {
  call: CallSnapshot | null
  turns: Turn[]
  elapsed: number
  notice: string | null
}) {
  const phase = phaseOf(call)
  const isLive = LIVE_PHASES.includes(phase)

  return (
    <div className="live">
      <div className="live-head">
        <div className="live-who">
          <span className="eyebrow">Live call</span>
          {call ? (
            <>
              <span className="live-who-name">{call.leadName}</span>
              <span className="live-who-meta">
                {call.leadCompany ? `${call.leadCompany} · ` : ''}
                {call.leadPhone}
              </span>
            </>
          ) : (
            <>
              <span className="live-who-name">Nobody on the line</span>
              <span className="live-who-meta">
                {String.fromCharCode(0x2014)} {String.fromCharCode(0x2014)}
              </span>
            </>
          )}
        </div>

        <div>
          <div className={`clock${call ? '' : ' clock-idle'}`}>
            {formatClock(call ? elapsed : 0)}
          </div>
          <StatusFlag phase={phase} live={isLive} />
        </div>
      </div>

      {notice && <p className="notice">{notice}</p>}

      {call?.amdVerdict?.includes('false_positive') && (
        <p className="notice notice-quiet">
          Machine detection misfired and the voicemail drop was aborted. The line is still open,
          but the agent has stopped speaking — hang up and redial.
        </p>
      )}

      {call ? (
        <>
          <TalkBand
            agentMs={call.agentMs}
            prospectMs={call.prospectMs}
            interruptions={call.agentInterruptions}
          />
          {call.meetingAt && (
            <p className="notice notice-quiet">
              Meeting booked for {formatMeeting(call.meetingAt)}.
            </p>
          )}
          <Tape turns={turns} phase={phase} />
        </>
      ) : (
        <div className="vacant">
          <div className="vacant-lines" aria-hidden="true">
            <span />
            <span />
          </div>
          <p className="vacant-title">No call running</p>
          <p className="vacant-hint">
            Pick a lead and press call. The transcript appears here as the agent speaks.
          </p>
        </div>
      )}
    </div>
  )
}

function StatusFlag({ phase, live }: { phase: Phase; live: boolean }) {
  return (
    <div className={`status status-${phase}${live ? ' status-live' : ''}`}>
      <span className="status-dot" aria-hidden="true" />
      <span>{phaseLabel(phase)}</span>
    </div>
  )
}

function Tape({ turns, phase }: { turns: Turn[]; phase: Phase }) {
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns.length])

  return (
    <div className="tape">
      <div className="tape-head">
        <span className="eyebrow">Transcript</span>
      </div>

      {turns.length === 0 ? (
        <p className="vacant-hint" style={{ paddingTop: 8 }}>
          {phase === 'ringing'
            ? 'Ringing. Nothing said yet.'
            : phase === 'voicemail'
              ? 'Playing the recorded message. Voicemail is not transcribed.'
              : 'Waiting for the first turn.'}
        </p>
      ) : (
        turns.map((turn) => (
          <div key={turn.id} className={`turn turn-${turn.role}`}>
            <span className="turn-role">{turn.role}</span>
            <span className="turn-text">{turn.text}</span>
          </div>
        ))
      )}
      <div ref={end} />
    </div>
  )
}
