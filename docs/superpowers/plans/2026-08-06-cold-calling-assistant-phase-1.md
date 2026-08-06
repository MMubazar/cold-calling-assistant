# Cold Calling Assistant — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone backend that dials a phone number, runs a full cold-call conversation with a realtime speech-to-speech model, books a meeting through a tool call, drops a voicemail when it hits an answering machine, and records exact talk-time accounting — triggered by `curl`.

**Architecture:** One Node process (`backend/`) serving HTTP and a WebSocket on the same port, exposed to Twilio through a single ngrok tunnel. Twilio Media Streams and the realtime model both speak `g711_ulaw` at 8 kHz, so the core is a base64 relay with barge-in handling. All conversation logic lives in `CallSession`, which is transport-agnostic — it takes a duplex message channel and a realtime client interface, so it is fully testable against fakes with no network and no phone.

**Tech Stack:** TypeScript, Node 20, `ws`, `twilio`, `pg`, `vitest`, local PostgreSQL 16, ngrok.

---

## Deviations from the spec

These are deliberate changes made after checking the local environment. Each is a simplification, not a scope cut.

1. **No Next.js in Phase 1.** The spec (§4) put the media WebSocket in a Next.js route on Vercel. Since nothing may be deployed (§12), Vercel's WebSocket runtime is never available, and Next's dev-server WebSocket support would be an unverified dependency inside the riskiest task. Phase 1 is a plain Node server. This matches the spec's own requirement that the handler be transport-agnostic, and removes a framework from the phase that carries all the technical risk.

2. **Frontend and backend are separate top-level folders** (`backend/`, `frontend/`), per the operator's instruction. `frontend/` is created empty in Phase 1 with a placeholder README; Phase 2 scaffolds Next.js into it and reads the same database.

3. **Twilio never contacts the frontend.** Only the backend needs a tunnel. One ngrok tunnel, one public URL.

4. **`VOICEMAIL_AUDIO_URL` becomes `VOICEMAIL_AUDIO_PATH`.** The message is read from disk and streamed as μ-law frames over the existing media socket rather than fetched by Twilio over HTTP. Fewer moving parts and it reuses the relay that already has to work.

5. **`prospect_ms` is measured between the model's VAD events, not from raw inbound frame count.** Twilio streams inbound audio continuously whether or not anyone is speaking, so counting all inbound frames would measure call duration, not prospect talk time, and would make `talk_ratio` (spec §8) meaningless. Inbound frames are counted only while the model reports prospect speech active. Same fix makes `agent_interruptions` exact rather than heuristic.

6. **The database runs as a user-owned cluster, not the system one.** The system Postgres has no `sb` role and creating one needs sudo, which is unavailable. A private cluster lives at `~/.coldcall-pg` on port 5470: `postgres://sb@127.0.0.1:5470/coldcall`, with `coldcall_test` alongside it for the test suite. Start it with `pg_ctl -D ~/.coldcall-pg -o "-p 5470 -k /tmp" start`.

7. **The call server exposes live audio counters over HTTP** (`GET /calls/:id/stats`, Task 11). `finalizeCall` writes scores only at teardown, so without this the console's talk band would sit blank for the whole call and only fill in after hangup — losing its main readout at the moment it matters. The endpoint reads the in-memory `AudioAccounting`, so the one-write-at-call-end constraint is untouched.

8. **The frontend was built during Phase 1, out of plan order,** while Task 5 was blocked on the database. It lives in `frontend/` (Next.js 15 App Router, handcrafted CSS) and reads the same cluster. Phases 2 and 3 still own the backend work that feeds it.

## Global Constraints

- Node 20.19.4 is the installed runtime. Do not use APIs requiring Node 22+.
- Audio format is `g711_ulaw`, 8000 Hz, mono, on **both** the Twilio and model sides. Never resample.
- One Twilio media frame is exactly 160 bytes of μ-law = **20 ms**. This constant underpins all audio accounting.
- `silence_duration_ms` starts at **400** (spec §5). It is a single named constant, never inlined.
- The agent must hold roughly 40–50% of talk time; above 60% it is pitching instead of discovering (spec §8).
- Outbound dialing is restricted to the `VERIFIED_NUMBERS` allowlist and rejected with **403** before any Twilio request (spec §3). This is not bypassable.
- Twilio call recording stays **off** (spec §14).
- No per-frame database writes. Counters accumulate in memory and are written once at call end (spec §9).
- `book_meeting` is synchronous and idempotent per call. `save_qualification` is fire-and-forget and its failures are logged and swallowed (spec §5, §10).
- **Every task runs `npm run typecheck` before committing, and it must be clean.** Passing tests are not sufficient: vitest transpiles without type-checking, so a type error can sit in a green suite indefinitely. Nine `noImplicitAny` errors accumulated across Tasks 7 and 9 for exactly this reason — the plan only gated typecheck at Task 11, and two tasks' worth of drift landed before anyone looked.
- **Database-touching tests read `TEST_DATABASE_URL`, never `DATABASE_URL`, and refuse to run if it is unset or names a database whose name does not end in `_test`.** These tests truncate tables; without this guard `npm test` silently destroys whatever the application database holds. Added after Task 5's review found the hazard had already fired once.
- Nothing is deployed, pushed, or published. Commits are local only.
- The realtime model id is read from `OPENAI_REALTIME_MODEL`. Never hardcode it — verify the current id against provider documentation before the acceptance call (spec §6).

---

## Prerequisites

Run these once before Task 1. Both were found missing or unconfigured on this machine.

- [ ] **P1: Create the PostgreSQL role and database**

`psql` 16.14 is installed and accepting connections on port 5432, but the role `sb` does not exist.

```bash
sudo -u postgres createuser --createdb --pwprompt sb
sudo -u postgres createdb -O sb coldcall
psql -d coldcall -c 'select current_user, current_database();'
```

Expected: a row showing `sb | coldcall`.

- [ ] **P2: Install ffmpeg (optional, for the voicemail recording only)**

`ffmpeg` is not installed. It is needed only to convert a recorded voicemail message into the raw format Task 10 requires. Task 10 also ships a synthesized fallback file, so this does not block any code or test.

```bash
sudo apt install -y ffmpeg
```

- [ ] **P3: Initialize git (local only)**

The project directory is not a git repository. Commits in this plan are local; nothing is ever pushed.

```bash
cd "/home/sb/Desktop/Practice Projects/Cold_Calling_Assistant"
git init
printf 'node_modules/\n.env\n*.log\nbackend/assets/voicemail.ulaw\n' > .gitignore
git add .gitignore docs
git commit -m "chore: init repo with design spec and phase 1 plan"
```

---

## File Structure

```
backend/
  package.json
  tsconfig.json
  vitest.config.ts
  .env.example
  db/schema.sql
  assets/                        voicemail.ulaw (gitignored, generated in Task 10)
  scripts/make-voicemail.ts      WAV -> μ-law converter + synthesized fallback
  src/
    lib/env.ts                   parse and validate process env          [pure]
    lib/allowlist.ts             E.164 normalization + allowlist check   [pure]
    lib/db.ts                    pg pool, typed query helpers
    media/twilio-frames.ts       parse/build Twilio socket messages      [pure]
    media/audio.ts               frame accounting, talk ratio            [pure]
    media/ulaw.ts                PCM16 -> μ-law encode, frame chunking   [pure]
    agent/playbook.ts            build model instructions from lead+slots [pure]
    agent/tools.ts               tool JSON schemas                       [pure]
    agent/tool-handlers.ts       tool execution against the database
    agent/realtime.ts            realtime model WebSocket client
    call/session.ts              CallSession orchestrator (transport-agnostic)
    call/teardown.ts             persist scores, disposition, transcript
    server.ts                    HTTP routes + WebSocket upgrade + Twilio REST
  tests/
    ... one file per module above
frontend/
  README.md                      placeholder; Phase 2 scaffolds here
```

Pure modules carry most of the test weight. `call/session.ts` is the only file with real complexity and gets the most thorough fake-driven tests.

---

### Task 1: Project scaffold

**Files:**
- Create: `backend/package.json`, `backend/tsconfig.json`, `backend/vitest.config.ts`, `backend/.env.example`, `frontend/README.md`
- Create: `backend/src/lib/env.ts`
- Test: `backend/tests/env.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadEnv(source: Record<string, string | undefined>): Env` and the `Env` interface, used by Task 11. Every field is required except `port` (default 8080) and `realtimeModel` (default from env or a documented fallback).

- [ ] **Step 1: Create the package manifest and configs**

`backend/package.json`:

```json
{
  "name": "coldcall-backend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "db:reset": "psql -d coldcall -f db/schema.sql"
  },
  "dependencies": {
    "pg": "^8.13.1",
    "twilio": "^5.4.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "@types/pg": "^8.11.10",
    "@types/ws": "^8.5.13",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`backend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"],
    "outDir": "dist"
  },
  "include": ["src", "tests", "scripts"]
}
```

`backend/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { globals: true, environment: 'node', include: ['tests/**/*.test.ts'] },
})
```

`frontend/README.md`:

```markdown
# Frontend (Phase 2)

Intentionally empty. Phase 1 is a backend-only, curl-driven system.
Phase 2 scaffolds Next.js here: lead table, one-click dial, SSE live transcript,
outcome cards, score display. It reads the same local PostgreSQL database as
`../backend` and reuses `backend/src/lib` types.
```

- [ ] **Step 2: Install dependencies**

```bash
cd backend && npm install
```

Expected: `node_modules/` created, no peer-dependency errors.

- [ ] **Step 3: Write the failing test for env loading**

`backend/tests/env.test.ts`:

```ts
import { loadEnv } from '../src/lib/env.js'

const complete = {
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_PHONE_NUMBER: '+15550001111',
  OPENAI_API_KEY: 'sk-x',
  DATABASE_URL: 'postgres://sb@localhost:5432/coldcall',
  VERIFIED_NUMBERS: '+923001234567, +15559998888',
  PUBLIC_BASE_URL: 'https://abc.ngrok.app',
  VOICEMAIL_AUDIO_PATH: './assets/voicemail.ulaw',
}

it('parses a complete environment', () => {
  const env = loadEnv(complete)
  expect(env.twilioAccountSid).toBe('AC123')
  expect(env.port).toBe(8080)
})

it('splits and trims the allowlist', () => {
  expect(loadEnv(complete).verifiedNumbers).toEqual(['+923001234567', '+15559998888'])
})

it('throws naming every missing variable at once', () => {
  const { OPENAI_API_KEY, DATABASE_URL, ...rest } = complete
  expect(() => loadEnv(rest)).toThrow(/OPENAI_API_KEY.*DATABASE_URL|DATABASE_URL.*OPENAI_API_KEY/)
})

it('rejects an empty allowlist so dialing can never be unrestricted', () => {
  expect(() => loadEnv({ ...complete, VERIFIED_NUMBERS: '  ' })).toThrow(/VERIFIED_NUMBERS/)
})

it('honors an overridden port and realtime model', () => {
  const env = loadEnv({ ...complete, PORT: '9001', OPENAI_REALTIME_MODEL: 'model-x' })
  expect(env.port).toBe(9001)
  expect(env.realtimeModel).toBe('model-x')
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd backend && npx vitest run tests/env.test.ts`
Expected: FAIL — cannot resolve `../src/lib/env.js`.

- [ ] **Step 5: Implement env loading**

`backend/src/lib/env.ts`:

```ts
export interface Env {
  twilioAccountSid: string
  twilioAuthToken: string
  twilioPhoneNumber: string
  openaiApiKey: string
  realtimeModel: string
  databaseUrl: string
  verifiedNumbers: string[]
  publicBaseUrl: string
  voicemailAudioPath: string
  port: number
}

const REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'OPENAI_API_KEY',
  'DATABASE_URL',
  'VERIFIED_NUMBERS',
  'PUBLIC_BASE_URL',
  'VOICEMAIL_AUDIO_PATH',
] as const

// Verify the current realtime model id against provider docs before any live call.
const DEFAULT_REALTIME_MODEL = 'gpt-realtime-mini'

export function loadEnv(source: Record<string, string | undefined>): Env {
  const missing = REQUIRED.filter((k) => !source[k]?.trim())
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  const verifiedNumbers = source
    .VERIFIED_NUMBERS!.split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0)

  if (verifiedNumbers.length === 0) {
    throw new Error('VERIFIED_NUMBERS must list at least one number; dialing is never unrestricted')
  }

  return {
    twilioAccountSid: source.TWILIO_ACCOUNT_SID!,
    twilioAuthToken: source.TWILIO_AUTH_TOKEN!,
    twilioPhoneNumber: source.TWILIO_PHONE_NUMBER!,
    openaiApiKey: source.OPENAI_API_KEY!,
    realtimeModel: source.OPENAI_REALTIME_MODEL?.trim() || DEFAULT_REALTIME_MODEL,
    databaseUrl: source.DATABASE_URL!,
    verifiedNumbers,
    publicBaseUrl: source.PUBLIC_BASE_URL!.replace(/\/$/, ''),
    voicemailAudioPath: source.VOICEMAIL_AUDIO_PATH!,
    port: Number(source.PORT ?? 8080),
  }
}
```

- [ ] **Step 6: Write `.env.example`**

`backend/.env.example`:

```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=+1...
OPENAI_API_KEY=
OPENAI_REALTIME_MODEL=
DATABASE_URL=postgres://sb@127.0.0.1:5470/coldcall
TEST_DATABASE_URL=postgres://sb@127.0.0.1:5470/coldcall_test
VERIFIED_NUMBERS=+92...
PUBLIC_BASE_URL=https://your-tunnel.ngrok.app
VOICEMAIL_AUDIO_PATH=./assets/voicemail.ulaw
PORT=8080
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && npm test`
Expected: 5 passing.

- [ ] **Step 8: Commit**

```bash
git add backend frontend
git commit -m "feat: backend scaffold with validated environment loading"
```

---

### Task 2: Phone number allowlist

**Files:**
- Create: `backend/src/lib/allowlist.ts`
- Test: `backend/tests/allowlist.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeE164(raw: string): string | null` and `isAllowed(raw: string, allowlist: string[]): boolean`, used by Task 11's `POST /calls`.

This is the scope guard from spec §3. It is small and it is the most important correctness boundary in the project.

- [ ] **Step 1: Write the failing tests**

`backend/tests/allowlist.test.ts`:

```ts
import { normalizeE164, isAllowed } from '../src/lib/allowlist.js'

