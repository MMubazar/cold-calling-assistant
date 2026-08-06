# Phase 1 Runbook

This is the document the operator follows to make the first real phone call. It has not been
executed against a live phone in this environment — there are no Twilio credentials, no OpenAI
API key, and no phone available here. The two acceptance calls below ("Test call 1" and
"Test call 2") are the operator's to run.

## One-time setup

### 0. Postgres must be up

This machine runs Postgres as a private, user-owned cluster on **port 5470**, not the system
cluster on 5432 — the system cluster has no `sb` role and creating one needs sudo, which isn't
available. Check it's up:

```bash
pg_isready -h 127.0.0.1 -p 5470
```

If that fails (e.g. after a reboot), start it:

```bash
pg_ctl -D ~/.coldcall-pg -o "-p 5470 -k /tmp" start
```

If plain `psql` or `pg_ctl` isn't found or misbehaves, prepend the versioned binaries to `PATH`:

```bash
export PATH=/usr/lib/postgresql/16/bin:$PATH
```

A stopped cluster is the most likely first-run failure, and the symptom is confusing — `npm test`
and `npm run db:reset` fail with a plain connection-refused error that doesn't say "start
Postgres."

### 1. Create the database and apply the schema

If the `coldcall` and `coldcall_test` databases don't exist yet on the cluster:

```bash
createdb -h 127.0.0.1 -p 5470 -U sb coldcall
createdb -h 127.0.0.1 -p 5470 -U sb coldcall_test
```

Then apply the schema:

```bash
cd backend
npm run db:reset
```

That runs `psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -f db/schema.sql` (see `package.json`) —
it drops and recreates every table in `coldcall`, so don't run it against data you want to keep.
It only touches the `coldcall` database. The test suite expects `coldcall_test` to already have
the same schema (it truncates tables between tests but never creates them); apply it by hand the
same way if `coldcall_test` is freshly created:

```bash
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall_test -f db/schema.sql
```

