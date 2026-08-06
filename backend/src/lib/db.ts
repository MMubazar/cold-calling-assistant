import pg from 'pg'
import type { AudioSnapshot } from '../media/audio.js'

export interface Lead { id: string; name: string; company: string | null; phone: string }
export interface Slot { id: string; startsAt: Date }
export interface Call { id: string; leadId: string }
export interface Meeting { id: string; slotId: string; startsAt: Date }

export interface FinalizeInput {
  disposition: string
  voicemailDropped: boolean
  amdVerdict: string | null
  audio: AudioSnapshot
}

/**
 * What the lead row should say once a call against it has resolved.
 *
 * `leads.status` was written by nothing and read by the console, so every lead
 * sat at 'new' forever. One outcome word per lead, derived from the call's own
 * disposition so the two can never disagree.
 */
export function leadStatusFor(disposition: string): string {
  switch (disposition) {
    case 'booked':
      return 'booked'
    case 'voicemail':
      return 'voicemail'
    case 'no_answer':
    case 'failed':
      return 'attempted'
    default:
      return 'contacted'
  }
}

export interface Db {
  query<T>(sql: string, params: unknown[]): Promise<T[]>
  createCall(leadId: string): Promise<Call>
  attachTwilioSid(callId: string, sid: string): Promise<void>
  getLead(leadId: string): Promise<Lead | null>
  getOpenSlots(limit: number): Promise<Slot[]>
  insertTranscriptTurn(callId: string, role: 'agent' | 'prospect', text: string): Promise<void>
  getMeetingByCall(callId: string): Promise<Meeting | null>
  /** Takes the slot and writes the meeting atomically; null when the slot was already gone. */
  takeSlotAndInsertMeeting(callId: string, leadId: string, slot: Slot): Promise<Meeting | null>
  upsertQualification(callId: string, fields: Record<string, unknown>): Promise<void>
  finalizeCall(callId: string, input: FinalizeInput): Promise<void>
  /** Finalizes a call whose media stream never bridged: no audio, no session, no scores. */
  finalizeUnbridgedCall(callId: string, disposition: string): Promise<void>
  close(): Promise<void>
}