const LIST = ['+923001234567', '+15559998888']

it('strips formatting characters', () => {
  expect(normalizeE164('+92 (300) 123-4567')).toBe('+923001234567')
})

it('rejects numbers without a leading plus', () => {
  expect(normalizeE164('923001234567')).toBeNull()
})

it('rejects implausible lengths', () => {
  expect(normalizeE164('+1234')).toBeNull()
  expect(normalizeE164('+1234567890123456')).toBeNull()
})

it('rejects letters', () => {
  expect(normalizeE164('+92300ABC4567')).toBeNull()
})

it('allows a listed number regardless of formatting', () => {
  expect(isAllowed('+92-300-123 4567', LIST)).toBe(true)
})

it('denies an unlisted number', () => {
  expect(isAllowed('+923009999999', LIST)).toBe(false)
})

it('denies unparseable input', () => {
  expect(isAllowed('not a phone', LIST)).toBe(false)
})

it('denies everything when the allowlist is empty', () => {
  expect(isAllowed('+923001234567', [])).toBe(false)
})

it('normalizes allowlist entries too, so formatting there cannot open a hole', () => {
  expect(isAllowed('+923001234567', ['+92 300 123 4567'])).toBe(true)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/allowlist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the allowlist**

`backend/src/lib/allowlist.ts`:

```ts
const E164 = /^\+[1-9]\d{7,14}$/

export function normalizeE164(raw: string): string | null {
  const stripped = raw.replace(/[\s()\-.]/g, '')
  return E164.test(stripped) ? stripped : null
}

export function isAllowed(raw: string, allowlist: string[]): boolean {
  const target = normalizeE164(raw)
  if (target === null) return false
  return allowlist.some((entry) => normalizeE164(entry) === target)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/allowlist.test.ts`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/allowlist.ts backend/tests/allowlist.test.ts
git commit -m "feat: E.164 normalization and dialing allowlist"
```

---

### Task 3: Twilio socket message codec

**Files:**
- Create: `backend/src/media/twilio-frames.ts`
- Test: `backend/tests/twilio-frames.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseTwilioMessage`, `mediaMessage`, `clearMessage`, `markMessage`, and the `TwilioInbound` union. Used by Tasks 9, 10, 11.

Twilio's inbound messages are nested (`start.customParameters`, `media.payload`). This module flattens them into a discriminated union so `CallSession` never touches raw JSON shapes. That separation is what makes Task 9 testable.

- [ ] **Step 1: Write the failing tests**

`backend/tests/twilio-frames.test.ts`:

```ts
import {
  parseTwilioMessage,
  mediaMessage,
  clearMessage,
  markMessage,
} from '../src/media/twilio-frames.js'

it('parses a start event and flattens custom parameters', () => {
  const raw = JSON.stringify({
    event: 'start',
    sequenceNumber: '1',
    streamSid: 'MZ111',
    start: {
      streamSid: 'MZ111',
      callSid: 'CA222',
      customParameters: { callId: 'call-abc' },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  })
  expect(parseTwilioMessage(raw)).toEqual({
    event: 'start',
    streamSid: 'MZ111',
    callSid: 'CA222',
    customParameters: { callId: 'call-abc' },
  })
})

it('parses a media event down to its payload', () => {
  const raw = JSON.stringify({
    event: 'media',
    streamSid: 'MZ111',
    media: { track: 'inbound', chunk: '5', timestamp: '100', payload: 'AAAA' },
  })
  expect(parseTwilioMessage(raw)).toEqual({ event: 'media', payload: 'AAAA', track: 'inbound' })
})

it('parses mark, stop, and connected events', () => {
  expect(parseTwilioMessage(JSON.stringify({ event: 'mark', mark: { name: 'vm-done' } })))
    .toEqual({ event: 'mark', name: 'vm-done' })
  expect(parseTwilioMessage(JSON.stringify({ event: 'stop' }))).toEqual({ event: 'stop' })
  expect(parseTwilioMessage(JSON.stringify({ event: 'connected' }))).toEqual({ event: 'connected' })
})

it('returns null for malformed JSON rather than throwing', () => {
  expect(parseTwilioMessage('{not json')).toBeNull()
})

it('returns null for unknown event types', () => {
  expect(parseTwilioMessage(JSON.stringify({ event: 'dtmf' }))).toBeNull()
})

it('returns null for a start event missing its callSid', () => {
  expect(parseTwilioMessage(JSON.stringify({ event: 'start', start: {} }))).toBeNull()
})

it('builds outbound media, clear, and mark messages', () => {
  expect(JSON.parse(mediaMessage('MZ111', 'BBBB'))).toEqual({
    event: 'media', streamSid: 'MZ111', media: { payload: 'BBBB' },
  })
  expect(JSON.parse(clearMessage('MZ111'))).toEqual({ event: 'clear', streamSid: 'MZ111' })
  expect(JSON.parse(markMessage('MZ111', 'vm-done'))).toEqual({
    event: 'mark', streamSid: 'MZ111', mark: { name: 'vm-done' },
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/twilio-frames.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the codec**

`backend/src/media/twilio-frames.ts`:

```ts
export type TwilioInbound =
  | { event: 'connected' }
  | { event: 'start'; streamSid: string; callSid: string; customParameters: Record<string, string> }
  | { event: 'media'; payload: string; track: string }
  | { event: 'mark'; name: string }
  | { event: 'stop' }

export function parseTwilioMessage(raw: string): TwilioInbound | null {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }

  switch (msg?.event) {
    case 'connected':
      return { event: 'connected' }
    case 'start': {
      const streamSid: unknown = msg.start?.streamSid ?? msg.streamSid
      const callSid: unknown = msg.start?.callSid
      if (typeof streamSid !== 'string' || typeof callSid !== 'string') return null
      return {
        event: 'start',
        streamSid,
        callSid,
        customParameters: msg.start?.customParameters ?? {},
      }
    }
    case 'media': {
      const payload: unknown = msg.media?.payload
      if (typeof payload !== 'string') return null
      return { event: 'media', payload, track: msg.media?.track ?? 'inbound' }
    }
    case 'mark': {
      const name: unknown = msg.mark?.name
      if (typeof name !== 'string') return null
      return { event: 'mark', name }
    }
    case 'stop':
      return { event: 'stop' }
    default:
      return null
  }
}

export function mediaMessage(streamSid: string, payloadB64: string): string {
  return JSON.stringify({ event: 'media', streamSid, media: { payload: payloadB64 } })
}

export function clearMessage(streamSid: string): string {
  return JSON.stringify({ event: 'clear', streamSid })
}

export function markMessage(streamSid: string, name: string): string {
  return JSON.stringify({ event: 'mark', streamSid, mark: { name } })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/twilio-frames.test.ts`
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/media/twilio-frames.ts backend/tests/twilio-frames.test.ts
git commit -m "feat: Twilio media stream message codec"
```

---

### Task 4: Audio accounting

**Files:**
- Create: `backend/src/media/audio.ts`
- Test: `backend/tests/audio.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FRAME_MS`, `ULAW_FRAME_BYTES`, `framesToMs`, `talkRatio`, and `class AudioAccounting` with methods `noteInboundFrame()`, `noteOutboundFrames(n)`, `noteProspectSpeechStart()`, `noteProspectSpeechStop()`, `noteAgentAudioStart()`, `snapshot()`. Used by Tasks 9 and 12.

This implements spec §8. The critical rule, and the reason this is its own tested module: **inbound frames count toward `prospectMs` only while the model reports prospect speech active.** Twilio streams inbound audio continuously, so counting every frame would measure wall-clock call duration and make `talkRatio` meaningless.

`agentInterruptions` increments when agent audio begins while the prospect is still speaking. This is the feedback signal for tuning `silence_duration_ms` (spec §5), so it must be exact, not estimated.

- [ ] **Step 1: Write the failing tests**

`backend/tests/audio.test.ts`:

```ts
import { AudioAccounting, framesToMs, talkRatio, FRAME_MS, ULAW_FRAME_BYTES } from '../src/media/audio.js'

it('pins the frame constants', () => {
  expect(FRAME_MS).toBe(20)
  expect(ULAW_FRAME_BYTES).toBe(160)
})

it('converts frames to milliseconds', () => {
  expect(framesToMs(50)).toBe(1000)
})

it('computes talk ratio', () => {
  expect(talkRatio(3000, 7000)).toBeCloseTo(0.3)
})

it('reports a zero talk ratio when no one spoke, rather than dividing by zero', () => {
  expect(talkRatio(0, 0)).toBe(0)
})

it('ignores inbound frames while the prospect is silent', () => {
  const a = new AudioAccounting()
  for (let i = 0; i < 100; i++) a.noteInboundFrame()
  expect(a.snapshot().prospectMs).toBe(0)
})

it('counts inbound frames only between prospect speech start and stop', () => {
  const a = new AudioAccounting()
  a.noteInboundFrame()               // silence, ignored
  a.noteProspectSpeechStart()
  for (let i = 0; i < 25; i++) a.noteInboundFrame()   // 500 ms of speech
  a.noteProspectSpeechStop()
  for (let i = 0; i < 40; i++) a.noteInboundFrame()   // silence, ignored
  expect(a.snapshot().prospectMs).toBe(500)
})

it('counts every outbound frame as agent speech', () => {
  const a = new AudioAccounting()
  a.noteOutboundFrames(10)
  a.noteOutboundFrames(5)
  expect(a.snapshot().agentMs).toBe(300)
})

it('counts an interruption when the agent starts while the prospect is speaking', () => {
  const a = new AudioAccounting()
  a.noteProspectSpeechStart()
  a.noteAgentAudioStart()
  expect(a.snapshot().agentInterruptions).toBe(1)
})

it('does not count an interruption when the prospect has stopped', () => {
  const a = new AudioAccounting()
  a.noteProspectSpeechStart()
  a.noteProspectSpeechStop()
  a.noteAgentAudioStart()
  expect(a.snapshot().agentInterruptions).toBe(0)
})

it('counts one interruption per agent start, not per frame', () => {
  const a = new AudioAccounting()
  a.noteProspectSpeechStart()
  a.noteAgentAudioStart()
  a.noteOutboundFrames(30)
  a.noteAgentAudioStart()
  expect(a.snapshot().agentInterruptions).toBe(2)
})

it('tolerates a stop event with no matching start', () => {
  const a = new AudioAccounting()
  a.noteProspectSpeechStop()
  a.noteInboundFrame()
  expect(a.snapshot().prospectMs).toBe(0)
})

it('reports talk ratio in the snapshot', () => {
  const a = new AudioAccounting()
  a.noteProspectSpeechStart()
  for (let i = 0; i < 50; i++) a.noteInboundFrame()   // 1000 ms
  a.noteProspectSpeechStop()
  a.noteOutboundFrames(50)                            // 1000 ms
  expect(a.snapshot().talkRatio).toBeCloseTo(0.5)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/audio.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement audio accounting**

`backend/src/media/audio.ts`:

```ts
export const FRAME_MS = 20
export const ULAW_FRAME_BYTES = 160

export function framesToMs(frames: number): number {
  return frames * FRAME_MS
}

export function talkRatio(agentMs: number, prospectMs: number): number {
  const total = agentMs + prospectMs
  return total === 0 ? 0 : agentMs / total
}

export interface AudioSnapshot {
  agentMs: number
  prospectMs: number
  talkRatio: number
  agentInterruptions: number
}

export class AudioAccounting {
  private prospectFrames = 0
  private agentFrames = 0
  private interruptions = 0
  private prospectSpeaking = false

  /** Counted only while the model reports prospect speech; Twilio streams silence continuously. */
  noteInboundFrame(): void {
    if (this.prospectSpeaking) this.prospectFrames += 1
  }

  noteOutboundFrames(count: number): void {
    this.agentFrames += count
  }

  noteProspectSpeechStart(): void {
    this.prospectSpeaking = true
  }

  noteProspectSpeechStop(): void {
    this.prospectSpeaking = false
  }

  noteAgentAudioStart(): void {
    if (this.prospectSpeaking) this.interruptions += 1
  }

  snapshot(): AudioSnapshot {
    const agentMs = framesToMs(this.agentFrames)
    const prospectMs = framesToMs(this.prospectFrames)
    return { agentMs, prospectMs, talkRatio: talkRatio(agentMs, prospectMs), agentInterruptions: this.interruptions }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/audio.test.ts`
Expected: 18 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/media/audio.ts backend/tests/audio.test.ts
git commit -m "feat: exact talk-time accounting from media frame counts"
```

---

### Task 5: Database schema and query layer

**Files:**
- Create: `backend/db/schema.sql`
- Create: `backend/src/lib/db.ts`
- Test: `backend/tests/db.test.ts`

**Interfaces:**
- Consumes: `Env` from Task 1.
- Produces: `createDb(databaseUrl: string): Db`. The `Db` interface exposes `query<T>(sql, params)`, `createCall`, `getLead`, `getOpenSlots`, `insertTranscriptTurn`, `takeSlot`, `getMeetingByCall`, `insertMeeting`, `upsertQualification`, `finalizeCall`, `close`. Used by Tasks 7, 11, 12.

The full schema from spec §9 is created now even though Phase 1 only writes part of it — the tables are cheap and Phase 2/3 need no migration.

- [ ] **Step 1: Write the schema**

`backend/db/schema.sql`:

```sql
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
```

The `unique` constraint on `meetings.call_id` is what makes `book_meeting` idempotent at the database level rather than only in application code.

- [ ] **Step 2: Apply the schema**

```bash
cd backend && npm run db:reset
psql -d coldcall -c '\dt'
```

Expected: seven tables listed.

- [ ] **Step 3: Write the failing test**

These tests hit the real local database. That is deliberate — the value here is verifying SQL, which a mock cannot do.

They also **truncate tables**, so they must never point at the application
database. The guard below is not optional: it is the difference between a test
run and silent data loss.

`backend/tests/db.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd backend && TEST_DATABASE_URL=postgres://sb@127.0.0.1:5470/coldcall_test npx vitest run tests/db.test.ts`
Expected: FAIL — module not found.

Also confirm the guard works: running without `TEST_DATABASE_URL` must fail with the
"TEST_DATABASE_URL is required" message rather than touching any database.

- [ ] **Step 5: Implement the query layer**

`backend/src/lib/db.ts`:

```ts
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && TEST_DATABASE_URL=postgres://sb@127.0.0.1:5470/coldcall_test npx vitest run tests/db.test.ts`
Expected: 11 passing.

- [ ] **Step 7: Seed bookable slots**

```bash
psql -d coldcall -c "insert into slots (starts_at) select generate_series(
  date_trunc('hour', now()) + interval '1 day',
  date_trunc('hour', now()) + interval '10 day',
  interval '4 hour');"
psql -d coldcall -c 'select count(*) from slots;'
```

Expected: a non-zero count.

- [ ] **Step 8: Commit**

```bash
git add backend/db backend/src/lib/db.ts backend/tests/db.test.ts
git commit -m "feat: postgres schema and typed query layer"
```

---

### Task 6: Agent playbook

**Files:**
- Create: `backend/src/agent/playbook.ts`
- Test: `backend/tests/playbook.test.ts`

**Interfaces:**
- Consumes: `Lead`, `Slot` from Task 5.
- Produces: `buildInstructions(input: PlaybookInput): string` and `SILENCE_DURATION_MS`. Used by Tasks 8, 9, 11.

This is spec §7. Slot availability is embedded in the instructions rather than fetched by a tool, because a mid-sentence tool round trip is dead air the prospect hears and a cold call's availability does not change during the call (spec §5, optimization 2).

- [ ] **Step 1: Write the failing tests**

`backend/tests/playbook.test.ts`:

```ts
import { buildInstructions, SILENCE_DURATION_MS } from '../src/agent/playbook.js'

const input = {
  lead: { id: 'l1', name: 'Ali Raza', company: 'Acme Foods', phone: '+923001234567' },
  slots: [
    { id: 's1', startsAt: new Date('2026-08-10T09:00:00Z') },
    { id: 's2', startsAt: new Date('2026-08-11T14:00:00Z') },
  ],
  agentName: 'Sara',
  companyName: 'Northwind',
}

it('starts endpointing at the tuned 400 ms default', () => {
  expect(SILENCE_DURATION_MS).toBe(400)
})

it('names the prospect and their company', () => {
  const out = buildInstructions(input)
  expect(out).toContain('Ali Raza')
  expect(out).toContain('Acme Foods')
})

it('embeds every available slot with its id so book_meeting can be called without a lookup', () => {
  const out = buildInstructions(input)
  expect(out).toContain('s1')
  expect(out).toContain('s2')
})

it('covers all four discovery areas', () => {
  const out = buildInstructions(input).toLowerCase()
  for (const area of ['need', 'timing', 'authority', 'current solution']) {
    expect(out).toContain(area)
  }
})

it('includes all five objections from the spec', () => {
  const out = buildInstructions(input).toLowerCase()
  for (const o of ['not interested', 'send me an email', 'already have', 'my number', 'who is this']) {
    expect(out).toContain(o)
  }
})

it('states the two-refusal yield rule', () => {
  expect(buildInstructions(input).toLowerCase()).toMatch(/two refusals|second refusal/)
})

it('instructs the agent to listen more than it talks', () => {
  expect(buildInstructions(input).toLowerCase()).toMatch(/listen more|more than half/)
})

it('handles a lead with no company', () => {
  const out = buildInstructions({ ...input, lead: { ...input.lead, company: null } })
  expect(out).toContain('Ali Raza')
  expect(out).not.toContain('null')
})

it('tells the agent to say there is no availability when the slot list is empty', () => {
  const out = buildInstructions({ ...input, slots: [] }).toLowerCase()
  expect(out).toMatch(/no open slots|no availability/)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/playbook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the playbook**

`backend/src/agent/playbook.ts`:

```ts
import type { Lead, Slot } from '../lib/db.js'

/** Spec §5: dominant latency term. Raise if agent_interruptions climbs. */
export const SILENCE_DURATION_MS = 400

export interface PlaybookInput {
  lead: Lead
  slots: Slot[]
  agentName: string
  companyName: string
}

function formatSlots(slots: Slot[]): string {
  if (slots.length === 0) {
    return 'There are no open slots. If they want to meet, say you have no availability on hand and will email options.'
  }
  return slots
    .map((s) => `- id=${s.id} — ${s.startsAt.toUTCString()}`)
    .join('\n')
}

export function buildInstructions({ lead, slots, agentName, companyName }: PlaybookInput): string {
  const who = lead.company ? `${lead.name} at ${lead.company}` : lead.name

  return `You are ${agentName}, a sales rep at ${companyName}, making an outbound cold call to ${who}.
Speak naturally and briefly. This is a phone call, not an essay. Never read a list aloud.

OPENER (keep under 15 seconds)
State your name and company, give one sentence on why you are calling, then ask permission to
continue: "Did I catch you at a bad time?" Do not pitch before they answer that.

DISCOVERY (ask, do not interrogate — one question at a time)
1. Need: what problem they have in this area today.
2. Timing: whether they are looking to change anything this quarter.
3. Authority: who else would weigh in on a decision like this.
4. Current solution: what they use now, if anything.
Listen more than you talk. You should be speaking less than half the time.
Call save_qualification as soon as you learn any of these — do not wait until the end.

OBJECTIONS — answer in one or two sentences, then ask one question to continue
- "Not interested": you have not said what it is yet; ask for 20 seconds to say the one thing
  that makes people take the meeting, then ask if it is relevant to them.
- "Send me an email": agree to send it, but ask the one question you need answered to make the
  email worth reading.
- "We already have a vendor": good — ask what they would change about it if they could.
- "How did you get my number": answer plainly and briefly. It is public business contact
  information. Do not be evasive; evasiveness ends calls.
- "Who is this": repeat your name and company clearly and slowly, then continue.

YIELD RULE
After two refusals, stop. Thank them for their time, say you will not call again, and call
end_call. Do not attempt a third time. This is not negotiable.

BOOKING
Once they show interest, propose one specific slot from the list below. Say the day and time in
natural language, never the id. When they agree, call book_meeting with that slot's id and then
confirm the day and time back to them out loud.

AVAILABLE SLOTS
${formatSlots(slots)}

ENDING
When the call is finished for any reason, call end_call. Never leave a call open.`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/playbook.test.ts`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/playbook.ts backend/tests/playbook.test.ts
git commit -m "feat: cold call playbook with embedded slot availability"
```

---

### Task 7: Tool schemas and handlers

**Files:**
- Create: `backend/src/agent/tools.ts`
- Create: `backend/src/agent/tool-handlers.ts`
- Test: `backend/tests/tool-handlers.test.ts`

**Interfaces:**
- Consumes: `Db`, `Slot`, `Meeting` from Task 5.
- Produces: `TOOL_SCHEMAS` (array passed verbatim to the model session) and
  `handleToolCall(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult>` where
  `ToolContext = { callId: string; leadId: string; slots: Slot[]; db: Db }` and
  `ToolResult = { output: unknown; endCall: boolean }`. Used by Task 9.

Behavior required by spec §5 and §10: `book_meeting` is synchronous and idempotent; `save_qualification` never surfaces a failure to the caller.

- [ ] **Step 1: Write the failing tests**

`backend/tests/tool-handlers.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/tool-handlers.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the tool schemas**

`backend/src/agent/tools.ts`:

```ts
export interface ToolSchema {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    name: 'book_meeting',
    description:
      'Reserve one of the slots listed in your instructions. Call this only after the prospect ' +
      'has verbally agreed to a specific time. Confirm the time out loud afterwards.',
    parameters: {
      type: 'object',
      properties: { slot_id: { type: 'string', description: 'The id of a slot from your instructions.' } },
      required: ['slot_id'],
    },
  },
  {
    type: 'function',
    name: 'save_qualification',
    description:
      'Record what you have learned about the prospect. Call this as soon as you learn anything, ' +
      'not at the end of the call. Send only the fields you actually learned.',
    parameters: {
      type: 'object',
      properties: {
        need: { type: 'string' },
        timing: { type: 'string' },
        authority: { type: 'string' },
        current_solution: { type: 'string' },
      },
    },
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'End the call. Call this after saying goodbye, or after a second refusal.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
]
```

- [ ] **Step 4: Implement the handlers**

`backend/src/agent/tool-handlers.ts`:

```ts
import type { Db, Slot } from '../lib/db.js'

export interface ToolContext { callId: string; leadId: string; slots: Slot[]; db: Db }
export interface ToolResult { output: unknown; endCall: boolean }

const BOOKING_FAILED = {
  booked: false,
  instruction: 'Booking failed. Do not claim the meeting is booked. Offer to follow up by email instead.',
}

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

  if (!(await ctx.db.takeSlot(slot.id))) {
    return { output: { ...BOOKING_FAILED, error: 'That slot was just taken.' }, endCall: false }
  }

  const meeting = await ctx.db.insertMeeting(ctx.callId, ctx.leadId, slot)
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/tool-handlers.test.ts`
Expected: 18 passing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/agent backend/tests/tool-handlers.test.ts
git commit -m "feat: agent tools with idempotent booking and fire-and-forget qualification"
```

---

### Task 8: Realtime model client

**Files:**
- Create: `backend/src/agent/realtime.ts`
- Test: `backend/tests/realtime.test.ts`

**Interfaces:**
- Consumes: `TOOL_SCHEMAS` (Task 7), `SILENCE_DURATION_MS` (Task 6).
- Produces:
  - `interface RealtimeClient` — `sendAudio(b64: string): void`, `sendToolResult(callId: string, output: unknown): void`, `cancelResponse(): void`, `on(handler: (e: RealtimeEvent) => void): void`, `close(): void`
  - `type RealtimeEvent` — the normalized union consumed by Task 9
  - `buildSessionUpdate(instructions: string): object` — pure, fully tested
  - `connectRealtime(opts): Promise<RealtimeClient>` — thin `ws` wrapper, not unit tested
  - `normalizeRealtimeEvent(raw: string): RealtimeEvent | null` — pure, fully tested

The session-config builder and the event normalizer are pure and carry the tests. The socket wrapper around them is deliberately thin so that nothing untestable holds logic.

- [ ] **Step 1: Write the failing tests**

`backend/tests/realtime.test.ts`:

```ts
import { buildSessionUpdate, normalizeRealtimeEvent } from '../src/agent/realtime.js'
import { SILENCE_DURATION_MS } from '../src/agent/playbook.js'

it('configures μ-law in both directions so no resampling is ever needed', () => {
  const s = buildSessionUpdate('INSTRUCTIONS') as any
  expect(s.session.input_audio_format).toBe('g711_ulaw')
  expect(s.session.output_audio_format).toBe('g711_ulaw')
})

it('uses the tuned silence duration', () => {
  const s = buildSessionUpdate('x') as any
  expect(s.session.turn_detection.silence_duration_ms).toBe(SILENCE_DURATION_MS)
})

it('enables server-side turn detection so we never write endpointing ourselves', () => {
  expect((buildSessionUpdate('x') as any).session.turn_detection.type).toBe('server_vad')
})

it('passes the instructions and all three tools', () => {
  const s = buildSessionUpdate('INSTRUCTIONS') as any
  expect(s.session.instructions).toBe('INSTRUCTIONS')
  expect(s.session.tools).toHaveLength(3)
})

it('requests transcription so transcript turns can be stored', () => {
  expect((buildSessionUpdate('x') as any).session.input_audio_transcription).toBeTruthy()
})

it('normalizes an audio delta', () => {
  const raw = JSON.stringify({ type: 'response.audio.delta', delta: 'QUJD' })
  expect(normalizeRealtimeEvent(raw)).toEqual({ kind: 'audio', payload: 'QUJD' })
})

it('normalizes prospect speech start and stop', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({ type: 'input_audio_buffer.speech_started' })))
    .toEqual({ kind: 'prospect_speech_started' })
  expect(normalizeRealtimeEvent(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' })))
    .toEqual({ kind: 'prospect_speech_stopped' })
})

it('normalizes a completed function call', () => {
  const raw = JSON.stringify({
    type: 'response.function_call_arguments.done',
    call_id: 'fc1', name: 'book_meeting', arguments: '{"slot_id":"s1"}',
  })
  expect(normalizeRealtimeEvent(raw)).toEqual({
    kind: 'tool_call', toolCallId: 'fc1', name: 'book_meeting', args: { slot_id: 's1' },
  })
})

it('treats unparseable tool arguments as empty rather than crashing the call', () => {
  const raw = JSON.stringify({
    type: 'response.function_call_arguments.done', call_id: 'fc1', name: 'end_call', arguments: '{{{',
  })
  expect(normalizeRealtimeEvent(raw)).toEqual({ kind: 'tool_call', toolCallId: 'fc1', name: 'end_call', args: {} })
})

it('normalizes transcripts from both sides', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed', transcript: 'who is this',
  }))).toEqual({ kind: 'transcript', role: 'prospect', text: 'who is this' })

  expect(normalizeRealtimeEvent(JSON.stringify({
    type: 'response.audio_transcript.done', transcript: 'Hi, this is Sara',
  }))).toEqual({ kind: 'transcript', role: 'agent', text: 'Hi, this is Sara' })
})

it('normalizes errors', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({ type: 'error', error: { message: 'bad' } })))
    .toEqual({ kind: 'error', message: 'bad' })
})

it('ignores unknown and malformed events', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({ type: 'rate_limits.updated' }))).toBeNull()
  expect(normalizeRealtimeEvent('nonsense')).toBeNull()
})

// This function is the boundary that keeps a malformed model event from killing
// a live call. Every hostile shape below is asserted, not merely reasoned about.

it('drops a tool call with no call_id — a result would have nowhere to go', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({
    type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}',
  }))).toBeNull()
})

it('drops a tool call with no name', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({
    type: 'response.function_call_arguments.done', call_id: 'fc1', arguments: '{}',
  }))).toBeNull()
})

it('treats absent tool arguments as empty rather than dropping the call', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({
    type: 'response.function_call_arguments.done', call_id: 'fc1', name: 'end_call',
  }))).toEqual({ kind: 'tool_call', toolCallId: 'fc1', name: 'end_call', args: {} })
})

it('ignores an audio delta whose payload is not a string', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({ type: 'response.audio.delta', delta: 42 })))
    .toBeNull()
})

it('ignores JSON that parses to something other than an object', () => {
  expect(normalizeRealtimeEvent('null')).toBeNull()
  expect(normalizeRealtimeEvent('42')).toBeNull()
  expect(normalizeRealtimeEvent('[1,2]')).toBeNull()
  expect(normalizeRealtimeEvent('"a string"')).toBeNull()
})

it('ignores an event whose type is not a string', () => {
  expect(normalizeRealtimeEvent(JSON.stringify({ type: 7 }))).toBeNull()
  expect(normalizeRealtimeEvent(JSON.stringify({ type: null }))).toBeNull()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/realtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the realtime client**

`backend/src/agent/realtime.ts`:

```ts
import WebSocket from 'ws'
import { TOOL_SCHEMAS } from './tools.js'
import { SILENCE_DURATION_MS } from './playbook.js'

export type RealtimeEvent =
  | { kind: 'audio'; payload: string }
  | { kind: 'prospect_speech_started' }
  | { kind: 'prospect_speech_stopped' }
  | { kind: 'tool_call'; toolCallId: string; name: string; args: Record<string, unknown> }
  | { kind: 'transcript'; role: 'agent' | 'prospect'; text: string }
  | { kind: 'response_done' }
  | { kind: 'error'; message: string }
  | { kind: 'closed' }

export interface RealtimeClient {
  sendAudio(b64: string): void
  sendToolResult(toolCallId: string, output: unknown): void
  cancelResponse(): void
  requestResponse(): void
  on(handler: (e: RealtimeEvent) => void): void
  close(): void
}

export function buildSessionUpdate(instructions: string): object {
  return {
    type: 'session.update',
    session: {
      modalities: ['audio', 'text'],
      instructions,
      voice: 'alloy',
      input_audio_format: 'g711_ulaw',
      output_audio_format: 'g711_ulaw',
      input_audio_transcription: { model: 'whisper-1' },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: SILENCE_DURATION_MS,
      },
      tools: TOOL_SCHEMAS,
      tool_choice: 'auto',
    },
  }
}

export function normalizeRealtimeEvent(raw: string): RealtimeEvent | null {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }

  switch (msg?.type) {
    case 'response.audio.delta':
      return typeof msg.delta === 'string' ? { kind: 'audio', payload: msg.delta } : null
    case 'input_audio_buffer.speech_started':
      return { kind: 'prospect_speech_started' }
    case 'input_audio_buffer.speech_stopped':
      return { kind: 'prospect_speech_stopped' }
    case 'response.function_call_arguments.done': {
      // A tool call with no id or name cannot be answered: the id is the address
      // a result is returned to. Drop it rather than emit an event whose declared
      // string fields are actually undefined — Task 9 echoes toolCallId straight
      // back to the model, so an undefined there strands the call silently.
      if (typeof msg.call_id !== 'string' || typeof msg.name !== 'string') return null

      let args: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(msg.arguments ?? '{}')
        if (parsed && typeof parsed === 'object') args = parsed
      } catch {
        args = {}
      }
      return { kind: 'tool_call', toolCallId: msg.call_id, name: msg.name, args }
    }
    case 'conversation.item.input_audio_transcription.completed':
      return { kind: 'transcript', role: 'prospect', text: msg.transcript ?? '' }
    case 'response.audio_transcript.done':
      return { kind: 'transcript', role: 'agent', text: msg.transcript ?? '' }
    case 'response.done':
      return { kind: 'response_done' }
    case 'error':
      return { kind: 'error', message: msg.error?.message ?? 'unknown realtime error' }
    default:
      return null
  }
}

export interface ConnectOptions {
  apiKey: string
  model: string
  instructions: string
}

export async function connectRealtime(opts: ConnectOptions): Promise<RealtimeClient> {
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(opts.model)}`,
    { headers: { Authorization: `Bearer ${opts.apiKey}`, 'OpenAI-Beta': 'realtime=v1' } },
  )

  const handlers: ((e: RealtimeEvent) => void)[] = []
  const emit = (e: RealtimeEvent) => handlers.forEach((h) => h(e))
  const send = (obj: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
  }

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })

  send(buildSessionUpdate(opts.instructions))
  ws.on('message', (data) => {
    const e = normalizeRealtimeEvent(data.toString())
    if (e) emit(e)
  })
  ws.on('close', () => emit({ kind: 'closed' }))
  ws.on('error', (err) => emit({ kind: 'error', message: String(err) }))

  return {
    sendAudio: (b64) => send({ type: 'input_audio_buffer.append', audio: b64 }),
    sendToolResult: (toolCallId, output) => {
      send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: toolCallId, output: JSON.stringify(output) },
      })
      send({ type: 'response.create' })
    },
    cancelResponse: () => send({ type: 'response.cancel' }),
    requestResponse: () => send({ type: 'response.create' }),
    on: (h) => { handlers.push(h) },
    close: () => ws.close(),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/realtime.test.ts`
Expected: 18 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/realtime.ts backend/tests/realtime.test.ts
git commit -m "feat: realtime model client with normalized event stream"
```

---

### Task 9: CallSession — relay and barge-in

**Files:**
- Create: `backend/src/call/session.ts`
- Test: `backend/tests/session.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3, 4, 6, 7, 8.
- Produces: `interface Transport` (`send`, `close`, `onMessage`, `onClose`), `class CallSession` with `handleTwilioMessage(raw)`, `end(reason)`, `result()`, and `onFinished(cb)`. Used by Tasks 10, 11, 12.

This is the only file with real complexity, and the entire technical risk of Phase 1. It takes a `Transport` and a `RealtimeClient` as constructor arguments, so every test below runs against fakes — no network, no phone, no Twilio account.

Barge-in requirement (spec §4): on `prospect_speech_started`, send Twilio a `clear` to flush queued playback **and** cancel the in-flight model response.

- [ ] **Step 1: Write the failing tests**

`backend/tests/session.test.ts`:

```ts
import { CallSession, type Transport } from '../src/call/session.js'
import type { RealtimeClient, RealtimeEvent } from '../src/agent/realtime.js'
import type { Db, Slot } from '../src/lib/db.js'

const SLOTS: Slot[] = [{ id: 's1', startsAt: new Date('2026-08-10T09:00:00Z') }]

function fakeTransport() {
  const sent: string[] = []
  let onMsg: (raw: string) => void = () => {}
  let onClose: () => void = () => {}
  const transport: Transport = {
    send: (raw) => { sent.push(raw) },
    close: () => { onClose() },
    onMessage: (cb) => { onMsg = cb },
    onClose: (cb) => { onClose = cb },
  }
  return { transport, sent, inject: (raw: string) => onMsg(raw), fireClose: () => onClose() }
}

function fakeRealtime() {
  const calls: string[] = []
  let handler: (e: RealtimeEvent) => void = () => {}
  const client: RealtimeClient = {
    sendAudio: (b64) => { calls.push(`audio:${b64}`) },
    sendToolResult: (id, out) => { calls.push(`toolresult:${id}:${JSON.stringify(out)}`) },
    cancelResponse: () => { calls.push('cancel') },
    requestResponse: () => { calls.push('response') },
    on: (h) => { handler = h },
    close: () => { calls.push('close') },
  }
  return { client, calls, emit: (e: RealtimeEvent) => handler(e) }
}

// Parameters are annotated because the `as unknown as Db` cast happens after the
// literal is built, so nothing contextually types these callbacks. Without the
// annotations `noImplicitAny` fails the typecheck.
function fakeDb(): Db {
  return {
    insertTranscriptTurn: async () => {},
    getMeetingByCall: async () => null,
    takeSlot: async () => true,
    insertMeeting: async (_c: string, _l: string, s: Slot) =>
      ({ id: 'm1', slotId: s.id, startsAt: s.startsAt }),
    upsertQualification: async () => {},
  } as unknown as Db
}

function startMessage(callId = 'call-1') {
  return JSON.stringify({
    event: 'start',
    streamSid: 'MZ1',
    start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { callId } },
  })
}

const mediaMsg = (payload: string) =>
  JSON.stringify({ event: 'media', streamSid: 'MZ1', media: { track: 'inbound', payload } })

function build() {
  const t = fakeTransport()
  const r = fakeRealtime()
  const session = new CallSession({
    transport: t.transport,
    realtime: r.client,
    db: fakeDb(),
    callId: 'call-1',
    leadId: 'lead-1',
    slots: SLOTS,
    voicemailFrames: ['VM1', 'VM2'],
  })
  return { session, t, r }
}

it('forwards inbound media to the model', () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  t.inject(mediaMsg('AAAA'))
  expect(r.calls).toContain('audio:AAAA')
})

it('ignores media that arrives before the start event', () => {
  const { t, r } = build()
  t.inject(mediaMsg('AAAA'))
  expect(r.calls).not.toContain('audio:AAAA')
})

it('relays model audio back to Twilio as a media message on the right stream', () => {
  const { t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'audio', payload: 'BBBB' })
  const parsed = t.sent.map((s) => JSON.parse(s))
  expect(parsed).toEqual(expect.arrayContaining([
    { event: 'media', streamSid: 'MZ1', media: { payload: 'BBBB' } },
  ]))
})

it('on barge-in sends a clear to Twilio AND cancels the model response', () => {
  const { t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'audio', payload: 'BBBB' })
  r.emit({ kind: 'prospect_speech_started' })
  expect(t.sent.map((s) => JSON.parse(s).event)).toContain('clear')
  expect(r.calls).toContain('cancel')
})

it('does not send a clear when the agent was not speaking', () => {
  const { t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'prospect_speech_started' })
  expect(t.sent.map((s) => JSON.parse(s).event)).not.toContain('clear')
})

it('counts an interruption when model audio starts while the prospect is speaking', () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'prospect_speech_started' })
  r.emit({ kind: 'audio', payload: 'BBBB' })
  expect(session.result().audio.agentInterruptions).toBe(1)
})

it('counts prospect speech only between speech start and stop', () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  t.inject(mediaMsg('X'))                    // silence, not counted
  r.emit({ kind: 'prospect_speech_started' })
  t.inject(mediaMsg('X'))
  t.inject(mediaMsg('X'))                    // 40 ms counted
  r.emit({ kind: 'prospect_speech_stopped' })
  t.inject(mediaMsg('X'))                    // silence, not counted
  expect(session.result().audio.prospectMs).toBe(40)
})

it('executes a tool call and returns its result to the model', async () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'tool_call', toolCallId: 'fc1', name: 'book_meeting', args: { slot_id: 's1' } })
  await session.settled()
  expect(r.calls.find((c) => c.startsWith('toolresult:fc1'))).toMatch(/"booked":true/)
})

it('sets disposition booked when a meeting is booked', async () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'tool_call', toolCallId: 'fc1', name: 'book_meeting', args: { slot_id: 's1' } })
  await session.settled()
  expect(session.result().disposition).toBe('booked')
})

it('closes the call when end_call is invoked', async () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'tool_call', toolCallId: 'fc1', name: 'end_call', args: { reason: 'refused twice' } })
  await session.settled()
  expect(r.calls).toContain('close')
  expect(session.result().disposition).toBe('not_interested')
})

it('stores transcript turns for both sides', async () => {
  const stored: [string, string][] = []
  const t = fakeTransport()
  const r = fakeRealtime()
  const session = new CallSession({
    transport: t.transport, realtime: r.client, callId: 'c', leadId: 'l', slots: SLOTS,
    voicemailFrames: [],
    db: {
      insertTranscriptTurn: async (_c: string, role: 'agent' | 'prospect', text: string) => {
        stored.push([role, text])
      },
    } as unknown as Db,
  })
  t.inject(startMessage())
  r.emit({ kind: 'transcript', role: 'agent', text: 'Hi, this is Sara' })
  r.emit({ kind: 'transcript', role: 'prospect', text: 'Who is this' })
  await session.settled()
  expect(stored).toEqual([['agent', 'Hi, this is Sara'], ['prospect', 'Who is this']])
})

it('ignores empty transcripts', async () => {
  const stored: unknown[] = []
  const t = fakeTransport()
  const r = fakeRealtime()
  const session = new CallSession({
    transport: t.transport, realtime: r.client, callId: 'c', leadId: 'l', slots: SLOTS,
    voicemailFrames: [],
    db: { insertTranscriptTurn: async () => { stored.push(1) } } as unknown as Db,
  })
  t.inject(startMessage())
  r.emit({ kind: 'transcript', role: 'agent', text: '   ' })
  await session.settled()
  expect(stored).toHaveLength(0)
})

it('marks disposition failed when the model session errors out', () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'error', message: 'session died' })
  expect(session.result().disposition).toBe('failed')
})

it('finishes on the Twilio stop event and notifies listeners exactly once', () => {
  const { session, t } = build()
  let finished = 0
  session.onFinished(() => { finished++ })
  t.inject(startMessage())
  t.inject(JSON.stringify({ event: 'stop' }))
  t.fireClose()
  expect(finished).toBe(1)
})

it('ignores malformed Twilio messages without throwing', () => {
  const { session, t } = build()
  expect(() => { t.inject('{broken'); t.inject(JSON.stringify({ event: 'dtmf' })) }).not.toThrow()
  expect(session.result().disposition).toBe('failed')
})

// A booked meeting exists in the database. Nothing that happens afterwards may
// cause the call to be recorded as anything other than booked.
it('keeps disposition booked when end_call follows a successful booking', async () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'tool_call', toolCallId: 'fc1', name: 'book_meeting', args: { slot_id: 's1' } })
  await session.settled()
  r.emit({ kind: 'tool_call', toolCallId: 'fc2', name: 'end_call', args: { reason: 'done' } })
  await session.settled()
  expect(session.result().disposition).toBe('booked')
})

it('keeps disposition booked when the model session errors after a booking', async () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'tool_call', toolCallId: 'fc1', name: 'book_meeting', args: { slot_id: 's1' } })
  await session.settled()
  r.emit({ kind: 'error', message: 'socket died' })
  expect(session.result().disposition).toBe('booked')
})

it('sends nothing to Twilio when model audio arrives before the start event', () => {
  const { session, t, r } = build()
  r.emit({ kind: 'audio', payload: 'BBBB' })
  expect(t.sent).toEqual([])
  expect(session.result().audio.agentMs).toBe(0)
})

it('does not count an empty audio delta as 20 ms of speech', () => {
  const { session, t, r } = build()
  t.inject(startMessage())
  r.emit({ kind: 'audio', payload: '' })
  expect(session.result().audio.agentMs).toBe(0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement CallSession**

`backend/src/call/session.ts`:

```ts
import { parseTwilioMessage, mediaMessage, clearMessage, markMessage } from '../media/twilio-frames.js'
import { AudioAccounting, type AudioSnapshot, ULAW_FRAME_BYTES } from '../media/audio.js'
import { handleToolCall } from '../agent/tool-handlers.js'
import type { RealtimeClient, RealtimeEvent } from '../agent/realtime.js'
import type { Db, Slot } from '../lib/db.js'

export interface Transport {
  send(raw: string): void
  close(): void
  onMessage(cb: (raw: string) => void): void
  onClose(cb: () => void): void
}

export interface CallSessionOptions {
  transport: Transport
  realtime: RealtimeClient
  db: Db
  callId: string
  leadId: string
  slots: Slot[]
  /** Base64 μ-law frames of the recorded voicemail message (Task 10). */
  voicemailFrames: string[]
}

export interface CallResult {
  disposition: string
  audio: AudioSnapshot
  voicemailDropped: boolean
  amdVerdict: string | null
}

/** Default until something better is proven; a call that connects and ends unremarkably is a failure to advance. */
const DEFAULT_DISPOSITION = 'failed'

export class CallSession {
  private readonly opts: CallSessionOptions
  private readonly audio = new AudioAccounting()
  private readonly pending: Promise<unknown>[] = []
  private readonly finishedHandlers: (() => void)[] = []

  private streamSid: string | null = null
  private started = false
  private finished = false
  private agentSpeaking = false
  // Prospect speech state lives in AudioAccounting, which is what consumes it.
  // Duplicating it here would be a second source of truth for the same fact.
  private disposition = DEFAULT_DISPOSITION
  private voicemailDropped = false
  private amdVerdict: string | null = null
  private mode: 'conversation' | 'voicemail' = 'conversation'

  constructor(opts: CallSessionOptions) {
    this.opts = opts
    opts.transport.onMessage((raw) => this.handleTwilioMessage(raw))
    opts.transport.onClose(() => this.finish())
    opts.realtime.on((e) => this.handleRealtimeEvent(e))
  }

  handleTwilioMessage(raw: string): void {
    const msg = parseTwilioMessage(raw)
    if (msg === null) return

    switch (msg.event) {
      case 'start':
        this.streamSid = msg.streamSid
        this.started = true
        return
      case 'media':
        if (!this.started) return
        this.audio.noteInboundFrame()
        if (this.mode === 'voicemail') {
          // A human interrupting a voicemail message means AMD misfired (spec §7).
          this.abortVoicemailDrop()
          return
        }
        this.opts.realtime.sendAudio(msg.payload)
        return
      case 'mark':
        // Guard on the mode: a mark already in flight when an abort fires would
        // otherwise hang up on the human the abort just decided to keep.
        if (msg.name === 'voicemail-complete' && this.mode === 'voicemail') {
          this.end('voicemail')
        }
        return
      case 'stop':
        this.finish()
        return
      case 'connected':
        return
    }
  }

  private handleRealtimeEvent(e: RealtimeEvent): void {
    if (this.mode === 'voicemail') return

    switch (e.kind) {
      case 'audio':
        this.sendAgentAudio(e.payload)
        return

      case 'prospect_speech_started':
        this.audio.noteProspectSpeechStart()
        // Barge-in: flush what Twilio has queued, then stop the model mid-response.
        if (this.agentSpeaking) {
          // Cancelling the model does not depend on having a stream; sending to
          // Twilio does.
          if (this.streamSid !== null) this.sendToTwilio(clearMessage(this.streamSid))
          this.opts.realtime.cancelResponse()
          this.agentSpeaking = false
        }
        return

      case 'prospect_speech_stopped':
        this.audio.noteProspectSpeechStop()
        return

      case 'response_done':
        this.agentSpeaking = false
        return

      case 'transcript':
        if (e.text.trim().length > 0) {
          this.track(this.opts.db.insertTranscriptTurn(this.opts.callId, e.role, e.text.trim()))
        }
        return

      case 'tool_call':
        this.track(this.runTool(e.toolCallId, e.name, e.args))
        return

      case 'error':
        console.error('[session] realtime error', e.message)
        // Do NOT set this.disposition here. end()'s guard exists to stop a
        // default close from clobbering a real outcome; pre-setting the field
        // defeats it, and a call that booked a meeting would persist as failed.
        this.end('failed')
        return

      case 'closed':
        this.finish()
        return
    }
  }

  private sendAgentAudio(payloadB64: string): void {
    // Symmetric to the inbound guard in handleTwilioMessage. Without a streamSid
    // there is no stream to route this to and Twilio discards the frame in
    // silence, so drop it here rather than pretend it was delivered.
    if (!this.started || this.streamSid === null) return

    const bytes = Buffer.from(payloadB64, 'base64').length
    if (bytes === 0) return // an empty delta is not 20 ms of speech

    if (!this.agentSpeaking) {
      this.agentSpeaking = true
      this.audio.noteAgentAudioStart()
    }
    this.audio.noteOutboundFrames(Math.ceil(bytes / ULAW_FRAME_BYTES))
    this.sendToTwilio(mediaMessage(this.streamSid, payloadB64))
  }

  private async runTool(toolCallId: string, name: string, args: Record<string, unknown>): Promise<void> {
    const res = await handleToolCall(name, args, {
      callId: this.opts.callId,
      leadId: this.opts.leadId,
      slots: this.opts.slots,
      db: this.opts.db,
    })

    if (name === 'book_meeting' && (res.output as any)?.booked === true) {
      this.disposition = 'booked'
    }

    this.opts.realtime.sendToolResult(toolCallId, res.output)

    if (res.endCall) {
      if (this.disposition === DEFAULT_DISPOSITION) this.disposition = 'not_interested'
      this.end(this.disposition)
    }
  }

  /** Overridden behavior lives in Task 10; declared here so the state machine is complete. */
  protected abortVoicemailDrop(): void {
    this.mode = 'conversation'
    this.voicemailDropped = false
  }

  protected setVoicemailMode(verdict: string): void {
    this.mode = 'voicemail'
    this.amdVerdict = verdict
    this.voicemailDropped = true
  }

  protected get streamSidOrEmpty(): string {
    return this.streamSid ?? ''
  }

  protected sendToTwilio(raw: string): void {
    this.opts.transport.send(raw)
  }

  protected sendMark(name: string): void {
    this.sendToTwilio(markMessage(this.streamSid ?? '', name))
  }

  private track(p: Promise<unknown>): void {
    this.pending.push(p.catch((err) => console.error('[session] background task failed', err)))
  }

  /** Resolves once all in-flight background work (tool calls, transcript writes) has settled. */
  async settled(): Promise<void> {
    await Promise.all(this.pending)
  }

  end(disposition: string): void {
    if (disposition !== DEFAULT_DISPOSITION || this.disposition === DEFAULT_DISPOSITION) {
      this.disposition = disposition
    }
    this.opts.realtime.close()
    this.opts.transport.close()
    this.finish()
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    this.finishedHandlers.forEach((h) => h())
  }

  onFinished(cb: () => void): void {
    this.finishedHandlers.push(cb)
  }

  result(): CallResult {
    return {
      disposition: this.disposition,
      audio: this.audio.snapshot(),
      voicemailDropped: this.voicemailDropped,
      amdVerdict: this.amdVerdict,
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/session.test.ts`
Expected: 19 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/call/session.ts backend/tests/session.test.ts
git commit -m "feat: transport-agnostic call session with barge-in and tool execution"
```

---

### Task 10: Voicemail drop

**Files:**
- Create: `backend/src/media/ulaw.ts`
- Create: `backend/scripts/make-voicemail.ts`
- Modify: `backend/src/call/session.ts` — add `applyAmdVerdict` and voicemail playback
- Test: `backend/tests/ulaw.test.ts`, `backend/tests/voicemail.test.ts`

**Interfaces:**
- Consumes: `CallSession` (Task 9), `ULAW_FRAME_BYTES` (Task 4).
- Produces: `encodePcm16ToUlaw(samples: Int16Array): Buffer`, `chunkUlawToFrames(buf: Buffer): string[]`, `loadVoicemailFrames(path: string): Promise<string[]>`, and `CallSession.applyAmdVerdict(verdict: string): void`. Used by Task 11.

This is spec §7. The false-positive abort is the part most likely to matter on the first real call — the operator will answer their own phone with a flat "hello?", which is exactly what machine detection misfires on.

- [ ] **Step 1: Write the failing μ-law tests**

`backend/tests/ulaw.test.ts`:

```ts
import {
  encodePcm16ToUlaw,
  chunkUlawToFrames,
  decodeUlawByte,
  frameEnergy,
  SPEECH_ENERGY_THRESHOLD,
} from '../src/media/ulaw.js'
import { ULAW_FRAME_BYTES } from '../src/media/audio.js'

it('encodes one μ-law byte per PCM sample', () => {
  expect(encodePcm16ToUlaw(new Int16Array(320)).length).toBe(320)
})

it('encodes silence to the μ-law silence byte', () => {
  expect(encodePcm16ToUlaw(new Int16Array([0]))[0]).toBe(0xff)
})

it('encodes positive and negative peaks to different bytes', () => {
  const [hi] = encodePcm16ToUlaw(new Int16Array([32000]))
  const [lo] = encodePcm16ToUlaw(new Int16Array([-32000]))
  expect(hi).not.toBe(lo)
})

it('splits a buffer into 160-byte frames', () => {
  const frames = chunkUlawToFrames(Buffer.alloc(ULAW_FRAME_BYTES * 3))
  expect(frames).toHaveLength(3)
  expect(Buffer.from(frames[0]!, 'base64').length).toBe(ULAW_FRAME_BYTES)
})

it('pads a trailing partial frame to a full frame', () => {
  const frames = chunkUlawToFrames(Buffer.alloc(ULAW_FRAME_BYTES + 40))
  expect(frames).toHaveLength(2)
  expect(Buffer.from(frames[1]!, 'base64').length).toBe(ULAW_FRAME_BYTES)
})

it('returns no frames for an empty buffer', () => {
  expect(chunkUlawToFrames(Buffer.alloc(0))).toEqual([])
})

it('decodes a μ-law byte back to its original sample', () => {
  for (const sample of [0, 100, -100, 5000, -5000, 30000, -30000]) {
    const [byte] = encodePcm16ToUlaw(new Int16Array([sample]))
    const decoded = decodeUlawByte(byte!)
    // μ-law is lossy by design; 4 % of full scale is well inside its error band.
    expect(Math.abs(decoded - sample)).toBeLessThan(1300)
    expect(Math.sign(decoded)).toBe(Math.sign(sample))
  }
})

it('reports zero energy for a silent frame', () => {
  const silence = encodePcm16ToUlaw(new Int16Array(160)).toString('base64')
  expect(frameEnergy(silence)).toBeLessThan(SPEECH_ENERGY_THRESHOLD)
})

it('reports energy above the speech threshold for a loud frame', () => {
  const loud = new Int16Array(160)
  for (let i = 0; i < loud.length; i++) loud[i] = i % 2 === 0 ? 8000 : -8000
  expect(frameEnergy(encodePcm16ToUlaw(loud).toString('base64')))
    .toBeGreaterThan(SPEECH_ENERGY_THRESHOLD)
})

it('reports zero energy for an empty payload', () => {
  expect(frameEnergy('')).toBe(0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/ulaw.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the μ-law encoder**

`backend/src/media/ulaw.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { ULAW_FRAME_BYTES } from './audio.js'

const BIAS = 0x84
const CLIP = 32635

/** Standard G.711 μ-law encoder. One byte out per 16-bit sample in. */
export function encodePcm16ToUlaw(samples: Int16Array): Buffer {
  const out = Buffer.alloc(samples.length)
  for (let i = 0; i < samples.length; i++) {
    let sample = samples[i]!
    const sign = sample < 0 ? 0x80 : 0x00
    if (sample < 0) sample = -sample
    if (sample > CLIP) sample = CLIP
    sample += BIAS

    let exponent = 7
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--

    const mantissa = (sample >> (exponent + 3)) & 0x0f
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff
  }
  return out
}

/** Base64 frames of exactly 20 ms each. A trailing partial frame is padded with μ-law silence. */
export function chunkUlawToFrames(buf: Buffer): string[] {
  const frames: string[] = []
  for (let offset = 0; offset < buf.length; offset += ULAW_FRAME_BYTES) {
    const slice = buf.subarray(offset, offset + ULAW_FRAME_BYTES)
    if (slice.length === ULAW_FRAME_BYTES) {
      frames.push(slice.toString('base64'))
    } else {
      const padded = Buffer.alloc(ULAW_FRAME_BYTES, 0xff)
      slice.copy(padded)
      frames.push(padded.toString('base64'))
    }
  }
  return frames
}

/** Decode one μ-law byte back to a 16-bit sample. Inverse of the encoder above. */
export function decodeUlawByte(byte: number): number {
  const u = ~byte & 0xff
  const sign = u & 0x80
  const exponent = (u >> 4) & 0x07
  const mantissa = u & 0x0f
  const sample = (((mantissa << 3) + BIAS) << exponent) - BIAS
  return sign ? -sample : sample
}

/**
 * Mean absolute amplitude of one base64 μ-law frame, 0–32635.
 *
 * This exists because Twilio streams inbound audio continuously whether or not
 * anyone is speaking (see media/audio.ts). During a voicemail drop the model
 * session is closed, so there is no VAD to consult — "a frame arrived" cannot
 * stand in for "a human spoke", and energy is the only signal left.
 */
export function frameEnergy(payloadB64: string): number {
  const buf = Buffer.from(payloadB64, 'base64')
  if (buf.length === 0) return 0
  let total = 0
  for (const byte of buf) total += Math.abs(decodeUlawByte(byte))
  return total / buf.length
}

/**
 * Mean amplitude above which a frame counts as sound rather than line noise.
 * Tune against real calls; the runbook says how.
 */
export const SPEECH_ENERGY_THRESHOLD = 500

/** Consecutive loud frames required before believing a human is there: 200 ms. */
export const SPEECH_FRAMES_TO_ABORT = 10

export async function loadVoicemailFrames(path: string): Promise<string[]> {
  try {
    return chunkUlawToFrames(await readFile(path))
  } catch (err) {
    console.error(`[voicemail] could not read ${path}; voicemail drop disabled`, err)
    return []
  }
}
```

- [ ] **Step 4: Write the voicemail generator script**

`backend/scripts/make-voicemail.ts`:

```ts
/**
 * Build assets/voicemail.ulaw.
 *
 *   npx tsx scripts/make-voicemail.ts --synth
 *       Generates a 3-second 440 Hz tone. Proves the pipeline end to end
 *       without needing a recording. Use for the first test call.
 *
 *   npx tsx scripts/make-voicemail.ts recording.wav
 *       Converts a 16-bit mono 8 kHz PCM WAV. If your recording is any other
 *       format, convert it first:
 *         ffmpeg -i recording.m4a -ar 8000 -ac 1 -c:a pcm_s16le recording.wav
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { encodePcm16ToUlaw } from '../src/media/ulaw.js'

const OUT = 'assets/voicemail.ulaw'
const SAMPLE_RATE = 8000

function synthTone(seconds: number): Int16Array {
  const samples = new Int16Array(SAMPLE_RATE * seconds)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 8000)
  }
  return samples
}

function parseWav(buf: Buffer): Int16Array {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }
  let offset = 12
  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      const channels = buf.readUInt16LE(offset + 10)
      const rate = buf.readUInt32LE(offset + 12)
      const bits = buf.readUInt16LE(offset + 22)
      if (channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) {
        throw new Error(
          `Need 16-bit mono 8000 Hz, got ${bits}-bit ${channels}ch ${rate}Hz. ` +
          'Convert with: ffmpeg -i in.wav -ar 8000 -ac 1 -c:a pcm_s16le out.wav',
        )
      }
    }
    if (id === 'data') {
      const pcm = buf.subarray(offset + 8, offset + 8 + size)
      return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('No data chunk found')
}

const arg = process.argv[2]
const samples = arg === '--synth' || arg === undefined
  ? synthTone(3)
  : parseWav(await readFile(arg))

await mkdir('assets', { recursive: true })
await writeFile(OUT, encodePcm16ToUlaw(samples))
console.log(`wrote ${OUT} (${(samples.length / SAMPLE_RATE).toFixed(1)}s)`)
```

- [ ] **Step 5: Generate the placeholder audio**

```bash
cd backend && npx tsx scripts/make-voicemail.ts --synth
ls -l assets/voicemail.ulaw
```

Expected: a file of roughly 24000 bytes (3 s × 8000 bytes/s).

- [ ] **Step 6: Write the failing voicemail-behavior tests**

`backend/tests/voicemail.test.ts`:

```ts
import { CallSession, type Transport } from '../src/call/session.js'
import type { RealtimeClient, RealtimeEvent } from '../src/agent/realtime.js'
import type { Db } from '../src/lib/db.js'
import { encodePcm16ToUlaw, SPEECH_FRAMES_TO_ABORT } from '../src/media/ulaw.js'

function harness(voicemailFrames = ['VM1', 'VM2', 'VM3']) {
  const sent: string[] = []
  const rtCalls: string[] = []
  let onMsg: (raw: string) => void = () => {}
  let onClose: () => void = () => {}
  let emit: (e: RealtimeEvent) => void = () => {}

  const transport: Transport = {
    send: (raw) => { sent.push(raw) },
    close: () => { onClose() },
    onMessage: (cb) => { onMsg = cb },
    onClose: (cb) => { onClose = cb },
  }
  const realtime: RealtimeClient = {
    sendAudio: (b) => { rtCalls.push(`audio:${b}`) },
    sendToolResult: () => {},
    cancelResponse: () => { rtCalls.push('cancel') },
    requestResponse: () => {},
    on: (h) => { emit = h },
    close: () => { rtCalls.push('close') },
  }
  const session = new CallSession({
    transport, realtime, callId: 'c1', leadId: 'l1', slots: [], voicemailFrames,
    db: { insertTranscriptTurn: async () => {} } as unknown as Db,
  })

  onMsg(JSON.stringify({
    event: 'start', streamSid: 'MZ1',
    start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { callId: 'c1' } },
  }))

  // A full frame of μ-law silence, and one of loud tone. Energy, not mere
  // arrival, is what decides whether a human is on the line.
  const SILENT = encodePcm16ToUlaw(new Int16Array(160)).toString('base64')
  const loudSamples = new Int16Array(160)
  for (let i = 0; i < loudSamples.length; i++) loudSamples[i] = i % 2 === 0 ? 8000 : -8000
  const LOUD = encodePcm16ToUlaw(loudSamples).toString('base64')

  const frame = (payload: string) => onMsg(JSON.stringify({
    event: 'media', streamSid: 'MZ1', media: { track: 'inbound', payload },
  }))
  /** Twilio's continuous silence: what an answered-but-quiet line actually sends. */
  const silence = (n = SPEECH_FRAMES_TO_ABORT * 3) => { for (let i = 0; i < n; i++) frame(SILENT) }
  /** Sustained speech, enough to trip the abort threshold. */
  const speak = (n = SPEECH_FRAMES_TO_ABORT) => { for (let i = 0; i < n; i++) frame(LOUD) }
  const mark = (name: string) => onMsg(JSON.stringify({ event: 'mark', mark: { name } }))

  return { session, sent, rtCalls, emit, frame, silence, speak, mark, SILENT, LOUD }
}

const events = (sent: string[]) => sent.map((s) => JSON.parse(s).event)
const payloads = (sent: string[]) =>
  sent.map((s) => JSON.parse(s)).filter((m) => m.event === 'media').map((m) => m.media.payload)

it('does nothing on a human verdict', () => {
  const h = harness()
  h.session.applyAmdVerdict('human')
  expect(payloads(h.sent)).toEqual([])
  expect(h.session.result().voicemailDropped).toBe(false)
})

it('records the verdict even when it is human', () => {
  const h = harness()
  h.session.applyAmdVerdict('human')
  expect(h.session.result().amdVerdict).toBe('human')
})

it('on a machine verdict closes the model session and plays every voicemail frame', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  expect(h.rtCalls).toContain('close')
  expect(payloads(h.sent)).toEqual(['VM1', 'VM2', 'VM3'])
})

it('clears queued agent audio before playing the message', () => {
  const h = harness()
  h.emit({ kind: 'audio', payload: 'AGENT' })
  h.session.applyAmdVerdict('machine_start')
  const evs = events(h.sent)
  expect(evs.indexOf('clear')).toBeGreaterThan(-1)
  expect(evs.indexOf('clear')).toBeLessThan(evs.lastIndexOf('media'))
})

it('marks the end of playback so hangup can wait for it', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  const marks = h.sent.map((s) => JSON.parse(s)).filter((m) => m.event === 'mark')
  expect(marks.map((m) => m.mark.name)).toContain('voicemail-complete')
})

it('sets disposition voicemail once playback completes', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.mark('voicemail-complete')
  expect(h.session.result().disposition).toBe('voicemail')
  expect(h.session.result().voicemailDropped).toBe(true)
})

it('stops forwarding audio to the model during voicemail mode', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak()
  expect(h.rtCalls.some((c) => c.startsWith('audio:'))).toBe(false)
})

// The defect this replaced: aborting on any inbound frame. Twilio streams silence
// continuously, so that aborted every drop about 20 ms in and the feature was dead.
it('does not abort on continuous silence, which Twilio always sends', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.silence()
  expect(h.session.result().voicemailDropped).toBe(true)
  expect(h.session.result().amdVerdict).toBe('machine_start')
})

it('does not abort on a brief noise burst below the sustained threshold', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak(SPEECH_FRAMES_TO_ABORT - 1)
  expect(h.session.result().voicemailDropped).toBe(true)
})

it('resets the run when speech is interrupted by silence', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak(SPEECH_FRAMES_TO_ABORT - 1)
  h.silence(1)
  h.speak(SPEECH_FRAMES_TO_ABORT - 1)
  expect(h.session.result().voicemailDropped).toBe(true)
})

it('aborts the drop on sustained speech during playback — AMD false positive', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak()
  expect(h.session.result().voicemailDropped).toBe(false)
  expect(h.session.result().disposition).not.toBe('voicemail')
})

it('resumes forwarding audio to the model after an aborted drop', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak()            // trips the abort
  h.frame(h.LOUD)      // this one must reach the model
  expect(h.rtCalls).toContain(`audio:${h.LOUD}`)
})

