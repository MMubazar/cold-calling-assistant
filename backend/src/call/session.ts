import { parseTwilioMessage, mediaMessage, clearMessage, markMessage } from '../media/twilio-frames.js'
import { AudioAccounting, type AudioSnapshot, ULAW_FRAME_BYTES } from '../media/audio.js'
import { frameEnergy, SPEECH_ENERGY_THRESHOLD, SPEECH_FRAMES_TO_ABORT } from '../media/ulaw.js'
import { handleToolCall, TOOL_FAILED_OUTPUT, type ToolResult } from '../agent/tool-handlers.js'
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
  /**
   * Frames sent to Twilio for the response currently in flight. The model
   * streams faster than the line plays, so a `clear` discards some of these
   * before the prospect hears them; this is how many to take back off the
   * agent's talk time. Reset when a response completes.
   */
  private framesThisResponse = 0

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
        // Counted below the voicemail branch, not above it: during a drop the
        // model session (and with it the VAD that flips prospect speech off) is
        // closed, so a frame arriving then is a machine's greeting, never
        // measurable prospect speech.
        this.audio.noteInboundFrame()
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
          // The cleared frames were counted at send time but never played, so
          // take them back off the agent's talk time in the same breath.
          this.discardQueuedAgentAudio()
          this.opts.realtime.cancelResponse()
          this.agentSpeaking = false
        }
        return

      case 'prospect_speech_stopped':
        this.audio.noteProspectSpeechStop()
        return

      case 'response_done':
        this.agentSpeaking = false
        // Everything for this response has been handed over; nothing left to
        // take back if a later response is interrupted.
        this.framesThisResponse = 0
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
        // Log and carry on. The Realtime API emits `error` for recoverable
        // conditions — a transient server_error, an invalid_request_error on one
        // event, a response.cancel with nothing to cancel — so hanging up here
        // terminated healthy calls on a live prospect. `closed` is the only
        // terminal signal, and DEFAULT_DISPOSITION already makes a genuine
        // session drop persist as 'failed' without any special handling.
        console.error('[session] realtime error (continuing)', e.message)
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
    const frames = Math.ceil(bytes / ULAW_FRAME_BYTES)
    this.audio.noteOutboundFrames(frames)
    this.framesThisResponse += frames
    this.sendToTwilio(mediaMessage(this.streamSid, payloadB64))
  }

  /**
   * Un-count the frames sent for the response in flight.
   *
   * Called wherever a `clear` is sent to Twilio: `clear` drops the queued
   * playback buffer, so those frames were credited to the agent at send time and
   * never reached the prospect's ear.
   */
  private discardQueuedAgentAudio(): void {
    this.audio.discardOutboundFrames(this.framesThisResponse)
    this.framesThisResponse = 0
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
    // Closing the model session takes the VAD with it, so no speech_stopped can
    // ever arrive. Left latched, every remaining 20 ms frame of the call would be
    // credited to the prospect at 50 frames a second and the talk ratio would
    // collapse to zero — worst on an AMD false positive, where the human really
    // was mid-greeting.
    this.audio.noteProspectSpeechStop()

    if (this.agentSpeaking) {
      if (this.streamSid !== null) this.sendToTwilio(clearMessage(this.streamSid))
      this.discardQueuedAgentAudio()
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
    let res: ToolResult
    try {
      res = await handleToolCall(name, args, {
        callId: this.opts.callId,
        leadId: this.opts.leadId,
        slots: this.opts.slots,
        db: this.opts.db,
      })
    } catch (err) {
      // The model is holding the floor waiting for this result, mid-sentence,
      // right after the prospect said yes. track() logs and swallows, so without
      // this the tool call is never answered and the prospect gets dead air.
      console.error(`[session] tool ${name} threw; answering the model anyway`, err)
      this.opts.realtime.sendToolResult(toolCallId, TOOL_FAILED_OUTPUT)
      return
    }

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
    this.opts.transport.close()
    this.finish()
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    // Every ending routes through here — including the commonest one, the
    // prospect hanging up, which arrives as a Twilio `stop` or a socket close and
    // never touched end(). Without this the model WebSocket stayed open for the
    // life of the process, holding the session reachable and still counting
    // post-hangup audio deltas as agent speech. close() is idempotent.
    this.opts.realtime.close()
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
