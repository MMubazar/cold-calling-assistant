import { TOOL_SCHEMAS } from '../src/agent/tools.js'
import { handleToolCall } from '../src/agent/tool-handlers.js'
import type { Db, Slot } from '../src/lib/db.js'

const SLOTS: Slot[] = [{ id: 's1', startsAt: new Date('2026-08-10T09:00:00Z') }]

// Parameters are annotated because the `as unknown as Db` cast happens after the
// literal is built, so nothing contextually types these callbacks. Without the
// annotations `noImplicitAny` fails the typecheck.
function fakeDb(overrides: Partial<Db> = {}): Db {
  return {
    getMeetingByCall: async () => null,
    takeSlot: async () => true,
    insertMeeting: async (_c: string, _l: string, slot: Slot) =>
      ({ id: 'm1', slotId: slot.id, startsAt: slot.startsAt }),
    upsertQualification: async () => {},
    ...overrides,
  } as unknown as Db
}

const ctx = (db: Db) => ({ callId: 'c1', leadId: 'l1', slots: SLOTS, db })

it('exposes exactly the three Phase 1 tools', () => {
  expect(TOOL_SCHEMAS.map((t) => t.name).sort()).toEqual(['book_meeting', 'end_call', 'save_qualification'])
})

it('does not expose a check_availability tool', () => {
  expect(TOOL_SCHEMAS.map((t) => t.name)).not.toContain('check_availability')
})

it('books a meeting and reports the confirmed time', async () => {
  const res = await handleToolCall('book_meeting', { slot_id: 's1' }, ctx(fakeDb()))
  expect(res.endCall).toBe(false)
  expect(res.output).toMatchObject({ booked: true, slot_id: 's1' })
})

it('rejects a slot id that was never offered', async () => {
  const res = await handleToolCall('book_meeting', { slot_id: 'nope' }, ctx(fakeDb()))
  expect(res.output).toMatchObject({ booked: false })
  expect(String((res.output as any).error)).toMatch(/not available/i)
})

it('is idempotent: a second booking returns the existing meeting', async () => {
  let inserts = 0
  const db = fakeDb({
    getMeetingByCall: async () => ({ id: 'm1', slotId: 's1', startsAt: SLOTS[0]!.startsAt }),
    insertMeeting: async () => { inserts++; throw new Error('should not be reached') },
  })
  const res = await handleToolCall('book_meeting', { slot_id: 's1' }, ctx(db))
  expect(res.output).toMatchObject({ booked: true, already_booked: true })
  expect(inserts).toBe(0)
})

it('reports failure rather than a false booking when the slot was taken concurrently', async () => {
  const res = await handleToolCall('book_meeting', { slot_id: 's1' }, ctx(fakeDb({ takeSlot: async () => false })))
  expect(res.output).toMatchObject({ booked: false })
})

it('tells the agent to offer email follow-up when booking fails', async () => {
  const res = await handleToolCall('book_meeting', { slot_id: 's1' }, ctx(fakeDb({ takeSlot: async () => false })))
  expect(String((res.output as any).instruction)).toMatch(/email/i)
})

it('saves qualification fields', async () => {
  const seen: Record<string, unknown>[] = []
  const db = fakeDb({ upsertQualification: async (_c, f) => { seen.push(f) } })
  const res = await handleToolCall('save_qualification', { need: 'high churn' }, ctx(db))
  expect(res.output).toMatchObject({ saved: true })
  expect(seen[0]).toMatchObject({ need: 'high churn' })
})

it('swallows a qualification write failure — it is fire-and-forget', async () => {
  const db = fakeDb({ upsertQualification: async () => { throw new Error('db down') } })
  const res = await handleToolCall('save_qualification', { need: 'x' }, ctx(db))
  expect(res.output).toMatchObject({ saved: true })
})

it('end_call signals termination', async () => {
  const res = await handleToolCall('end_call', { reason: 'refused twice' }, ctx(fakeDb()))
  expect(res.endCall).toBe(true)
})

it('rejects an unknown tool name', async () => {
  const res = await handleToolCall('drop_database', {}, ctx(fakeDb()))
  expect(String((res.output as any).error)).toMatch(/unknown tool/i)
  expect(res.endCall).toBe(false)
})

it('rejects malformed arguments without throwing', async () => {
  const res = await handleToolCall('book_meeting', 'not-an-object', ctx(fakeDb()))
  expect(res.output).toMatchObject({ booked: false })
})