it('keeps the verdict on record after an abort so false positives are countable', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak()
  expect(h.session.result().amdVerdict).toBe('machine_start_false_positive')
})

it('ignores a voicemail-complete mark that lands after an abort', () => {
  const h = harness()
  h.session.applyAmdVerdict('machine_start')
  h.speak()                    // abort: a human is on the line
  h.mark('voicemail-complete') // a mark already in flight
  expect(h.session.result().disposition).not.toBe('voicemail')
})

it('ignores a verdict arriving after the call already finished', () => {
  const h = harness()
  h.session.end('not_interested')
  h.session.applyAmdVerdict('machine_start')
  expect(payloads(h.sent)).toEqual([])
})

it('falls back to ending the call when no voicemail audio is configured', () => {
  const h = harness([])
  h.session.applyAmdVerdict('machine_start')
  expect(h.session.result().disposition).toBe('voicemail')
  expect(payloads(h.sent)).toEqual([])
})
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/voicemail.test.ts`
Expected: FAIL — `applyAmdVerdict` is not a function.

- [ ] **Step 8: Add voicemail handling to CallSession**

In `backend/src/call/session.ts`, replace the placeholder `abortVoicemailDrop` and `setVoicemailMode` methods with:

```ts
  /**
   * Async AMD verdict (spec §7). Arrives after the stream is already open, which is why
   * async detection is used — synchronous detection would delay every human-answered call
   * by 2–4 s and blow the latency budget in spec §5.
   */
  applyAmdVerdict(verdict: string): void {
    if (this.finished) return
    this.amdVerdict = verdict
    if (!verdict.startsWith('machine')) return

    this.mode = 'voicemail'
    this.voicemailDropped = true
    this.opts.realtime.close()

    if (this.agentSpeaking) {
      this.sendToTwilio(clearMessage(this.streamSid ?? ''))
      this.agentSpeaking = false
    }

    if (this.opts.voicemailFrames.length === 0) {
      console.warn('[voicemail] no audio configured; ending call without a message')
      this.end('voicemail')
      return
    }

    for (const frame of this.opts.voicemailFrames) {
      this.sendToTwilio(mediaMessage(this.streamSid ?? '', frame))
    }
    this.sendMark('voicemail-complete')
  }

  /**
   * A human speaking during voicemail playback is unambiguous evidence that machine
   * detection misfired (spec §7). Abort, keep the call alive, and record the false positive
   * so it is countable rather than invisible.
   */
  private abortVoicemailDrop(): void {
    console.warn('[voicemail] speech during playback; treating AMD verdict as a false positive')
    this.mode = 'conversation'
    this.voicemailDropped = false
    this.amdVerdict = `${this.amdVerdict ?? 'machine'}_false_positive`
    this.sendToTwilio(clearMessage(this.streamSid ?? ''))
  }
