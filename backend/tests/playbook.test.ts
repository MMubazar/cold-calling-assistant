import { buildInstructions, SILENCE_DURATION_MS } from '../src/agent/playbook.js'

const input = {
  lead: { id: 'l1', name: 'Ali Raza', company: 'Acme Foods', phone: '+923001234567' },
  slots: [
    { id: 's1', startsAt: new Date('2026-08-10T09:00:00Z') },
    { id: 's2', startsAt: new Date('2026-08-11T14:00:00Z') },
  ],
  agentName: 'Sara',
  companyName: 'Northwind',
}

it('starts endpointing at the tuned 400 ms default', () => {
  expect(SILENCE_DURATION_MS).toBe(400)
})

it('names the prospect and their company', () => {
  const out = buildInstructions(input)
  expect(out).toContain('Ali Raza')
  expect(out).toContain('Acme Foods')
})

it('embeds every available slot with its id so book_meeting can be called without a lookup', () => {
  const out = buildInstructions(input)
  expect(out).toContain('s1')
  expect(out).toContain('s2')
})

it('covers all four discovery areas', () => {
  const out = buildInstructions(input).toLowerCase()
  for (const area of ['need', 'timing', 'authority', 'current solution']) {
    expect(out).toContain(area)
  }
})

it('includes all five objections from the spec', () => {
  const out = buildInstructions(input).toLowerCase()
  for (const o of ['not interested', 'send me an email', 'already have', 'my number', 'who is this']) {
    expect(out).toContain(o)
  }
})

it('states the two-refusal yield rule', () => {
  expect(buildInstructions(input).toLowerCase()).toMatch(/two refusals|second refusal/)
})

it('instructs the agent to listen more than it talks', () => {
  expect(buildInstructions(input).toLowerCase()).toMatch(/listen more|more than half/)
})

it('handles a lead with no company', () => {
  const out = buildInstructions({ ...input, lead: { ...input.lead, company: null } })
  expect(out).toContain('Ali Raza')
  expect(out).not.toContain('null')
})

it('tells the agent to say there is no availability when the slot list is empty', () => {
  const out = buildInstructions({ ...input, slots: [] }).toLowerCase()
  expect(out).toMatch(/no open slots|no availability/)
})
