import pg from 'pg'

/**
 * Read-side database access for the console.
 *
 * The backend call server owns every write that happens during a call; this
 * app only reads, plus creating leads. Keeping the write surface that small is
 * deliberate — two processes writing call state would race.
 */

const DEFAULT_URL = 'postgres://sb@127.0.0.1:5470/coldcall'

declare global {
  // eslint-disable-next-line no-var
  var __coldcallPool: pg.Pool | undefined
}

function pool(): pg.Pool {
  // Next's dev server re-evaluates modules on edit; without this the pool
  // count climbs until Postgres refuses connections.
  globalThis.__coldcallPool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_URL,
    max: 4,
  })
  return globalThis.__coldcallPool
}

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool().query(sql, params)
  return result.rows as T[]
}

export interface LeadRow {
  id: string
  name: string
  company: string | null
  phone: string
  status: string
  last_disposition: string | null
}

export interface CallRow {
  id: string
  lead_id: string
  lead_name: string
  lead_company: string | null
  lead_phone: string
  started_at: string
  ended_at: string | null
  duration_s: number | null
  disposition: string | null
  voicemail_dropped: boolean
  amd_verdict: string | null
  agent_ms: number | null
  prospect_ms: number | null
  talk_ratio: number | null
  agent_interruptions: number | null
  meeting_at: string | null
}

export interface TurnRow {
  id: string
  role: 'agent' | 'prospect'
  text: string
}

const CALL_SELECT = `
  select c.id, c.lead_id, l.name as lead_name, l.company as lead_company,
         l.phone as lead_phone, c.started_at, c.ended_at, c.duration_s,
         c.disposition, c.voicemail_dropped, c.amd_verdict,
         s.agent_ms, s.prospect_ms, s.talk_ratio, s.agent_interruptions,
         m.starts_at as meeting_at
    from calls c
    join leads l on l.id = c.lead_id
    left join call_scores s on s.call_id = c.id
    left join meetings m on m.call_id = c.id
`

export function listLeads(): Promise<LeadRow[]> {
  return query<LeadRow>(`
    select l.id, l.name, l.company, l.phone, l.status,
           (select c.disposition from calls c
              where c.lead_id = l.id and c.disposition is not null
              order by c.started_at desc limit 1) as last_disposition
      from leads l
     order by l.created_at desc
  `)
}

export function createLead(name: string, company: string | null, phone: string): Promise<LeadRow[]> {
  return query<LeadRow>(
    `insert into leads (name, company, phone) values ($1, $2, $3)
       returning id, name, company, phone, status, null::text as last_disposition`,
    [name, company, phone],
  )
}

export function recentCalls(limit = 12): Promise<CallRow[]> {
  return query<CallRow>(`${CALL_SELECT} order by c.started_at desc limit $1`, [limit])
}

export async function getCall(callId: string): Promise<CallRow | null> {
  const rows = await query<CallRow>(`${CALL_SELECT} where c.id = $1`, [callId])
  return rows[0] ?? null
}

/** The live call, if one is running: a row with no end time yet. */
export async function activeCall(): Promise<CallRow | null> {
  const rows = await query<CallRow>(
    `${CALL_SELECT} where c.ended_at is null order by c.started_at desc limit 1`,
  )
  return rows[0] ?? null
}

/** Turns after `afterId`, which is how the live stream stays incremental. */
export function turnsSince(callId: string, afterId: string): Promise<TurnRow[]> {
  return query<TurnRow>(
    `select id::text, role, text from transcript_turns
      where call_id = $1 and id > $2 order by id`,
    [callId, afterId],
  )
}
