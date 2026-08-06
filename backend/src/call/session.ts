import { parseTwilioMessage, mediaMessage, clearMessage, markMessage } from '../media/twilio-frames.js'
import { AudioAccounting, type AudioSnapshot, ULAW_FRAME_BYTES } from '../media/audio.js'
import { frameEnergy, SPEECH_ENERGY_THRESHOLD, SPEECH_FRAMES_TO_ABORT } from '../media/ulaw.js'
import { handleToolCall } from '../agent/tool-handlers.js'
import type { RealtimeClient, RealtimeEvent } from '../agent/realtime.js'
import type { Db, Slot } from '../lib/db.js'

export interface Transport {
  send(raw: string): void
  close(): void
  onMessage(cb: (raw: string) => void): void
  onClose(cb: () => void): void
}

export interface CallSessionOptions {
  transport: Transport
  realtime: RealtimeClient
  db: Db
  callId: string
  leadId: string
  slots: Slot[]
  /** Base64 μ-law frames of the recorded voicemail message (Task 10). */
  voicemailFrames: string[]
}

export interface CallResult {
  disposition: string
  audio: AudioSnapshot
  voicemailDropped: boolean
  amdVerdict: string | null
}

/** Default until something better is proven; a call that connects and ends unremarkably is a failure to advance. */
const DEFAULT_DISPOSITION = 'failed'

export class CallSession {
  private readonly opts: CallSessionOptions
  private readonly audio = new AudioAccounting()
  private readonly pending: Promise<unknown>[] = []
  private readonly finishedHandlers: (() => void)[] = []

  private streamSid: string | null = null
  private started = false
  private finished = false
  private agentSpeaking = false
  // Prospect speech state lives in AudioAccounting, which is what consumes it.
  // Duplicating it here would be a second source of truth for the same fact.
  private disposition = DEFAULT_DISPOSITION
  private voicemailDropped = false
  private amdVerdict: string | null = null
  private mode: 'conversation' | 'voicemail' = 'conversation'
  /** Consecutive above-threshold inbound frames while playing a voicemail. */
  private loudFrames = 0

  constructor(opts: CallSessionOptions) {
    this.opts = opts
    opts.transport.onMessage((raw) => this.handleTwilioMessage(raw))
    opts.transport.onClose(() => this.finish())
    opts.realtime.on((e) => this.handleRealtimeEvent(e))
  }

  handleTwilioMessage(raw: string): void {
    const msg = parseTwilioMessage(raw)
    if (msg === null) return

    switch (msg.event) {
      case 'start':
        this.streamSid = msg.streamSid
        this.started = true
        return
      case 'media':
        if (!this.started) return
        this.audio.noteInboundFrame()
        if (this.mode === 'voicemail') {
          // Twilio streams inbound audio continuously whether or not anyone is
          // speaking, and the model session (our usual VAD) is closed during a
          // drop. Sustained energy, not mere frame arrival, is the only signal
          // left that a human is actually on the line.
          if (frameEnergy(msg.payload) >= SPEECH_ENERGY_THRESHOLD) {
            this.loudFrames += 1
            if (this.loudFrames >= SPEECH_FRAMES_TO_ABORT) this.abortVoicemailDrop()
          } else {
            this.loudFrames = 0 // a gap resets it; only sustained sound counts
          }
          return
        }
        this.opts.realtime.sendAudio(msg.payload)
        return
      case 'mark':
        // Guard on the mode: a mark already in flight when an abort fires would
        // otherwise hang up on the human the abort just decided to keep.
        if (msg.name === 'voicemail-complete' && this.mode === 'voicemail') {
          this.end('voicemail')
        }
        return
      case 'stop':
        this.finish()
        return
      case 'connected':
        return
    }
  }

  private handleRealtimeEvent(e: RealtimeEvent): void {
    if (this.mode === 'voicemail') return

    switch (e.kind) {
      case 'audio':
        this.sendAgentAudio(e.payload)
        return

      case 'prospect_speech_started':
        this.audio.noteProspectSpeechStart()
        // Barge-in: flush what Twilio has queued, then stop the model mid-response.
        if (this.agentSpeaking) {
          // Cancelling the model does not depend on having a stream; sending to
          // Twilio does.
          if (this.streamSid !== null) this.sendToTwilio(clearMessage(this.streamSid))
          this.opts.realtime.cancelResponse()
          this.agentSpeaking = false
        }
        return

      case 'prospect_speech_stopped':
        this.audio.noteProspectSpeechStop()
        return

      case 'response_done':
        this.agentSpeaking = false
        return

      case 'transcript':
        if (e.text.trim().length > 0) {
          this.track(this.opts.db.insertTranscriptTurn(this.opts.callId, e.role, e.text.trim()))
        }
        return

      case 'tool_call':
        this.track(this.runTool(e.toolCallId, e.name, e.args))
        return

      case 'error':
        console.error('[session] realtime error', e.message)
        // Do NOT set this.disposition here. end()'s guard exists to stop a
        // default close from clobbering a real outcome; pre-setting the field
        // defeats it, and a call that booked a meeting would persist as failed.
        this.end('failed')
        return

      case 'closed':
        this.finish()
        return
    }
  }

