export const FRAME_MS = 20
export const ULAW_FRAME_BYTES = 160

export function framesToMs(frames: number): number {
  return frames * FRAME_MS
}

export function talkRatio(agentMs: number, prospectMs: number): number {
  const total = agentMs + prospectMs
  return total === 0 ? 0 : agentMs / total
}

export interface AudioSnapshot {
  agentMs: number
  prospectMs: number
  talkRatio: number
  agentInterruptions: number
}

export class AudioAccounting {
  private prospectFrames = 0
  private agentFrames = 0
  private interruptions = 0
  private prospectSpeaking = false

  /** Counted only while the model reports prospect speech; Twilio streams silence continuously. */
  noteInboundFrame(): void {
    if (this.prospectSpeaking) this.prospectFrames += 1
  }

  noteOutboundFrames(count: number): void {
    this.agentFrames += count
  }

  /**
   * Remove frames that were sent but discarded before playback (barge-in).
   *
   * The model streams faster than the line plays, so a `clear` to Twilio throws
   * away audio the prospect never heard. Counting it as agent speech inflates
   * the talk ratio — the one number this system exists to produce.
   */
  discardOutboundFrames(count: number): void {
    this.agentFrames = Math.max(0, this.agentFrames - count)
  }

  noteProspectSpeechStart(): void {
    this.prospectSpeaking = true
  }

  noteProspectSpeechStop(): void {
    this.prospectSpeaking = false
  }

  noteAgentAudioStart(): void {
    if (this.prospectSpeaking) this.interruptions += 1
  }

  snapshot(): AudioSnapshot {
    const agentMs = framesToMs(this.agentFrames)
    const prospectMs = framesToMs(this.prospectFrames)
    return { agentMs, prospectMs, talkRatio: talkRatio(agentMs, prospectMs), agentInterruptions: this.interruptions }
  }
}
