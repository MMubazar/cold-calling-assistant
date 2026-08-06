import { normalizeE164, isAllowed } from '../src/lib/allowlist.js'

const LIST = ['+923001234567', '+15559998888']

it('strips formatting characters', () => {
  expect(normalizeE164('+92 (300) 123-4567')).toBe('+923001234567')
})

it('rejects numbers without a leading plus', () => {
  expect(normalizeE164('923001234567')).toBeNull()
})

it('rejects implausible lengths', () => {
  expect(normalizeE164('+1234')).toBeNull()
  expect(normalizeE164('+1234567890123456')).toBeNull()
})

it('rejects letters', () => {
  expect(normalizeE164('+92300ABC4567')).toBeNull()
})

it('allows a listed number regardless of formatting', () => {
  expect(isAllowed('+92-300-123 4567', LIST)).toBe(true)
})

it('denies an unlisted number', () => {
  expect(isAllowed('+923009999999', LIST)).toBe(false)
})

it('denies unparseable input', () => {
  expect(isAllowed('not a phone', LIST)).toBe(false)
})

it('denies everything when the allowlist is empty', () => {
  expect(isAllowed('+923001234567', [])).toBe(false)
})

it('normalizes allowlist entries too, so formatting there cannot open a hole', () => {
  expect(isAllowed('+923001234567', ['+92 300 123 4567'])).toBe(true)
})
