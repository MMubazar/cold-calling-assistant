import { createDb, leadStatusFor, type Db } from '../src/lib/db.js'

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

it('books a slot exactly once', async () => {
  const leadId = await seedLead()
  const callA = (await db.createCall(leadId)).id
  const callB = (await db.createCall(leadId)).id
  await db.query(`insert into slots (starts_at) values (now() + interval '1 day')`, [])
  const slot = (await db.getOpenSlots(1))[0]!
  expect(await db.takeSlotAndInsertMeeting(callA, leadId, slot)).not.toBeNull()
  expect(await db.takeSlotAndInsertMeeting(callB, leadId, slot)).toBeNull()
})

it('finalizes a call with disposition and scores', async () => {
  const callId = (await db.createCall(await seedLead())).id
  await db.finalizeCall(callId, {
    disposition: 'booked',
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

// The console ticks its clock from calls.started_at. Measuring the duration from
// anywhere else made it visibly rewind at hangup.
it('derives duration_s from the call row own started_at', async () => {
  const callId = (await db.createCall(await seedLead())).id
  await db.query(`update calls set started_at = now() - interval '142 seconds' where id = $1`, [callId])
  await db.finalizeCall(callId, {
    disposition: 'booked',
    voicemailDropped: false,
    amdVerdict: 'human',
    audio: { agentMs: 1, prospectMs: 1, talkRatio: 0.5, agentInterruptions: 0 },
  })
  const rows = await db.query<{ duration_s: number }>(
    'select duration_s from calls where id = $1', [callId])
  expect(rows[0]!.duration_s).toBeGreaterThanOrEqual(142)
  expect(rows[0]!.duration_s).toBeLessThan(150)
})

it('writes the lead status at teardown so it is not stuck on new forever', async () => {
  const leadId = await seedLead()
  const callId = (await db.createCall(leadId)).id
  await db.finalizeCall(callId, {
    disposition: 'booked',
    voicemailDropped: false,
    amdVerdict: 'human',
    audio: { agentMs: 1, prospectMs: 1, talkRatio: 0.5, agentInterruptions: 0 },
  })
  const rows = await db.query<{ status: string }>('select status from leads where id = $1', [leadId])
  expect(rows[0]!.status).toBe('booked')
})

it('maps every disposition to a lead status', () => {
  expect(leadStatusFor('booked')).toBe('booked')
  expect(leadStatusFor('voicemail')).toBe('voicemail')
  expect(leadStatusFor('no_answer')).toBe('attempted')
  expect(leadStatusFor('failed')).toBe('attempted')
  expect(leadStatusFor('not_interested')).toBe('contacted')
})

// A no-answer call never opens a media stream, so there is no session to
// snapshot. Left unfinalized the row is returned as "the live call" forever and
// the console's Call button never re-enables.
it('finalizes an unbridged call with a no_answer disposition and zeroed scores', async () => {
  const leadId = await seedLead()
  const callId = (await db.createCall(leadId)).id
  await db.finalizeUnbridgedCall(callId, 'no_answer')

  const rows = await db.query<{ ended_at: Date | null; disposition: string; duration_s: number }>(
    'select ended_at, disposition, duration_s from calls where id = $1', [callId])
  expect(rows[0]!.ended_at).not.toBeNull()
  expect(rows[0]!.disposition).toBe('no_answer')
  expect(rows[0]!.duration_s).toBeGreaterThanOrEqual(0)

  const scores = await db.query<{ agent_ms: number; prospect_ms: number }>(
    'select agent_ms, prospect_ms from call_scores where call_id = $1', [callId])
  expect(scores[0]).toEqual({ agent_ms: 0, prospect_ms: 0 })

  const lead = await db.query<{ status: string }>('select status from leads where id = $1', [leadId])
  expect(lead[0]!.status).toBe('attempted')
})

// The status callback and the media-socket teardown are both fired by the call
// ending and their order is not guaranteed. The late one must not win.
it('refuses to overwrite a call that a real teardown already finalized', async () => {
  const callId = (await db.createCall(await seedLead())).id
  await db.finalizeCall(callId, {
    disposition: 'booked',
    voicemailDropped: false,
    amdVerdict: 'human',
    audio: { agentMs: 60000, prospectMs: 80000, talkRatio: 0.43, agentInterruptions: 1 },
  })
  await db.finalizeUnbridgedCall(callId, 'no_answer')

  const rows = await db.query<{ disposition: string }>(
    'select disposition from calls where id = $1', [callId])
  expect(rows[0]!.disposition).toBe('booked')
  const scores = await db.query<{ agent_ms: number }>(
    'select agent_ms from call_scores where call_id = $1', [callId])
  expect(scores[0]!.agent_ms).toBe(60000)
})

it('records the Twilio call sid against the call', async () => {
  const callId = (await db.createCall(await seedLead())).id
  await db.attachTwilioSid(callId, 'CA0001')
  const rows = await db.query<{ twilio_sid: string }>(
    'select twilio_sid from calls where id = $1', [callId])
  expect(rows[0]!.twilio_sid).toBe('CA0001')
})

it('takes the slot and inserts a meeting, and reads it back by call', async () => {
  const leadId = await seedLead()
  const callId = (await db.createCall(leadId)).id
  await db.query(`insert into slots (starts_at) values (now() + interval '1 day')`, [])
  const slot = (await db.getOpenSlots(1))[0]!

  expect(await db.getMeetingByCall(callId)).toBeNull()
  const meeting = await db.takeSlotAndInsertMeeting(callId, leadId, slot)
  expect(meeting!.slotId).toBe(slot.id)

  const taken = await db.query<{ taken: boolean }>('select taken from slots where id = $1', [slot.id])
  expect(taken[0]!.taken).toBe(true)

  const found = await db.getMeetingByCall(callId)
  expect(found?.id).toBe(meeting!.id)
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

  await db.takeSlotAndInsertMeeting(callId, leadId, slots[0]!)
  await expect(db.takeSlotAndInsertMeeting(callId, leadId, slots[1]!)).rejects.toThrow()

  const rows = await db.query<{ n: string }>(
    'select count(*)::text as n from meetings where call_id = $1', [callId])
  expect(rows[0]!.n).toBe('1')
})

// The whole point of the transaction: a failed insert must not leave a slot
// marked taken with no meeting against it, which nothing could ever book again.
it('rolls the slot back when the meeting insert fails', async () => {
  const leadId = await seedLead()
  const callId = (await db.createCall(leadId)).id
  await db.query(`insert into slots (starts_at) values
    (now() + interval '1 day'), (now() + interval '2 day')`, [])
  const slots = await db.getOpenSlots(2)

  await db.takeSlotAndInsertMeeting(callId, leadId, slots[0]!)
  // Same call id, so the unique constraint on meetings.call_id rejects it.
  await expect(db.takeSlotAndInsertMeeting(callId, leadId, slots[1]!)).rejects.toThrow()

  const rows = await db.query<{ taken: boolean }>(
    'select taken from slots where id = $1', [slots[1]!.id])
  expect(rows[0]!.taken).toBe(false)
})

it('merges qualification fields across partial saves', async () => {
  const callId = (await db.createCall(await seedLead())).id
  await db.upsertQualification(callId, { need: 'high spoilage' })
  await db.upsertQualification(callId, { timing: 'this quarter' })

  const rows = await db.query<{ need: string | null; timing: string | null }>(
    'select need, timing from qualifications where call_id = $1', [callId])
  expect(rows[0]).toEqual({ need: 'high spoilage', timing: 'this quarter' })
})