```

Also change the `media` branch of `handleTwilioMessage`. The abort must be driven by
**sustained energy**, not by a frame merely arriving: Twilio streams inbound audio
continuously whether anyone speaks or not, and during a voicemail drop the model
session is closed so there is no VAD to consult. Gating on frame arrival would abort
the drop about 20 ms after every machine verdict, which makes the whole feature dead.

```ts
      case 'media':
        if (!this.started) return
        this.audio.noteInboundFrame()
        if (this.mode === 'voicemail') {
          if (frameEnergy(msg.payload) >= SPEECH_ENERGY_THRESHOLD) {
            this.loudFrames += 1
            if (this.loudFrames >= SPEECH_FRAMES_TO_ABORT) this.abortVoicemailDrop()
          } else {
            this.loudFrames = 0 // a gap resets it; only sustained sound counts
          }
          return
        }
        this.opts.realtime.sendAudio(msg.payload)
        return
```

Add the counter alongside the other private fields, and reset it when a drop starts:

```ts
  /** Consecutive above-threshold inbound frames while playing a voicemail. */
  private loudFrames = 0
```

Import the three new helpers from `../media/ulaw.js`:

```ts
import { frameEnergy, SPEECH_ENERGY_THRESHOLD, SPEECH_FRAMES_TO_ABORT } from '../media/ulaw.js'
```

The realtime client is closed on a machine verdict, so an aborted drop cannot resume the model
conversation. That is accepted for Phase 1: the call stays connected and is logged as a false
positive rather than hanging up on a human. Reconnecting the model mid-call is Phase 2 work and
is noted as a known limitation in the runbook.

- [ ] **Step 9: Run both test files to verify they pass**

Run: `cd backend && npx vitest run tests/ulaw.test.ts tests/voicemail.test.ts tests/session.test.ts`
Expected: 6 + 12 + 15 = 33 passing. The Task 9 tests must still pass unchanged.

- [ ] **Step 10: Commit**

```bash
git add backend/src/media/ulaw.ts backend/scripts backend/src/call/session.ts \
        backend/tests/ulaw.test.ts backend/tests/voicemail.test.ts
