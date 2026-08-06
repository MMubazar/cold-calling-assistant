import { parseTwilioMessage, mediaMessage, clearMessage } from '../media/twilio-frames.js'
import { AudioAccounting, type AudioSnapshot, ULAW_FRAME_BYTES } from '../media/audio.js'
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
        // Task 10 owns real voicemail-abort handling; for now this mode is never entered.
        if (this.mode === 'voicemail') return
        this.opts.realtime.sendAudio(msg.payload)
        return
      case 'mark':
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
