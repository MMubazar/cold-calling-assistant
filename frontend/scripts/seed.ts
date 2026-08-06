/**
 * Demo data for the console, so the layout can be judged with real content
 * rather than empty states.
 *
 *   npm run seed
 *
 * WARNING: backend/tests/db.test.ts truncates leads, slots and calls in its
 * beforeEach. Running the backend test suite against this same database wipes
 * everything this script inserts. Re-run it afterwards.
 */
import pg from 'pg'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://sb@127.0.0.1:5470/coldcall',
})

async function main() {
  const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    pool.query<T>(sql, params)

  await q<pg.QueryResultRow>(`delete from calls`)
  await q('delete from leads')

  const leads = await q<{ id: string; name: string }>(
    `insert into leads (name, company, phone, notes) values
       ('Ali Raza',      'Acme Foods',     '+923001234567', 'Warm intro from a supplier'),
       ('Hina Shah',     'Meridian Labs',  '+923214448899', null),
       ('Daniyal Karim', 'Karim Textiles', '+923339990011', 'Called once, asked to try again'),
       ('Fatima Noor',   null,             '+923457776655', null)
     returning id, name`,
  )

  const slots = await q<{ id: string; starts_at: Date }>(
    `select id, starts_at from slots where taken = false order by starts_at limit 2`,
  )
  if (slots.rows.length < 2) {
    await q(`insert into slots (starts_at) select generate_series(
      date_trunc('hour', now()) + interval '1 day',
      date_trunc('hour', now()) + interval '10 day', interval '4 hour')`)
  }
  const openSlots = await q<{ id: string; starts_at: Date }>(
    `select id, starts_at from slots where taken = false order by starts_at limit 2`,
  )

  // A call that worked: the agent listened, qualified, and booked.
  const booked = await q<{ id: string }>(
    `insert into calls (lead_id, twilio_sid, started_at, ended_at, duration_s, disposition,
                        voicemail_dropped, amd_verdict)
     values ($1, 'CAdemo0001', now() - interval '22 minutes',
             now() - interval '19 minutes', 168, 'booked', false, 'human')
     returning id`,
    [leads.rows[0]!.id],
  )
  const bookedId = booked.rows[0]!.id

  await q(
    `insert into call_scores (call_id, agent_ms, prospect_ms, talk_ratio, agent_interruptions,
                              discovery_questions_asked, yielded_correctly)
     values ($1, 71000, 97000, 0.4226, 0, 4, true)`,
    [bookedId],
  )

  const slot = openSlots.rows[0]!
  await q('update slots set taken = true where id = $1', [slot.id])
  await q(
    `insert into meetings (call_id, lead_id, slot_id, starts_at) values ($1, $2, $3, $4)`,
    [bookedId, leads.rows[0]!.id, slot.id, slot.starts_at],
  )

  const script: [string, string][] = [
    ['agent', "Hi, is this Ali? My name's Sara, I'm calling from Northwind. Did I catch you at a bad time?"],
    ['prospect', "I'm in the middle of something. What is this about?"],
    ['agent', "Twenty seconds and I'll let you go. We work with food distributors on cutting cold-chain spoilage. Is that something that costs you anything today?"],
    ['prospect', 'It does, actually. We wrote off a fair bit last quarter.'],
    ['agent', 'What did that come down to — transit, or storage at the depot?'],
    ['prospect', 'Mostly transit. Our monitoring is basically a clipboard.'],
    ['agent', 'That tracks. Is fixing it on the list for this quarter, or is it a next-year problem?'],
    ['prospect', 'This quarter, if the numbers work. I would need to loop in our ops director.'],
    ['agent', 'Makes sense. Rather than me pitching at you now, would a short call with both of you be worth it?'],
    ['prospect', 'Go on then. Not Monday.'],
    ['agent', 'Tuesday afternoon suits? I have two in the afternoon.'],
    ['prospect', 'Two works.'],
    ['agent', "Booked. Tuesday at two, I'll send the invite to this number's email. Thanks for the time, Ali."],
  ]
  for (const [role, text] of script) {
    await q(
      `insert into transcript_turns (call_id, role, text, created_at)
       values ($1, $2, $3, now() - interval '20 minutes')`,
      [bookedId, role, text],
    )
  }

  // A call that hit an answering machine.
  await q(
    `insert into calls (lead_id, twilio_sid, started_at, ended_at, duration_s, disposition,
                        voicemail_dropped, amd_verdict)
     values ($1, 'CAdemo0002', now() - interval '1 hour', now() - interval '59 minutes', 24,
             'voicemail', true, 'machine_start')`,
    [leads.rows[1]!.id],
  )

  // A call where the agent talked too much and got refused. This is the row the
  // operator is supposed to notice.
  const refused = await q<{ id: string }>(
    `insert into calls (lead_id, twilio_sid, started_at, ended_at, duration_s, disposition,
                        voicemail_dropped, amd_verdict)
     values ($1, 'CAdemo0003', now() - interval '3 hours', now() - interval '3 hours' + interval '41 seconds',
             41, 'not_interested', false, 'human')
     returning id`,
    [leads.rows[2]!.id],
  )
  await q(
    `insert into call_scores (call_id, agent_ms, prospect_ms, talk_ratio, agent_interruptions,
                              discovery_questions_asked, yielded_correctly)
     values ($1, 29000, 8000, 0.7838, 3, 1, true)`,
    [refused.rows[0]!.id],
  )
  for (const [role, text] of [
    ['agent', "Hi Daniyal, Sara here from Northwind, we help textile manufacturers cut waste in their dye process and I wanted to walk you through how that works —"],
    ['prospect', 'Not interested.'],
    ['agent', "I understand, and I'd just say most people who tell me that haven't heard the part about the water savings, which for a plant your size is usually —"],
    ['prospect', 'I said no. Take me off your list.'],
    ['agent', "Of course. I won't call again. Thanks for your time."],
  ] as [string, string][]) {
    await q(
      `insert into transcript_turns (call_id, role, text, created_at)
       values ($1, $2, $3, now() - interval '3 hours')`,
      [refused.rows[0]!.id, role, text],
    )
  }

  const counts = await q<{ leads: string; calls: string; turns: string }>(
    `select (select count(*) from leads)::text as leads,
            (select count(*) from calls)::text as calls,
            (select count(*) from transcript_turns)::text as turns`,
  )
  console.log('seeded', counts.rows[0])
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