git commit -m "feat: voicemail drop with false-positive abort on prospect speech"
```

---

### Task 11: HTTP and WebSocket server

**Files:**
- Create: `backend/src/call/teardown.ts`
- Create: `backend/src/server.ts`
- Test: `backend/tests/server-routes.test.ts`, `backend/tests/teardown.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `buildTwiml(opts): string`, `createCallHandler(deps)`, `parseStatsPath(pathname)`, `statsPayload(result)`, `persistCallResult(db, callId, result, startedAtMs)`, and `startServer(env)`. This is the last task; nothing consumes it.

One process serves `POST /calls`, `POST /twiml`, `POST /amd`, `POST /status`, `GET /calls/:id/stats`, and the `/media` WebSocket upgrade. A single ngrok tunnel therefore covers everything Twilio needs.

The route handlers are extracted as pure-ish functions with injected dependencies so they can be tested without binding a port or holding a Twilio account.

- [ ] **Step 1: Write the failing teardown test**

`backend/tests/teardown.test.ts`:

```ts
import { persistCallResult } from '../src/call/teardown.js'
import type { Db } from '../src/lib/db.js'
import type { CallResult } from '../src/call/session.js'

const result: CallResult = {
  disposition: 'booked',
  audio: { agentMs: 60000, prospectMs: 90000, talkRatio: 0.4, agentInterruptions: 2 },
  voicemailDropped: false,
  amdVerdict: 'human',
}

it('writes disposition, duration, and scores in one call', async () => {
  const seen: any[] = []
  const db = { finalizeCall: async (id: string, input: unknown) => { seen.push([id, input]) } } as unknown as Db
  await persistCallResult(db, 'c1', result, Date.now() - 142_000)
  expect(seen[0][0]).toBe('c1')
  expect(seen[0][1].disposition).toBe('booked')
  expect(seen[0][1].durationS).toBeGreaterThanOrEqual(141)
  expect(seen[0][1].audio.agentInterruptions).toBe(2)
})

it('never throws — a failed teardown must not crash the server', async () => {
  const db = { finalizeCall: async () => { throw new Error('db gone') } } as unknown as Db
  await expect(persistCallResult(db, 'c1', result, Date.now())).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run tests/teardown.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement teardown**

`backend/src/call/teardown.ts`:

```ts
import type { Db } from '../lib/db.js'
import type { CallResult } from './session.js'

