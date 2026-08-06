import {
  parseTwilioMessage,
  mediaMessage,
  clearMessage,
  markMessage,
} from '../src/media/twilio-frames.js'

it('parses a start event and flattens custom parameters', () => {
  const raw = JSON.stringify({
    event: 'start',
    sequenceNumber: '1',
    streamSid: 'MZ111',
    start: {
      streamSid: 'MZ111',
      callSid: 'CA222',
      customParameters: { callId: 'call-abc' },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  })
  expect(parseTwilioMessage(raw)).toEqual({
    event: 'start',
    streamSid: 'MZ111',
    callSid: 'CA222',
    customParameters: { callId: 'call-abc' },
  })
})

it('parses a media event down to its payload', () => {
  const raw = JSON.stringify({
    event: 'media',
    streamSid: 'MZ111',
    media: { track: 'inbound', chunk: '5', timestamp: '100', payload: 'AAAA' },
  })
  expect(parseTwilioMessage(raw)).toEqual({ event: 'media', payload: 'AAAA', track: 'inbound' })
})

it('parses mark, stop, and connected events', () => {
  expect(parseTwilioMessage(JSON.stringify({ event: 'mark', mark: { name: 'vm-done' } })))
    .toEqual({ event: 'mark', name: 'vm-done' })
  expect(parseTwilioMessage(JSON.stringify({ event: 'stop' }))).toEqual({ event: 'stop' })
  expect(parseTwilioMessage(JSON.stringify({ event: 'connected' }))).toEqual({ event: 'connected' })
})

it('returns null for malformed JSON rather than throwing', () => {
  expect(parseTwilioMessage('{not json')).toBeNull()
})

it('returns null for unknown event types', () => {
  expect(parseTwilioMessage(JSON.stringify({ event: 'dtmf' }))).toBeNull()
})

it('returns null for a start event missing its callSid', () => {
  expect(parseTwilioMessage(JSON.stringify({ event: 'start', start: {} }))).toBeNull()
})

it('builds outbound media, clear, and mark messages', () => {
  expect(JSON.parse(mediaMessage('MZ111', 'BBBB'))).toEqual({
    event: 'media', streamSid: 'MZ111', media: { payload: 'BBBB' },
  })
  expect(JSON.parse(clearMessage('MZ111'))).toEqual({ event: 'clear', streamSid: 'MZ111' })
  expect(JSON.parse(markMessage('MZ111', 'vm-done'))).toEqual({
    event: 'mark', streamSid: 'MZ111', mark: { name: 'vm-done' },
  })
})
