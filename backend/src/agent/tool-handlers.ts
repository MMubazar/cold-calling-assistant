import type { Db, Slot } from '../lib/db.js'

export interface ToolContext { callId: string; leadId: string; slots: Slot[]; db: Db }
export interface ToolResult { output: unknown; endCall: boolean }

const BOOKING_FAILED = {
  booked: false,
  instruction: 'Booking failed. Do not claim the meeting is booked. Offer to follow up by email instead.',
}

/**
 * What to hand the model when a tool throws instead of returning.
 *
 * The model is waiting on a function output and will hold the floor until it
 * arrives, so something must always be sent. This payload is the safe thing to
 * say: it stops the agent claiming a booking it does not have and gives it a
 * next move.
 */
export const TOOL_FAILED_OUTPUT = { ...BOOKING_FAILED, error: 'The system could not complete that.' }

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

async function bookMeeting(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
  const slotId = asRecord(raw).slot_id
  const slot = ctx.slots.find((s) => s.id === slotId)
  if (!slot) {
    return { output: { ...BOOKING_FAILED, error: 'That slot is not available.' }, endCall: false }
  }

  const existing = await ctx.db.getMeetingByCall(ctx.callId)
  if (existing) {
    return {
      output: { booked: true, already_booked: true, slot_id: existing.slotId,
                starts_at: existing.startsAt.toISOString() },
      endCall: false,
    }
  }

  // One transaction: taking the slot without writing the meeting would leave a
  // slot marked taken that nothing can ever book, and a prospect told nothing.
  const meeting = await ctx.db.takeSlotAndInsertMeeting(ctx.callId, ctx.leadId, slot)
  if (!meeting) {
    return { output: { ...BOOKING_FAILED, error: 'That slot was just taken.' }, endCall: false }
  }

  return {
    output: { booked: true, slot_id: meeting.slotId, starts_at: meeting.startsAt.toISOString() },
    endCall: false,
  }
}

/** Fire-and-forget per spec §5: failures are logged and swallowed, never surfaced to the agent. */
async function saveQualification(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    await ctx.db.upsertQualification(ctx.callId, asRecord(raw))
  } catch (err) {
    console.error('[tool] save_qualification failed (swallowed)', err)
  }
  return { output: { saved: true }, endCall: false }
}

export async function handleToolCall(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case 'book_meeting':
      return bookMeeting(rawArgs, ctx)
    case 'save_qualification':
      return saveQualification(rawArgs, ctx)
    case 'end_call':
      return { output: { ended: true }, endCall: true }
    default:
      return { output: { error: `Unknown tool: ${name}` }, endCall: false }
  }
}