/** Single write at call end — never per frame (spec §9). Failures are logged, never thrown. */
export async function persistCallResult(
  db: Db,
  callId: string,
  result: CallResult,
  startedAtMs: number,
): Promise<void> {
  try {
    await db.finalizeCall(callId, {
      disposition: result.disposition,
      durationS: Math.round((Date.now() - startedAtMs) / 1000),
      voicemailDropped: result.voicemailDropped,
      amdVerdict: result.amdVerdict,
      audio: result.audio,
    })
  } catch (err) {
    console.error('[teardown] failed to persist call result', err)
  }
}
```

- [ ] **Step 4: Write the failing route tests**

`backend/tests/server-routes.test.ts`:

```ts
import {
  buildTwiml,
  createCallHandler,
  parseStatsPath,
  socketTransport,
  statsPayload,
} from '../src/server.js'
import type { CallResult } from '../src/call/session.js'
import type { Db } from '../src/lib/db.js'

const ENV = {
  publicBaseUrl: 'https://abc.ngrok.app',
  twilioPhoneNumber: '+15550001111',
  verifiedNumbers: ['+923001234567'],
} as any

function deps(overrides: Record<string, unknown> = {}) {
  const created: any[] = []
  return {
    created,
    handler: createCallHandler({
      env: ENV,
      db: {
        getLead: async () => ({ id: 'l1', name: 'Ali', company: 'Acme', phone: '+923001234567' }),
        createCall: async () => ({ id: 'call-1', leadId: 'l1' }),
        attachTwilioSid: async () => {},
        ...(overrides.db as object),
      } as unknown as Db,
      placeCall: async (args: unknown) => { created.push(args); return { sid: 'CA1' } },
      ...overrides,
    }),
  }
}

