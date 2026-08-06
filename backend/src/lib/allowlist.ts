const E164 = /^\+[1-9]\d{7,14}$/

export function normalizeE164(raw: string): string | null {
  const stripped = raw.replace(/[\s()\-.]/g, '')
  return E164.test(stripped) ? stripped : null
}

export function isAllowed(raw: string, allowlist: string[]): boolean {
  const target = normalizeE164(raw)
  if (target === null) return false
  return allowlist.some((entry) => normalizeE164(entry) === target)
}
