import { createDb, type Db } from '../src/lib/db.js'

const URL = process.env.DATABASE_URL ?? 'postgres://sb@localhost:5432/coldcall'
let db: Db

beforeAll(() => { db = createDb(URL) })
afterAll(async () => { await db.close() })

beforeEach(async () => {
  await db.query('truncate leads, slots, calls cascade', [])
})

async function seedLead() {
  const rows = await db.query<{ id: string }>(
    `insert into leads (name, company, phone) values ('Ali', 'Acme', '+923001234567') returning id`, [])
  return rows[0]!.id
}

it('creates a call row linked to a lead', async () => {
  const leadId = await seedLead()
  const call = await db.createCall(leadId)
  expect(call.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(call.leadId).toBe(leadId)
})

it('reads a lead back', async () => {
  const leadId = await seedLead()
  const lead = await db.getLead(leadId)
  expect(lead).toEqual({ id: leadId, name: 'Ali', company: 'Acme', phone: '+923001234567' })
})

it('returns null for an unknown lead instead of throwing', async () => {
  expect(await db.getLead('00000000-0000-0000-0000-000000000000')).toBeNull()
})

it('lists only untaken slots, earliest first', async () => {
  await db.query(
    `insert into slots (starts_at, taken) values
       (now() + interval '2 day', false),
       (now() + interval '1 day', false),
       (now() + interval '3 day', true)`, [])
  const slots = await db.getOpenSlots(10)
  expect(slots).toHaveLength(2)
  expect(slots[0]!.startsAt.getTime()).toBeLessThan(slots[1]!.startsAt.getTime())
})

it('appends transcript turns in order', async () => {
  const callId = (await db.createCall(await seedLead())).id
  await db.insertTranscriptTurn(callId, 'agent', 'Hello there')
  await db.insertTranscriptTurn(callId, 'prospect', 'Who is this')
  const rows = await db.query<{ role: string; text: string }>(
    'select role, text from transcript_turns where call_id = $1 order by id', [callId])
  expect(rows).toEqual([
    { role: 'agent', text: 'Hello there' },
    { role: 'prospect', text: 'Who is this' },
  ])
})

it('marks a slot taken exactly once', async () => {
  await db.query(`insert into slots (starts_at) values (now() + interval '1 day')`, [])
  const slot = (await db.getOpenSlots(1))[0]!
  expect(await db.takeSlot(slot.id)).toBe(true)
  expect(await db.takeSlot(slot.id)).toBe(false)
})

it('finalizes a call with disposition and scores', async () => {
  const callId = (await db.createCall(await seedLead())).id
  await db.finalizeCall(callId, {
    disposition: 'booked',
    durationS: 142,
    voicemailDropped: false,
    amdVerdict: 'human',
    audio: { agentMs: 60000, prospectMs: 80000, talkRatio: 0.4286, agentInterruptions: 1 },
  })
  const rows = await db.query<{ disposition: string; talk_ratio: number }>(
    `select c.disposition, s.talk_ratio from calls c join call_scores s on s.call_id = c.id
      where c.id = $1`, [callId])
  expect(rows[0]!.disposition).toBe('booked')
  expect(rows[0]!.talk_ratio).toBeCloseTo(0.4286, 3)
})