Then seed some open meeting slots (the agent can't book a meeting without any):

```bash
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -c "insert into slots (starts_at) select generate_series(
  date_trunc('hour', now()) + interval '1 day',
  date_trunc('hour', now()) + interval '10 day', interval '4 hour');"
```

### 2. Generate placeholder voicemail audio

```bash
npx tsx scripts/make-voicemail.ts --synth
```

This writes `assets/voicemail.ulaw` — a 3-second 440 Hz tone (24000 bytes at 8kHz u-law), no
external dependencies required. A copy of this placeholder already exists in the repo. It's
enough to prove the voicemail-drop pipeline end to end for the first test call.

To use a real recorded message instead, you need `ffmpeg`, which is **not installed on this
machine**:

```bash
sudo apt install -y ffmpeg
ffmpeg -i my-message.m4a -ar 8000 -ac 1 -c:a pcm_s16le my-message.wav
npx tsx scripts/make-voicemail.ts my-message.wav
```

Install ffmpeg and do this before recording the real voicemail test call — the synthesized tone
is fine for pipeline verification but isn't a real message.

### 3. Fill in `.env`

```bash
cp .env.example .env
```

Then edit it. Notes on specific fields:

- `DATABASE_URL=postgres://sb@127.0.0.1:5470/coldcall`
- `TEST_DATABASE_URL=postgres://sb@127.0.0.1:5470/coldcall_test` — required by the test suite
  (see below).
- `VERIFIED_NUMBERS` must contain **only numbers you own**, comma-separated, E.164 format
  (e.g. `+15551234567,+15559876543`). This is the sole guard against calling anyone else —
  `isAllowed()` in `src/lib/allowlist.ts` rejects any destination not on this list before a
  Twilio call is ever placed. Do not put anyone else's number here.
- `OPENAI_REALTIME_MODEL` — if left blank the server falls back to `gpt-realtime-mini`
  (see `DEFAULT_REALTIME_MODEL` in `src/lib/env.ts`). Confirm whichever id you use against
  current provider documentation before the live call; a stale id fails at socket-open time
  with an opaque error (see the troubleshooting table).
- `VOICEMAIL_AUDIO_PATH=./assets/voicemail.ulaw`
- `PORT=8080`

## Every session

```bash
ngrok http 8080                      # terminal 1 — copy the https URL
# put that URL in .env as PUBLIC_BASE_URL
cd backend && npm start              # terminal 2
```

Recording stays **off** for these calls (Twilio call recording is not enabled anywhere in this
codebase). If a later phase turns it on, the agent's opener must disclose it — do not enable
recording silently.

### Webhook signatures

`ngrok` puts this server on the public internet, and `/amd` and `/status` are both destructive:
a forged `AnsweredBy=machine_start` would drop a voicemail over a live human conversation, and a
forged `/status` would claim the teardown so the real one silently discards the call's disposition
and scores. Both routes therefore validate Twilio's `x-twilio-signature` against
`TWILIO_AUTH_TOKEN` and return **403** on any mismatch.

Consequences for you:

- A hand-crafted `curl -X POST .../amd?callId=...` returns `403`. That is correct, not a bug.
  There is no way to fake a verdict by hand; use a real call.
- The signature covers the exact URL Twilio was told to call, which the server rebuilds from
  `PUBLIC_BASE_URL`. If `PUBLIC_BASE_URL` does not match the ngrok URL Twilio is actually hitting,
  **every** webhook 403s and calls will never be finalized. The log line is
  `[status] call=... rejected: bad Twilio signature` — if you see that after an ngrok restart, the
  stale `PUBLIC_BASE_URL` is the cause.

`POST /calls` is deliberately **not** signature-checked: it is the operator's own route, driven by
the curl commands below, and its guard is `VERIFIED_NUMBERS`.

### Operator console (optional but recommended)

A Next.js console lives in `frontend/`. It reads the same Postgres database and shows the lead
table, a live transcript, a talk-time band, and the call log; it dials by proxying to the backend
rather than talking to Twilio directly.

```bash
cd frontend
npm run dev        # http://localhost:3100
```

To populate it with demo data:

```bash
cd frontend
npm run seed
```

**Careful:** the backend test suite truncates `leads`, `calls`, and `slots` in its `beforeEach`
(see `backend/tests/db.test.ts`). If you run `npm test` in `backend/` after seeding the console,
the seed data is gone — re-run `npm run seed` in `frontend/` afterwards.

The console needs no tunnel of its own. Only the backend needs `ngrok`, because Twilio is the
only outside party that dials in; the console talks to the backend over plain `BACKEND_URL`
(defaults to `http://127.0.0.1:8080`) on your local machine.

The backend also exposes `GET /calls/:id/stats`, which the console polls for live talk-time
counters during a call (before `call_scores` is written at teardown). If the console's talk band
stays blank mid-call, that endpoint — and `BACKEND_URL` pointing at a reachable backend — is the
first thing to check.

## Test call 1 — answered, ending in a booked meeting

```bash
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -t -c "insert into leads (name, company, phone)
  values ('Test Lead', 'Test Co', '<your-number>') returning id;"

curl -s -X POST localhost:8080/calls \
  -H 'content-type: application/json' \
  -d '{"leadId":"<id from above>","to":"<your-number>"}' | jq
```

`<your-number>` must already be in `VERIFIED_NUMBERS` or the request returns `403`.

Answer the phone. Let the agent open, answer its discovery questions, raise one objection, then
agree to a meeting.

Then check the results:

```bash
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -c "select disposition, duration_s, amd_verdict, voicemail_dropped
  from calls order by started_at desc limit 1;"
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -c "select agent_ms, prospect_ms, round(talk_ratio::numeric, 2) as ratio,
  agent_interruptions from call_scores order by call_id desc limit 1;"
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -c "select role, text from transcript_turns
  where call_id = (select id from calls order by started_at desc limit 1) order by id;"
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -c "select starts_at from meetings order by id desc limit 1;"
```

**Pass criteria**

- `disposition` is `booked` and a `meetings` row exists.
- `agent_interruptions` is **0**. Anything above zero means `SILENCE_DURATION_MS` in
  `src/agent/playbook.ts` (currently `400` ms) is too low — raise it by 100 ms and call again.
- `talk_ratio` is between 0.40 and 0.60. Above 0.60 means the agent is pitching rather than
  discovering; tighten the playbook, not the code.
- The transcript reads as a real conversation with turns from both sides.

## Test call 2 — voicemail drop

Place the call the same way as above, and let it ring through to voicemail without answering.

```bash
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -c "select disposition, voicemail_dropped, amd_verdict
  from calls order by started_at desc limit 1;"
```

**Pass criteria:** `disposition` is `voicemail`, `voicemail_dropped` is true, and the recorded
message plays cleanly with no clipping at either end.

## Test call 3 — nobody answers

Place the call the same way and let it ring out without answering, or decline it. No media
stream ever opens, so there is no session to snapshot — Twilio's `/status` callback is what closes
the row out.

```bash
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -c "select disposition, duration_s, ended_at
  from calls order by started_at desc limit 1;"
```

**Pass criteria:** `disposition` is `no_answer` (or `failed` if Twilio reported `CallStatus=failed`,
e.g. an unroutable number), `ended_at` is set, and `duration_s` covers the ring time. A row left
with `ended_at` NULL is a bug, not an in-progress call — the console treats the most recent open
row as the live call, so an unfinalized one keeps the **Call** button disabled. (The console now
also ignores open rows older than ten minutes, so a stuck row degrades rather than bricking the
UI, but the row itself still needs finalizing.)

Every call is capped at **300 seconds** by Twilio's `timeLimit`; a call that reaches the ceiling
is hung up by Twilio and finalized through the same `/status` path.

## Expected first-run problem: AMD false positive

Answering your own phone with a flat "hello?" is the pattern machine detection most often
misfires on. When it happens you will see in the logs:

```
[amd] call=... verdict=machine_start
[voicemail] speech during playback; treating AMD verdict as a false positive
```

and `amd_verdict` will read `machine_start_false_positive`. That is the mitigation working, not
a bug. Count how often it fires:

```bash
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -c "select amd_verdict, count(*) from calls group by 1;"
```

**Known Phase 1 limitation:** after an aborted drop the model session has already been closed,
so the call stays connected but the agent does not resume speaking. Hang up and redial. Keeping
the model session alive through a false positive is Phase 2 work.

## Other things that will go wrong

| Symptom | Cause |
| --- | --- |
| `psql: error: connection to server ... failed` / `npm test` fails immediately | Postgres cluster on port 5470 isn't running. `pg_ctl -D ~/.coldcall-pg -o "-p 5470 -k /tmp" start`. |
| `npm test` refuses to run / errors about `TEST_DATABASE_URL` | The suite requires `TEST_DATABASE_URL` to be set and to name a database ending in `_test`, on purpose — the tests truncate tables and once wiped the app database. Run `TEST_DATABASE_URL=postgres://sb@127.0.0.1:5470/coldcall_test npm test`. |
| Console demo data disappeared after running backend tests | `backend/tests/db.test.ts` truncates `leads`/`calls`/`slots`. Re-run `npm run seed` in `frontend/`. |
| Twilio call connects then drops immediately | `PUBLIC_BASE_URL` stale after an ngrok restart. |
| Silence both ways | Audio format mismatch. Both sides must be `g711_ulaw`; never resample. |
| Agent talks over you constantly | `SILENCE_DURATION_MS` (in `src/agent/playbook.ts`) too low. Raise it. |
| Long pauses before the agent replies | Region mismatch, or the full rather than mini model tier. |
| `403` from `/calls` | Number is not in `VERIFIED_NUMBERS`. Working as designed. |
| `403` from a hand-crafted `POST /amd` or `POST /status` | Working as designed — see "Webhook signatures" below. |
| Socket opens then closes at once | Bad or stale `OPENAI_REALTIME_MODEL`. |
| Console's talk-time band stays blank mid-call | Backend not reachable at `BACKEND_URL`, or `GET /calls/:id/stats` isn't returning a live session — confirm the call is actually connected server-side. |
| `ffmpeg: command not found` | Not installed on this machine. `sudo apt install -y ffmpeg`, or use `npx tsx scripts/make-voicemail.ts --synth` instead. |
