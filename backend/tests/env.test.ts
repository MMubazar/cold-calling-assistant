import { loadEnv } from '../src/lib/env.js'

const complete = {
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_PHONE_NUMBER: '+15550001111',
  OPENAI_API_KEY: 'sk-x',
  DATABASE_URL: 'postgres://sb@localhost:5432/coldcall',
  VERIFIED_NUMBERS: '+923001234567, +15559998888',
  PUBLIC_BASE_URL: 'https://abc.ngrok.app',
  VOICEMAIL_AUDIO_PATH: './assets/voicemail.ulaw',
}

it('parses a complete environment', () => {
  const env = loadEnv(complete)
  expect(env.twilioAccountSid).toBe('AC123')
  expect(env.port).toBe(8080)
})

it('splits and trims the allowlist', () => {
  expect(loadEnv(complete).verifiedNumbers).toEqual(['+923001234567', '+15559998888'])
})

it('throws naming every missing variable at once', () => {
  const { OPENAI_API_KEY, DATABASE_URL, ...rest } = complete
  expect(() => loadEnv(rest)).toThrow(/OPENAI_API_KEY.*DATABASE_URL|DATABASE_URL.*OPENAI_API_KEY/)
})

it('rejects an empty allowlist so dialing can never be unrestricted', () => {
  expect(() => loadEnv({ ...complete, VERIFIED_NUMBERS: '  ' })).toThrow(/VERIFIED_NUMBERS/)
})

it('honors an overridden port and realtime model', () => {
  const env = loadEnv({ ...complete, PORT: '9001', OPENAI_REALTIME_MODEL: 'model-x' })
  expect(env.port).toBe(9001)
  expect(env.realtimeModel).toBe('model-x')
})