it('builds TwiML that opens a bidirectional stream with the call id attached', () => {
  const xml = buildTwiml({ wsUrl: 'wss://abc.ngrok.app/media', callId: 'call-1' })
  expect(xml).toContain('<Connect>')
  expect(xml).toContain('<Stream url="wss://abc.ngrok.app/media">')
  expect(xml).toContain('<Parameter name="callId" value="call-1"/>')
})

it('escapes the call id in TwiML', () => {
  expect(buildTwiml({ wsUrl: 'wss://x/media', callId: 'a&b' })).toContain('a&amp;b')
})

it('rejects a number that is not on the allowlist with 403 and never dials', async () => {
  const d = deps()
  const res = await d.handler({ leadId: 'l1', to: '+923009999999' })
  expect(res.status).toBe(403)
  expect(d.created).toEqual([])
})

it('rejects an unparseable number with 403', async () => {
  const d = deps()
  expect((await d.handler({ leadId: 'l1', to: 'garbage' })).status).toBe(403)
})

it('rejects a missing lead with 404 and never dials', async () => {
  const d = deps({ db: { getLead: async () => null } })
  const res = await d.handler({ leadId: 'nope', to: '+923001234567' })
  expect(res.status).toBe(404)
  expect(d.created).toEqual([])
})

it('dials an allowlisted number and returns the call id', async () => {
  const d = deps()
  const res = await d.handler({ leadId: 'l1', to: '+923001234567' })
  expect(res.status).toBe(201)
  expect((res.body as any).callId).toBe('call-1')
})

it('falls back to the lead phone when no destination is supplied', async () => {
  const d = deps()
  expect((await d.handler({ leadId: 'l1' })).status).toBe(201)
  expect(d.created[0].to).toBe('+923001234567')
})

it('requests async machine detection so connection is never delayed', async () => {
  const d = deps()
  await d.handler({ leadId: 'l1', to: '+923001234567' })
  expect(d.created[0].machineDetection).toBe('DetectMessageEnd')
  expect(String(d.created[0].asyncAmd)).toBe('true')
  expect(d.created[0].asyncAmdStatusCallback).toContain('/amd')
})

it('never enables call recording', async () => {
  const d = deps()
  await d.handler({ leadId: 'l1', to: '+923001234567' })
  expect(d.created[0].record).toBeUndefined()
})

it('points Twilio at the twiml route with the call id', async () => {
  const d = deps()
  await d.handler({ leadId: 'l1', to: '+923001234567' })
  expect(d.created[0].url).toBe('https://abc.ngrok.app/twiml?callId=call-1')
})

it('returns 502 when Twilio rejects the call', async () => {
  const d = deps({ placeCall: async () => { throw new Error('twilio down') } })
  expect((await d.handler({ leadId: 'l1', to: '+923001234567' })).status).toBe(502)
})

it('parses a stats path to its call id', () => {
  expect(parseStatsPath('/calls/abc-123/stats')).toBe('abc-123')
})

it('ignores paths that are not stats requests', () => {
  expect(parseStatsPath('/calls')).toBeNull()
  expect(parseStatsPath('/calls/abc-123')).toBeNull()
  expect(parseStatsPath('/calls/abc/123/stats')).toBeNull()
  expect(parseStatsPath('/status')).toBeNull()
})

it('exposes frame-derived counters without persisting them', () => {
  const result: CallResult = {
    disposition: 'failed',
    audio: { agentMs: 4000, prospectMs: 6000, talkRatio: 0.4, agentInterruptions: 2 },
    voicemailDropped: false,
    amdVerdict: 'human',
  }
  expect(statsPayload(result)).toEqual({
    agentMs: 4000, prospectMs: 6000, talkRatio: 0.4, agentInterruptions: 2,
    disposition: 'failed', voicemailDropped: false, amdVerdict: 'human',
  })
})

it('reports zeroed counters before anyone has spoken', () => {
  const result: CallResult = {
    disposition: 'failed',
    audio: { agentMs: 0, prospectMs: 0, talkRatio: 0, agentInterruptions: 0 },
    voicemailDropped: false,
    amdVerdict: null,
  }
  expect(statsPayload(result)).toMatchObject({ agentMs: 0, prospectMs: 0, talkRatio: 0 })
})

// The buffering transport is what stops Twilio's first second of audio being
// dropped while the session is still connecting. It is testable without a socket.

function fakeWs() {
  const sent: string[] = []
  const listeners: Record<string, ((d: unknown) => void)[]> = {}
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => { sent.push(raw) },
    close: () => {},
    on: (event: string, cb: (d: unknown) => void) => { (listeners[event] ??= []).push(cb) },
    off: () => {},
  }
  return {
    ws: ws as unknown as Parameters<typeof socketTransport>[0],
    sent,
    deliver: (raw: string) => (listeners.message ?? []).forEach((cb) => cb(raw)),
  }
}

it('holds messages that arrive before a handler is attached', () => {
  const f = fakeWs()
  const transport = socketTransport(f.ws)
  f.deliver('one')
  f.deliver('two')
  const seen: string[] = []
  transport.onMessage((raw) => seen.push(raw))
  expect(seen).toEqual([]) // still buffered — flush has not run
})

it('replays buffered messages in arrival order on flush', () => {
  const f = fakeWs()
  const transport = socketTransport(f.ws)
  f.deliver('one')
  f.deliver('two')
  const seen: string[] = []
  transport.onMessage((raw) => seen.push(raw))
  transport.flush()
  expect(seen).toEqual(['one', 'two'])
})

it('does not let a late message overtake ones already buffered', () => {
  const f = fakeWs()
  const transport = socketTransport(f.ws)
  f.deliver('first')
  const seen: string[] = []
  transport.onMessage((raw) => seen.push(raw))
  f.deliver('second') // arrives after the handler but before flush
  transport.flush()
  expect(seen).toEqual(['first', 'second'])
})
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/server-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the server**

`backend/src/server.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import twilio from 'twilio'
import { loadEnv, type Env } from './lib/env.js'
import { createDb, type Db } from './lib/db.js'
import { isAllowed, normalizeE164 } from './lib/allowlist.js'
import { buildInstructions } from './agent/playbook.js'
import { connectRealtime } from './agent/realtime.js'
import { loadVoicemailFrames } from './media/ulaw.js'
import { CallSession, type CallResult, type Transport } from './call/session.js'
import { persistCallResult } from './call/teardown.js'
import { parseTwilioMessage } from './media/twilio-frames.js'

const AGENT_NAME = 'Sara'
const COMPANY_NAME = 'Northwind'
const MAX_SLOTS = 12

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function buildTwiml({ wsUrl, callId }: { wsUrl: string; callId: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}">
      <Parameter name="callId" value="${escapeXml(callId)}"/>
    </Stream>
  </Connect>
</Response>`
}

/** `/calls/<id>/stats` → `<id>`, or null for any other path. */
export function parseStatsPath(pathname: string): string | null {
  const match = /^\/calls\/([^/]+)\/stats$/.exec(pathname)
  return match?.[1] ?? null
}

/** What the console reads mid-call. Frame-derived, never persisted. */
export function statsPayload(result: CallResult): Record<string, unknown> {
  return {
    agentMs: result.audio.agentMs,
    prospectMs: result.audio.prospectMs,
    talkRatio: result.audio.talkRatio,
    agentInterruptions: result.audio.agentInterruptions,
    disposition: result.disposition,
    voicemailDropped: result.voicemailDropped,
    amdVerdict: result.amdVerdict,
  }
}

export interface CallRequest { leadId?: string; to?: string }
export interface HandlerResponse { status: number; body: unknown }

export interface CallHandlerDeps {
  env: Env
  db: Db
  placeCall(args: Record<string, unknown>): Promise<{ sid: string }>
}

export function createCallHandler(deps: CallHandlerDeps) {
  return async function handleCreateCall(req: CallRequest): Promise<HandlerResponse> {
    if (!req.leadId) return { status: 400, body: { error: 'leadId is required' } }

    const lead = await deps.db.getLead(req.leadId)
    if (!lead) return { status: 404, body: { error: 'lead not found' } }

    const destination = req.to ?? lead.phone
    // Spec §3: the allowlist is checked before any Twilio request and is not bypassable.
    if (!isAllowed(destination, deps.env.verifiedNumbers)) {
      return { status: 403, body: { error: 'destination is not on VERIFIED_NUMBERS' } }
    }

    const call = await deps.db.createCall(lead.id)
    const base = deps.env.publicBaseUrl

    try {
      const created = await deps.placeCall({
        to: normalizeE164(destination)!,
        from: deps.env.twilioPhoneNumber,
        url: `${base}/twiml?callId=${call.id}`,
        statusCallback: `${base}/status?callId=${call.id}`,
        statusCallbackEvent: ['completed'],
        // Async so the media stream opens immediately; sync detection would add 2-4 s to
        // every human-answered call (spec §7).
        // DetectMessageEnd, not Enable: 'Enable' reports machine_start when the
        // greeting BEGINS, so we would talk over it and the voicemail drop's
        // energy gate would see the machine's own greeting and abort. Waiting for
        // the greeting to end costs nothing on human-answered calls because the
        // detection is async — only the verdict is delayed, never the connection.
        machineDetection: 'DetectMessageEnd',
        asyncAmd: 'true',
        asyncAmdStatusCallback: `${base}/amd?callId=${call.id}`,
        asyncAmdStatusCallbackMethod: 'POST',
      })
      await deps.db.attachTwilioSid(call.id, created.sid)
      return { status: 201, body: { callId: call.id, twilioSid: created.sid } }
    } catch (err) {
      console.error('[calls] Twilio rejected the call', err)
      return { status: 502, body: { error: 'failed to place call' } }
    }
  }
}

// ---------------------------------------------------------------- live sessions

interface Live { session: CallSession; startedAtMs: number }
const live = new Map<string, Live>()

/** AMD verdicts that arrived before their session finished connecting. */
const earlyVerdicts = new Map<string, string>()

export interface BufferingTransport extends Transport {
  /** Deliver everything received so far, in order, then stream live. */
  flush(): void
}

