import { createDb, type Db } from '../src/lib/db.js'

// These tests truncate. Refuse to run anywhere but a dedicated test database.
// Named TEST_URL, not URL, so it does not shadow the global URL class used below.
const TEST_URL = process.env.TEST_DATABASE_URL
if (!TEST_URL) {
  throw new Error(
    'TEST_DATABASE_URL is required. These tests truncate tables and must never run against ' +
      'the application database. Try: ' +
      'TEST_DATABASE_URL=postgres://sb@127.0.0.1:5470/coldcall_test npm test',
  )
}
if (!new URL(TEST_URL).pathname.slice(1).endsWith('_test')) {
  throw new Error(`Refusing to truncate "${TEST_URL}" — the database name must end in _test.`)
}

let db: Db

beforeAll(() => { db = createDb(TEST_URL) })
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

it('records the Twilio call sid against the call', async () => {
  const callId = (await db.createCall(await seedLead())).id
  await db.attachTwilioSid(callId, 'CA0001')
  const rows = await db.query<{ twilio_sid: string }>(
    'select twilio_sid from calls where id = $1', [callId])
  expect(rows[0]!.twilio_sid).toBe('CA0001')
})

it('inserts a meeting and reads it back by call', async () => {
  const leadId = await seedLead()
  const callId = (await db.createCall(leadId)).id
  await db.query(`insert into slots (starts_at) values (now() + interval '1 day')`, [])
  const slot = (await db.getOpenSlots(1))[0]!

  expect(await db.getMeetingByCall(callId)).toBeNull()
  const meeting = await db.insertMeeting(callId, leadId, slot)
  expect(meeting.slotId).toBe(slot.id)

  const found = await db.getMeetingByCall(callId)
  expect(found?.id).toBe(meeting.id)
  expect(found?.startsAt.getTime()).toBe(slot.startsAt.getTime())
})

// This is the constraint that makes book_meeting idempotent. Without this test
// the guarantee lives only in application code.
it('refuses a second meeting for the same call', async () => {
  const leadId = await seedLead()
  const callId = (await db.createCall(leadId)).id
  await db.query(`insert into slots (starts_at) values
    (now() + interval '1 day'), (now() + interval '2 day')`, [])
  const slots = await db.getOpenSlots(2)

  await db.insertMeeting(callId, leadId, slots[0]!)
  await expect(db.insertMeeting(callId, leadId, slots[1]!)).rejects.toThrow()

  const rows = await db.query<{ n: string }>(
    'select count(*)::text as n from meetings where call_id = $1', [callId])
  expect(rows[0]!.n).toBe('1')
})

it('merges qualification fields across partial saves', async () => {
  const callId = (await db.createCall(await seedLead())).id
  await db.upsertQualification(callId, { need: 'high spoilage' })
  await db.upsertQualification(callId, { timing: 'this quarter' })

  const rows = await db.query<{ need: string | null; timing: string | null }>(
    'select need, timing from qualifications where call_id = $1', [callId])
  expect(rows[0]).toEqual({ need: 'high spoilage', timing: 'this quarter' })
})