export function createDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const query = async <T>(sql: string, params: unknown[]): Promise<T[]> =>
    (await pool.query(sql, params)).rows as T[]

  return {
    query,

    async createCall(leadId) {
      const rows = await query<{ id: string; lead_id: string }>(
        'insert into calls (lead_id) values ($1) returning id, lead_id', [leadId])
      return { id: rows[0]!.id, leadId: rows[0]!.lead_id }
    },

    async attachTwilioSid(callId, sid) {
      await query('update calls set twilio_sid = $2 where id = $1', [callId, sid])
    },

    async getLead(leadId) {
      const rows = await query<Lead>(
        'select id, name, company, phone from leads where id = $1', [leadId])
      return rows[0] ?? null
    },

    async getOpenSlots(limit) {
      const rows = await query<{ id: string; starts_at: Date }>(
        `select id, starts_at from slots
          where taken = false and starts_at > now()
          order by starts_at limit $1`, [limit])
      return rows.map((r) => ({ id: r.id, startsAt: r.starts_at }))
    },

    async insertTranscriptTurn(callId, role, text) {
      await query('insert into transcript_turns (call_id, role, text) values ($1, $2, $3)',
        [callId, role, text])
    },

    async getMeetingByCall(callId) {
      const rows = await query<{ id: string; slot_id: string; starts_at: Date }>(
        'select id, slot_id, starts_at from meetings where call_id = $1', [callId])
      const r = rows[0]
      return r ? { id: r.id, slotId: r.slot_id, startsAt: r.starts_at } : null
    },

    /**
     * One transaction, because these two writes are one fact. Taking the slot
     * without recording the meeting leaves a slot that is permanently
     * unbookable and a prospect who was told nothing.
     */
    async takeSlotAndInsertMeeting(callId, leadId, slot) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const taken = await client.query(
          'update slots set taken = true where id = $1 and taken = false returning id', [slot.id])
        if (taken.rowCount !== 1) {
          await client.query('rollback')
          return null
        }
        const rows = await client.query<{ id: string }>(
          `insert into meetings (call_id, lead_id, slot_id, starts_at)
           values ($1, $2, $3, $4) returning id`, [callId, leadId, slot.id, slot.startsAt])
        await client.query('commit')
        return { id: rows.rows[0]!.id, slotId: slot.id, startsAt: slot.startsAt }
      } catch (err) {
        await client.query('rollback')
        throw err
      } finally {
        client.release()
      }
    },

    async upsertQualification(callId, fields) {
      await query(
        `insert into qualifications (call_id, need, timing, authority, current_solution, raw)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (call_id) do update set
           need = coalesce(excluded.need, qualifications.need),
           timing = coalesce(excluded.timing, qualifications.timing),
           authority = coalesce(excluded.authority, qualifications.authority),
           current_solution = coalesce(excluded.current_solution, qualifications.current_solution),
           raw = excluded.raw`,
        [callId, fields.need ?? null, fields.timing ?? null, fields.authority ?? null,
         fields.current_solution ?? null, JSON.stringify(fields)])
    },

    async finalizeCall(callId, input) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        // duration_s is computed from the row's own started_at rather than from
        // the media stream's start, so it matches the clock the console has been
        // ticking since the row was inserted. Measuring from the Twilio `start`
        // event excluded ring time and made the console visibly rewind at hangup.
        await client.query(
          `update calls set ended_at = now(),
             duration_s = extract(epoch from (now() - started_at))::int,
             disposition = $2, voicemail_dropped = $3, amd_verdict = $4
           where id = $1`,
          [callId, input.disposition, input.voicemailDropped, input.amdVerdict])
        await client.query(
          `update leads set status = $2
            where id = (select lead_id from calls where id = $1)`,
          [callId, leadStatusFor(input.disposition)])
        await client.query(
          `insert into call_scores (call_id, agent_ms, prospect_ms, talk_ratio, agent_interruptions)
           values ($1, $2, $3, $4, $5)
           on conflict (call_id) do update set
             agent_ms = excluded.agent_ms, prospect_ms = excluded.prospect_ms,
             talk_ratio = excluded.talk_ratio, agent_interruptions = excluded.agent_interruptions`,
          [callId, input.audio.agentMs, input.audio.prospectMs, input.audio.talkRatio,
           input.audio.agentInterruptions])
        await client.query('commit')
      } catch (err) {
        await client.query('rollback')
        throw err
      } finally {
        client.release()
      }
    },

    /**
     * A call that rang out, was declined, or was rejected never opened a media
     * stream, so there is no session to snapshot — but the row still has to be
     * closed. Left NULL, `activeCall()` in the console returns it forever and
     * the Call button never re-enables.
     *
     * Guarded on `ended_at is null` so it can never clobber a real outcome: the
     * status callback and the media-socket teardown are both triggered by the
     * call ending and their order is not guaranteed.
     */
    async finalizeUnbridgedCall(callId, disposition) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const updated = await client.query(
          `update calls set ended_at = now(),
             duration_s = extract(epoch from (now() - started_at))::int,
             disposition = $2
           where id = $1 and ended_at is null
           returning lead_id`,
          [callId, disposition])
        if (updated.rowCount === 1) {
          await client.query(
            'update leads set status = $2 where id = $1',
            [updated.rows[0]!.lead_id, leadStatusFor(disposition)])
          await client.query(
            `insert into call_scores (call_id, agent_ms, prospect_ms, talk_ratio, agent_interruptions)
             values ($1, 0, 0, 0, 0) on conflict (call_id) do nothing`,
            [callId])
        }
        await client.query('commit')
      } catch (err) {
        await client.query('rollback')
        throw err
      } finally {
        client.release()
      }
    },

    close: () => pool.end(),
  }
}
