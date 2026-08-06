import WebSocket from 'ws'
import { TOOL_SCHEMAS } from './tools.js'
import { SILENCE_DURATION_MS } from './playbook.js'

export type RealtimeEvent =
  | { kind: 'audio'; payload: string }
  | { kind: 'prospect_speech_started' }
  | { kind: 'prospect_speech_stopped' }
  | { kind: 'tool_call'; toolCallId: string; name: string; args: Record<string, unknown> }
  | { kind: 'transcript'; role: 'agent' | 'prospect'; text: string }
  | { kind: 'response_done' }
  | { kind: 'error'; message: string }
  | { kind: 'closed' }

export interface RealtimeClient {
  sendAudio(b64: string): void
  sendToolResult(toolCallId: string, output: unknown): void
  cancelResponse(): void
  requestResponse(): void
  on(handler: (e: RealtimeEvent) => void): void
  close(): void
}

export function buildSessionUpdate(instructions: string): object {
  return {
    type: 'session.update',
    session: {
      modalities: ['audio', 'text'],
      instructions,
      voice: 'alloy',
      input_audio_format: 'g711_ulaw',
      output_audio_format: 'g711_ulaw',
      input_audio_transcription: { model: 'whisper-1' },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: SILENCE_DURATION_MS,
      },
      tools: TOOL_SCHEMAS,
      tool_choice: 'auto',
    },
  }
}

export function normalizeRealtimeEvent(raw: string): RealtimeEvent | null {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }

  // Ignore non-object payloads and events with non-string types
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null

  switch (msg.type) {
    case 'response.audio.delta':
      return typeof msg.delta === 'string' ? { kind: 'audio', payload: msg.delta } : null
    case 'input_audio_buffer.speech_started':
      return { kind: 'prospect_speech_started' }
    case 'input_audio_buffer.speech_stopped':
      return { kind: 'prospect_speech_stopped' }
    case 'response.function_call_arguments.done': {
      // A tool call with no id or name cannot be answered: the id is the address
      // a result is returned to. Drop it rather than emit an event whose declared
      // string fields are actually undefined — Task 9 echoes toolCallId straight
      // back to the model, so an undefined there strands the call silently.
      if (typeof msg.call_id !== 'string' || typeof msg.name !== 'string') return null

      let args: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(msg.arguments ?? '{}')
        if (parsed && typeof parsed === 'object') args = parsed
      } catch {
        args = {}
      }
      return { kind: 'tool_call', toolCallId: msg.call_id, name: msg.name, args }
    }
    case 'conversation.item.input_audio_transcription.completed':
      return { kind: 'transcript', role: 'prospect', text: msg.transcript ?? '' }
    case 'response.audio_transcript.done':
      return { kind: 'transcript', role: 'agent', text: msg.transcript ?? '' }
    case 'response.done':
      return { kind: 'response_done' }
    case 'error':
      return { kind: 'error', message: msg.error?.message ?? 'unknown realtime error' }
    default:
      return null
  }
}

/** Just enough of a WebSocket to send on, so the drop path is testable. */
export interface Sendable {
  readyState: number
  send(data: string): void
}

/**
 * Sends one event, or warns that it was dropped.
 *
 * A silent drop here strands whatever was being sent. The worst case is a tool
 * result: the model holds the floor waiting for a function output that never
 * arrives, and the prospect hears dead air. Returns whether it went out.
 */
export function sendJson(socket: Sendable, obj: object): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    const type = (obj as { type?: unknown }).type
    console.warn(`[realtime] dropped ${typeof type === 'string' ? type : 'message'}: socket is not open`)
    return false
  }
  socket.send(JSON.stringify(obj))
  return true
}

export interface ConnectOptions {
  apiKey: string
  model: string
  instructions: string
}

export async function connectRealtime(opts: ConnectOptions): Promise<RealtimeClient> {
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(opts.model)}`,
    { headers: { Authorization: `Bearer ${opts.apiKey}`, 'OpenAI-Beta': 'realtime=v1' } },
  )

  const handlers: ((e: RealtimeEvent) => void)[] = []
  const emit = (e: RealtimeEvent) => handlers.forEach((h) => h(e))
  const send = (obj: object) => { sendJson(ws, obj) }

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })

  send(buildSessionUpdate(opts.instructions))
  ws.on('message', (data) => {
    const e = normalizeRealtimeEvent(data.toString())
    if (e) emit(e)
  })
  ws.on('close', () => emit({ kind: 'closed' }))
  ws.on('error', (err) => emit({ kind: 'error', message: String(err) }))

  return {
    sendAudio: (b64) => send({ type: 'input_audio_buffer.append', audio: b64 }),
    sendToolResult: (toolCallId, output) => {
      send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: toolCallId, output: JSON.stringify(output) },
      })
      send({ type: 'response.create' })
    },
    cancelResponse: () => send({ type: 'response.cancel' }),
    requestResponse: () => send({ type: 'response.create' }),
    on: (h) => { handlers.push(h) },
    close: () => ws.close(),
  }
}