  private sendAgentAudio(payloadB64: string): void {
    // Symmetric to the inbound guard in handleTwilioMessage. Without a streamSid
    // there is no stream to route this to and Twilio discards the frame in
    // silence, so drop it here rather than pretend it was delivered.
    if (!this.started || this.streamSid === null) return

    const bytes = Buffer.from(payloadB64, 'base64').length
    if (bytes === 0) return // an empty delta is not 20 ms of speech

    if (!this.agentSpeaking) {
      this.agentSpeaking = true
      this.audio.noteAgentAudioStart()
    }
    this.audio.noteOutboundFrames(Math.ceil(bytes / ULAW_FRAME_BYTES))
    this.sendToTwilio(mediaMessage(this.streamSid, payloadB64))
  }

  /**
   * Async AMD verdict (spec §7). Arrives after the stream is already open, which is why
   * async detection is used — synchronous detection would delay every human-answered call
   * by 2–4 s and blow the latency budget in spec §5.
   */
  applyAmdVerdict(verdict: string): void {
    if (this.finished) return
    this.amdVerdict = verdict
    if (!verdict.startsWith('machine')) return

    this.mode = 'voicemail'
    this.loudFrames = 0
    this.opts.realtime.close()

    if (this.agentSpeaking) {
      if (this.streamSid !== null) this.sendToTwilio(clearMessage(this.streamSid))
      this.agentSpeaking = false
    }

    // Symmetric to the guards in sendAgentAudio/handleRealtimeEvent's barge-in path: a
    // frame with no stream to route to is silently dropped by Twilio, so treat "no
    // stream" the same as "no audio configured" rather than sending into the void.
    if (this.streamSid === null) {
      console.warn('[voicemail] no active stream; ending call without playing the message')
      this.end('voicemail')
      return
    }

    if (this.opts.voicemailFrames.length === 0) {
      console.warn('[voicemail] no audio configured; ending call without a message')
      this.end('voicemail')
      return
    }

    this.voicemailDropped = true
    for (const frame of this.opts.voicemailFrames) {
      this.sendToTwilio(mediaMessage(this.streamSid, frame))
    }
    this.sendMark('voicemail-complete')
  }

  /**
   * A human speaking during voicemail playback is unambiguous evidence that machine
   * detection misfired (spec §7). Abort, keep the call alive, and record the false positive
   * so it is countable rather than invisible.
   */
  private abortVoicemailDrop(): void {
    console.warn('[voicemail] speech during playback; treating AMD verdict as a false positive')
    this.mode = 'conversation'
    this.voicemailDropped = false
    this.amdVerdict = `${this.amdVerdict ?? 'machine'}_false_positive`
    if (this.streamSid !== null) this.sendToTwilio(clearMessage(this.streamSid))
  }

  /** Guarded like sendAgentAudio: without a stream there is nowhere to route this. */
  private sendMark(name: string): void {
    if (this.streamSid === null) return
    this.sendToTwilio(markMessage(this.streamSid, name))
  }

  private async runTool(toolCallId: string, name: string, args: Record<string, unknown>): Promise<void> {
    const res = await handleToolCall(name, args, {
      callId: this.opts.callId,
      leadId: this.opts.leadId,
      slots: this.opts.slots,
      db: this.opts.db,
    })

    if (name === 'book_meeting' && (res.output as any)?.booked === true) {
      this.disposition = 'booked'
    }

    this.opts.realtime.sendToolResult(toolCallId, res.output)

    if (res.endCall) {
      if (this.disposition === DEFAULT_DISPOSITION) this.disposition = 'not_interested'
      this.end(this.disposition)
    }
  }

  protected sendToTwilio(raw: string): void {
    this.opts.transport.send(raw)
  }

  private track(p: Promise<unknown>): void {
    this.pending.push(p.catch((err) => console.error('[session] background task failed', err)))
  }

  /** Resolves once all in-flight background work (tool calls, transcript writes) has settled. */
  async settled(): Promise<void> {
    await Promise.all(this.pending)
  }

  end(disposition: string): void {
    if (disposition !== DEFAULT_DISPOSITION || this.disposition === DEFAULT_DISPOSITION) {
      this.disposition = disposition
    }
    this.opts.realtime.close()
    this.opts.transport.close()
    this.finish()
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    this.finishedHandlers.forEach((h) => h())
  }

  onFinished(cb: () => void): void {
    this.finishedHandlers.push(cb)
  }

  result(): CallResult {
    return {
      disposition: this.disposition,
      audio: this.audio.snapshot(),
      voicemailDropped: this.voicemailDropped,
      amdVerdict: this.amdVerdict,
    }
  }
}
