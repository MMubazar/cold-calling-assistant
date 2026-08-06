drop table if exists call_scores, qualifications, meetings, transcript_turns, calls, slots, leads cascade;

create table leads (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  company     text,
  phone       text not null,
  notes       text,
  status      text not null default 'new',
  created_at  timestamptz not null default now()
);

create table slots (
  id           uuid primary key default gen_random_uuid(),
  starts_at    timestamptz not null,
  duration_min int not null default 30,
  taken        boolean not null default false
);

create table calls (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid not null references leads(id),
  twilio_sid        text unique,
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  duration_s        int,
  disposition       text,
  summary           text,
  next_step         text,
  voicemail_dropped boolean not null default false,
  amd_verdict       text
);

create table transcript_turns (
  id         bigserial primary key,
  call_id    uuid not null references calls(id) on delete cascade,
  role       text not null check (role in ('agent', 'prospect')),
  text       text not null,
  created_at timestamptz not null default now()
);

create index transcript_turns_call_idx on transcript_turns (call_id, id);

create table call_scores (
  call_id                  uuid primary key references calls(id) on delete cascade,
  agent_ms                 int not null,
  prospect_ms              int not null,
  talk_ratio               real not null,
  agent_interruptions      int not null,
  discovery_questions_asked int,
  objections               jsonb,
  yielded_correctly        boolean
);

create table qualifications (
  call_id          uuid primary key references calls(id) on delete cascade,
  need             text,
  timing           text,
  authority        text,
  current_solution text,
  score            int,
  raw              jsonb
);

create table meetings (
  id        uuid primary key default gen_random_uuid(),
  call_id   uuid not null unique references calls(id) on delete cascade,
  lead_id   uuid not null references leads(id),
  slot_id   uuid not null references slots(id),
  starts_at timestamptz not null,
  confirmed boolean not null default true
);
