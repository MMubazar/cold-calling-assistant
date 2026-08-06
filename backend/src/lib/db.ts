import pg from 'pg'
import type { AudioSnapshot } from '../media/audio.js'

export interface Lead { id: string; name: string; company: string | null; phone: string }
export interface Slot { id: string; startsAt: Date }
export interface Call { id: string; leadId: string }
export interface Meeting { id: string; slotId: string; startsAt: Date }

export interface FinalizeInput {
  disposition: string
  durationS: number
  voicemailDropped: boolean
  amdVerdict: string | null
  audio: AudioSnapshot
}

export interface Db {
  query<T>(sql: string, params: unknown[]): Promise<T[]>
  createCall(leadId: string): Promise<Call>
  attachTwilioSid(callId: string, sid: string): Promise<void>
  getLead(leadId: string): Promise<Lead | null>
  getOpenSlots(limit: number): Promise<Slot[]>
  insertTranscriptTurn(callId: string, role: 'agent' | 'prospect', text: string): Promise<void>
  takeSlot(slotId: string): Promise<boolean>
  getMeetingByCall(callId: string): Promise<Meeting | null>
  insertMeeting(callId: string, leadId: string, slot: Slot): Promise<Meeting>
  upsertQualification(callId: string, fields: Record<string, unknown>): Promise<void>
  finalizeCall(callId: string, input: FinalizeInput): Promise<void>
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

    async takeSlot(slotId) {
      const rows = await query<{ id: string }>(
        'update slots set taken = true where id = $1 and taken = false returning id', [slotId])
      return rows.length === 1
    },

    async getMeetingByCall(callId) {
      const rows = await query<{ id: string; slot_id: string; starts_at: Date }>(
        'select id, slot_id, starts_at from meetings where call_id = $1', [callId])
      const r = rows[0]
      return r ? { id: r.id, slotId: r.slot_id, startsAt: r.starts_at } : null
    },

    async insertMeeting(callId, leadId, slot) {
      const rows = await query<{ id: string }>(
        `insert into meetings (call_id, lead_id, slot_id, starts_at)
         values ($1, $2, $3, $4) returning id`, [callId, leadId, slot.id, slot.startsAt])
      return { id: rows[0]!.id, slotId: slot.id, startsAt: slot.startsAt }
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
        await client.query(
          `update calls set ended_at = now(), duration_s = $2, disposition = $3,
             voicemail_dropped = $4, amd_verdict = $5 where id = $1`,
          [callId, input.durationS, input.disposition, input.voicemailDropped, input.amdVerdict])
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

    close: () => pool.end(),
  }
}
