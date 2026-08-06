export interface Env {
  twilioAccountSid: string
  twilioAuthToken: string
  twilioPhoneNumber: string
  openaiApiKey: string
  realtimeModel: string
  databaseUrl: string
  verifiedNumbers: string[]
  publicBaseUrl: string
  voicemailAudioPath: string
  port: number
}

const REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'OPENAI_API_KEY',
  'DATABASE_URL',
  'VERIFIED_NUMBERS',
  'PUBLIC_BASE_URL',
  'VOICEMAIL_AUDIO_PATH',
] as const

// Verify the current realtime model id against provider docs before any live call.
const DEFAULT_REALTIME_MODEL = 'gpt-realtime-mini'

export function loadEnv(source: Record<string, string | undefined>): Env {
  const missing = REQUIRED.filter((k) => !source[k]?.trim())
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  const verifiedNumbers = source
    .VERIFIED_NUMBERS!.split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0)

  if (verifiedNumbers.length === 0) {
    throw new Error('VERIFIED_NUMBERS must list at least one number; dialing is never unrestricted')
  }

  return {
    twilioAccountSid: source.TWILIO_ACCOUNT_SID!,
    twilioAuthToken: source.TWILIO_AUTH_TOKEN!,
    twilioPhoneNumber: source.TWILIO_PHONE_NUMBER!,
    openaiApiKey: source.OPENAI_API_KEY!,
    realtimeModel: source.OPENAI_REALTIME_MODEL?.trim() || DEFAULT_REALTIME_MODEL,
    databaseUrl: source.DATABASE_URL!,
    verifiedNumbers,
    publicBaseUrl: source.PUBLIC_BASE_URL!.replace(/\/$/, ''),
    voicemailAudioPath: source.VOICEMAIL_AUDIO_PATH!,
    port: Number(source.PORT ?? 8080),
  }
}