/**
 * Buffers from the moment the socket opens.
 *
 * Twilio starts streaming audio immediately, but building a session needs three
 * database round trips and a realtime handshake. Without buffering there is no
 * listener attached during that window and the frames are simply lost — `ws`
 * queues nothing — costing the prospect's first second or two of speech on every
 * single call.
 */
export function socketTransport(ws: WebSocket): BufferingTransport {
  const queued: string[] = []
  let handler: ((raw: string) => void) | null = null
  let flushed = false

  ws.on('message', (d) => {
    const raw = d.toString()
    // Keep queueing until flush, so a message arriving between session
    // construction and flush cannot overtake the ones already waiting.
    if (flushed && handler) handler(raw)
    else queued.push(raw)
  })

  return {
    send: (raw) => { if (ws.readyState === ws.OPEN) ws.send(raw) },
    close: () => ws.close(),
    onMessage: (cb) => { handler = cb },
    onClose: (cb) => ws.on('close', cb),
    flush: () => {
      flushed = true
      for (const raw of queued.splice(0)) handler?.(raw)
    },
  }
}

/** 64 KiB. These routes are reachable through a public tunnel. */
const MAX_BODY_BYTES = 64 * 1024

export class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of req) {
    total += (c as Buffer).length
    if (total > MAX_BODY_BYTES) {
      req.destroy()
      throw new BodyTooLarge(`body exceeded ${MAX_BODY_BYTES} bytes`)
    }
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks).toString()
}

function parseForm(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body))
}

export async function startServer(env: Env): Promise<void> {
  const db = createDb(env.databaseUrl)
  const client = twilio(env.twilioAccountSid, env.twilioAuthToken)
  const voicemailFrames = await loadVoicemailFrames(env.voicemailAudioPath)
  const wsUrl = `${env.publicBaseUrl.replace(/^https?:/, 'wss:')}/media`

  const handleCreateCall = createCallHandler({
    env,
    db,
    placeCall: (args) => client.calls.create(args as any).then((c) => ({ sid: c.sid })),
  })

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const callId = url.searchParams.get('callId') ?? ''

    try {
      if (req.method === 'POST' && url.pathname === '/calls') {
        const out = await handleCreateCall(JSON.parse((await readBody(req)) || '{}'))
        return json(res, out.status, out.body)
      }

      if (url.pathname === '/twiml') {
        res.writeHead(200, { 'content-type': 'text/xml' })
        return res.end(buildTwiml({ wsUrl, callId }))
      }

      if (req.method === 'POST' && url.pathname === '/amd') {
        const verdict = parseForm(await readBody(req)).AnsweredBy ?? 'unknown'
        console.log(`[amd] call=${callId} verdict=${verdict}`)
        const entry = live.get(callId)
        if (entry) {
          entry.session.applyAmdVerdict(verdict)
        } else {
          // AMD detection and the media handshake are independent races off the
          // same answer event. A verdict that wins is held for the session to
          // collect, not discarded — dropping it would treat a machine as human
          // and silently defeat the voicemail drop.
          console.warn(`[amd] call=${callId} verdict arrived before the session; holding it`)
          earlyVerdicts.set(callId, verdict)
        }
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && url.pathname === '/status') {
        await readBody(req)
        // Delete before awaiting: the socket close and this callback are both
        // triggered by the call ending, so whichever arrives second must find
        // nothing left to persist. Map.delete returning true is the claim.
        const entry = live.get(callId)
        if (entry && live.delete(callId)) {
          await persistCallResult(db, callId, entry.session.result(), entry.startedAtMs)
        }
        earlyVerdicts.delete(callId)
        return json(res, 200, { ok: true })
      }

      // Live audio counters, read from the in-memory session. The console's
      // talk band needs these mid-call; call_scores is only written at
      // teardown, so without this the band sits blank until hangup.
      const statsFor = parseStatsPath(url.pathname)
      if (req.method === 'GET' && statsFor !== null) {
        const entry = live.get(statsFor)
        if (!entry) return json(res, 404, { error: 'no live call with that id' })
        return json(res, 200, statsPayload(entry.session.result()))
      }

      return json(res, 404, { error: 'not found' })
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        console.warn(`[http] rejected oversized body on ${url.pathname}`)
        return json(res, 413, { error: 'request body too large' })
      }
      console.error('[http] handler failed', err)
      return json(res, 500, { error: 'internal error' })
    }
  })

  const wss = new WebSocketServer({ server, path: '/media' })

  wss.on('connection', (ws) => {
    // Buffering starts the instant the socket opens, before any await, so nothing
    // Twilio sends during setup is lost.
    const transport = socketTransport(ws)
    let starting = false

    // A second listener that only observes. The callId arrives in the start
    // event's customParameters and is needed before a session can be built.
    const detectStart = async (data: unknown) => {
      if (starting) return
      const msg = parseTwilioMessage(String(data))
      if (msg?.event !== 'start') return
      starting = true
      ws.off('message', detectStart)

      const callId = msg.customParameters.callId ?? ''
      const startedAtMs = Date.now()

      try {
        const call = await db.query<{ lead_id: string }>(
          'select lead_id from calls where id = $1', [callId])
        const leadId = call[0]?.lead_id
        if (!leadId) throw new Error(`unknown callId ${callId}`)

        const lead = await db.getLead(leadId)
        if (!lead) throw new Error(`unknown leadId ${leadId}`)

        const slots = await db.getOpenSlots(MAX_SLOTS)
        const realtime = await connectRealtime({
          apiKey: env.openaiApiKey,
          model: env.realtimeModel,
          instructions: buildInstructions({
            lead, slots, agentName: AGENT_NAME, companyName: COMPANY_NAME,
          }),
        })

        const session = new CallSession({
          transport, realtime, db, callId, leadId: lead.id, slots, voicemailFrames,
        })
        live.set(callId, { session, startedAtMs })

        session.onFinished(() => {
          // Claim the entry first; /status may be racing us for the same call.
          if (live.delete(callId)) {
            void persistCallResult(db, callId, session.result(), startedAtMs)
          }
          earlyVerdicts.delete(callId)
        })

        // Releases the start event and every frame buffered since, in order.
        transport.flush()

        // A verdict that beat the handshake was held rather than dropped.
        const held = earlyVerdicts.get(callId)
        if (held !== undefined) {
          earlyVerdicts.delete(callId)
          console.log(`[amd] call=${callId} applying held verdict=${held}`)
          session.applyAmdVerdict(held)
        }

        realtime.requestResponse()
        console.log(`[media] session live call=${callId} lead=${lead.name}`)
      } catch (err) {
        console.error('[media] failed to start session', err)
        earlyVerdicts.delete(callId)
        ws.close()
      }
    }

    ws.on('message', detectStart)
  })

  server.listen(env.port, () => {
    console.log(`backend listening on :${env.port}`)
    console.log(`expose it:  ngrok http ${env.port}`)
    console.log(`then set PUBLIC_BASE_URL to the https URL ngrok prints`)
  })
}

if (process.argv[1]?.endsWith('server.ts')) {
  startServer(loadEnv(process.env)).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
```

- [ ] **Step 7: Run the full suite to verify everything passes**

Run: `cd backend && TEST_DATABASE_URL=postgres://sb@127.0.0.1:5470/coldcall_test npm test`
Expected: all suites green — 13 test files, 151 tests (5 env, 9 allowlist, 7 twilio-frames,
12 audio, 11 db, 9 playbook, 12 tool-handlers, 18 realtime, 19 session, 11 ulaw, 17 voicemail,
2 teardown, 18 server-routes).

- [ ] **Step 8: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add backend/src/server.ts backend/src/call/teardown.ts \
        backend/tests/server-routes.test.ts backend/tests/teardown.test.ts
git commit -m "feat: HTTP routes, media socket, and call teardown persistence"
```

---

### Task 12: Acceptance runbook

**Files:**
- Create: `backend/RUNBOOK.md`
- Test: manual, against a real phone.

**Interfaces:**
- Consumes: everything.
- Produces: nothing consumed by code.

Spec §11 requires two manual calls: one answered that reaches a booked meeting with
`agent_interruptions` at zero, and one unanswered that fires the voicemail drop.

- [ ] **Step 1: Write the runbook**

`backend/RUNBOOK.md`:

````markdown
# Phase 1 Runbook

## One-time setup

1. Create the database (see plan prerequisites P1) and apply the schema:
   ```bash
   cd backend && npm run db:reset
   psql -d coldcall -c "insert into slots (starts_at) select generate_series(
     date_trunc('hour', now()) + interval '1 day',
     date_trunc('hour', now()) + interval '10 day', interval '4 hour');"
   ```

2. Generate placeholder voicemail audio:
   ```bash
   npx tsx scripts/make-voicemail.ts --synth
   ```
   Replace it with a real recording before the voicemail test call:
   ```bash
   ffmpeg -i my-message.m4a -ar 8000 -ac 1 -c:a pcm_s16le my-message.wav
   npx tsx scripts/make-voicemail.ts my-message.wav
   ```

3. Copy `.env.example` to `.env` and fill it in. `VERIFIED_NUMBERS` must contain **only**
   numbers you own — it is the sole guard against calling anyone else.

## Every session

```bash
ngrok http 8080                      # terminal 1 — copy the https URL
# put that URL in .env as PUBLIC_BASE_URL
cd backend && npm start              # terminal 2
```

Confirm the realtime model id in `.env` (`OPENAI_REALTIME_MODEL`) against current provider
documentation. A stale id fails at socket-open time with an opaque error.

## Test call 1 — answered, ending in a booked meeting

```bash
psql -d coldcall -t -c "insert into leads (name, company, phone)
  values ('Test Lead', 'Test Co', '<your-number>') returning id;"

curl -s -X POST localhost:8080/calls \
  -H 'content-type: application/json' \
  -d '{"leadId":"<id from above>","to":"<your-number>"}' | jq
```

Answer the phone. Let the agent open, answer its discovery questions, raise one objection, then
agree to a meeting.

Then check the results:

```bash
psql -d coldcall -c "select disposition, duration_s, amd_verdict, voicemail_dropped
  from calls order by started_at desc limit 1;"
psql -d coldcall -c "select agent_ms, prospect_ms, round(talk_ratio::numeric, 2) as ratio,
  agent_interruptions from call_scores order by call_id desc limit 1;"
psql -d coldcall -c "select role, text from transcript_turns
  where call_id = (select id from calls order by started_at desc limit 1) order by id;"
psql -d coldcall -c "select starts_at from meetings order by id desc limit 1;"
```

**Pass criteria**

- `disposition` is `booked` and a `meetings` row exists.
- `agent_interruptions` is **0**. Anything above zero means `SILENCE_DURATION_MS` in
  `src/agent/playbook.ts` is too low — raise it by 100 ms and call again.
- `talk_ratio` is between 0.40 and 0.60. Above 0.60 means the agent is pitching rather than
  discovering; tighten the playbook, not the code.
- The transcript reads as a real conversation with turns from both sides.

## Test call 2 — voicemail drop

Place the call and let it ring through to voicemail without answering.

```bash
psql -d coldcall -c "select disposition, voicemail_dropped, amd_verdict
  from calls order by started_at desc limit 1;"
```

**Pass criteria:** `disposition` is `voicemail`, `voicemail_dropped` is true, and the recorded
message plays cleanly with no clipping at either end.

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
psql -d coldcall -c "select amd_verdict, count(*) from calls group by 1;"
```

**Known Phase 1 limitation:** after an aborted drop the model session has already been closed,
so the call stays connected but the agent does not resume speaking. Hang up and redial. Keeping
the model session alive through a false positive is Phase 2 work.

## Other things that will go wrong

| Symptom | Cause |
| --- | --- |
| Twilio call connects then drops immediately | `PUBLIC_BASE_URL` stale after an ngrok restart. |
| Silence both ways | Audio format mismatch. Both sides must be `g711_ulaw`; never resample. |
| Agent talks over you constantly | `SILENCE_DURATION_MS` too low. Raise it. |
| Long pauses before the agent replies | Region mismatch, or the full rather than mini model tier. |
| `403` from `/calls` | Number is not in `VERIFIED_NUMBERS`. Working as designed. |
| Socket opens then closes at once | Bad or stale `OPENAI_REALTIME_MODEL`. |
````

- [ ] **Step 2: Run the full suite one more time before the live call**

Run: `cd backend && TEST_DATABASE_URL=postgres://sb@127.0.0.1:5470/coldcall_test npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 3: Execute test call 1 and record the results**

Follow the runbook. Paste the actual `call_scores` row into the commit message so the first
measured talk ratio and interruption count are on record.

- [ ] **Step 4: Execute test call 2**

Follow the runbook.

- [ ] **Step 5: Commit**

```bash
git add backend/RUNBOOK.md
git commit -m "docs: Phase 1 acceptance runbook with measured first-call results"
```

---

## Self-review

**Spec coverage.** Every Phase 1 item in spec §2 maps to a task: call-initiation route (Task 11),
media WebSocket (Tasks 9, 11), playbook (Task 6), tools (Task 7), `slots` table (Task 5),
voicemail drop (Task 10), audio accounting (Task 4), curl-driven trigger (Task 12).
Cross-cutting requirements: allowlist §3 → Task 2 + Task 11; latency §5 → `SILENCE_DURATION_MS`
(Task 6), slot preloading (Task 6), fire-and-forget qualification (Task 7); voicemail §7 →
Task 10; scoring §8 → Task 4 socket-side metrics, with `discovery_questions_asked`,
`objections`, and `yielded_correctly` deliberately left null until the Phase 3 transcript pass;
schema §9 → Task 5; failure modes §10 → covered by tests in Tasks 7, 9, 10, 11; testing §11 →
Task 12; local-only §12 → prerequisites and runbook; recording off §14 → asserted in Task 11.

**Deliberately deferred to Phase 3, not gaps.** Summary, disposition refinement by Claude,
`next_step`, and the three transcript-derived score columns. The columns exist and accept null.

**Known limitation, documented rather than hidden.** After an AMD false-positive abort the model
session is already closed, so the agent goes quiet while the call stays connected. Preserving the
session through a false positive requires deferring the realtime close until playback completes,
which is Phase 2 work. It is in the runbook.
