import { FRAME_MS } from './frames'

/**
 * Shared vocabulary between the log and the live panel. The console names
 * things the way an operator would say them out loud, not the way the
 * database stores them.
 */

export type Phase = 'ready' | 'ringing' | 'connected' | 'voicemail' | 'ended' | 'failed'

export interface CallSnapshot {
  id: string
  leadName: string
  leadCompany: string | null
  leadPhone: string
  startedAt: string
  endedAt: string | null
  durationS: number | null
  disposition: string | null
  voicemailDropped: boolean
  amdVerdict: string | null
  agentMs: number
  prospectMs: number
  agentInterruptions: number
  meetingAt: string | null
}

export function phaseOf(call: CallSnapshot | null): Phase {
  if (!call) return 'ready'
  if (call.disposition === 'failed') return 'failed'
  if (call.endedAt) return 'ended'
  if (call.voicemailDropped) return 'voicemail'
  // No audio counted yet means Twilio has not bridged the media stream.
  if (call.agentMs + call.prospectMs === 0) return 'ringing'
  return 'connected'
}

export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case 'ready':
      return 'ready'
    case 'ringing':
      return 'ringing'
    case 'connected':
      return 'connected'
    case 'voicemail':
      return 'leaving message'
    case 'ended':
      return 'ended'
    case 'failed':
      return 'dropped'
  }
}

export const LIVE_PHASES: Phase[] = ['ringing', 'connected', 'voicemail']

/** Disposition codes, as the operator reads them. */
export function dispositionLabel(disposition: string | null): string {
  if (!disposition) return 'in progress'
  return disposition.replace(/_/g, ' ')
}

export function dispositionClass(disposition: string | null): string {
  switch (disposition) {
    case 'booked':
      return 'chip-booked'
    case 'qualified_no_meeting':
    case 'callback':
      return 'chip-progress'
    case 'voicemail':
      return 'chip-machine'
    case 'failed':
      return 'chip-failed'
    case null:
      return 'chip-progress'
    default:
      return 'chip-dead'
  }
}

/** Agent share of speaking time, 0–1. Zero when nobody has spoken. */
export function talkShare(agentMs: number, prospectMs: number): number {
  const total = agentMs + prospectMs
  return total === 0 ? 0 : agentMs / total
}

/** The playbook target: the agent should hold 40–50 % of the line. */
export const TARGET_LOW = 0.4
export const TARGET_HIGH = 0.5
/** Past this the agent is pitching rather than discovering. */
export const PITCHING = 0.6

export function shareVerdict(agentMs: number, prospectMs: number): string {
  if (agentMs + prospectMs === 0) return 'no speech yet'
  const share = talkShare(agentMs, prospectMs)
  if (share > PITCHING) return 'pitching — agent is over 60 %'
  if (share < TARGET_LOW) return 'agent is listening more than target'
  if (share <= TARGET_HIGH) return 'on target'
  return 'agent slightly over target'
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const m = Math.floor(safe / 60)
  const s = safe % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** Frames are the unit this system actually measures in. Surface it. */
export function framesOf(ms: number): number {
  return Math.round(ms / FRAME_MS)
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function formatMeeting(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
