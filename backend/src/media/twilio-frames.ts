export type TwilioInbound =
  | { event: 'connected' }
  | { event: 'start'; streamSid: string; callSid: string; customParameters: Record<string, string> }
  | { event: 'media'; payload: string; track: string }
  | { event: 'mark'; name: string }
  | { event: 'stop' }

export function parseTwilioMessage(raw: string): TwilioInbound | null {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }

  switch (msg?.event) {
    case 'connected':
      return { event: 'connected' }
    case 'start': {
      const streamSid: unknown = msg.start?.streamSid ?? msg.streamSid
      const callSid: unknown = msg.start?.callSid
      if (typeof streamSid !== 'string' || typeof callSid !== 'string') return null
      return {
        event: 'start',
        streamSid,
        callSid,
        customParameters: msg.start?.customParameters ?? {},
      }
    }
    case 'media': {
      const payload: unknown = msg.media?.payload
      if (typeof payload !== 'string') return null
      return { event: 'media', payload, track: msg.media?.track ?? 'inbound' }
    }
    case 'mark': {
      const name: unknown = msg.mark?.name
      if (typeof name !== 'string') return null
      return { event: 'mark', name }
    }
    case 'stop':
      return { event: 'stop' }
    default:
      return null
  }
}

export function mediaMessage(streamSid: string, payloadB64: string): string {
  return JSON.stringify({ event: 'media', streamSid, media: { payload: payloadB64 } })
}

export function clearMessage(streamSid: string): string {
  return JSON.stringify({ event: 'clear', streamSid })
}

export function markMessage(streamSid: string, name: string): string {
  return JSON.stringify({ event: 'mark', streamSid, mark: { name } })
}
