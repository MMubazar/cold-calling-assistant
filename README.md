# 📞 Cold Calling Assistant

Ek **autonomous AI voice caller**. Aap dashboard me lead add karte ho aur **Call** dabate ho —
Twilio number dial karta hai, call ka audio seedha ek realtime speech-to-speech model se bridge
ho jata hai, aur wo model poori conversation khud chalata hai: opener deta hai, prospect ko
qualify karta hai, objections handle karta hai, aur mid-call ek tool call karke **meeting book**
kar deta hai. Transcript aapko live screen par chalta hua nazar aata hai. 🎙️

Agar call answering machine par chali jaye 📠 to conversation ki jagah ek pre-recorded
**voicemail** drop ho jati hai. Aur jo calls insaan ne uthai hoon, unko baad me **score** kiya
jata hai — talk ratio, discovery questions, objections, interruption count — taake playbook ko
feelings ke bajaye numbers par tune kiya ja sake. 📊

> ⚠️ **Ye ek practice project hai.** Ye real phone calls karta hai, lekin **sirf un numbers par
> jo operator ke apne hain** (`VERIFIED_NUMBERS` allowlist). Ye production outbound system
> **nahi** hai — na DNC list hai, na consent capture, na campaign scheduler, na CRM sync.

---

## ✨ Ek nazar me kya kya hai

| Feature | Tafseel |
| --- | --- |
| ☎️ Outbound calling | Twilio REST se call, TwiML `<Connect><Stream>` se audio media socket par |
| 🤖 Realtime AI agent | Speech-to-speech model, μ-law 8kHz frames, dono taraf, bina resample ke |
| 🛠️ Mid-call tools | `book_meeting`, `save_qualification`, `end_call` |
| 🗣️ Barge-in | Prospect bole to agent turant chup — queued audio Twilio se clear ho jata hai |
| 📠 Voicemail drop | Twilio AMD verdict par pre-recorded message, false-positive abort ke saath |
| 📈 Call scoring | `agent_ms`, `prospect_ms`, `talk_ratio`, `agent_interruptions` |
| 🖥️ Operator console | Next.js dashboard — leads, live transcript, talk band, call log |
| 🔐 Safety guards | Number allowlist + Twilio webhook signature validation (403 on mismatch) |

---

## 🏗️ Architecture (mukhtasar)

```
Browser console (frontend/, Next.js :3100)
   │  POST /api/calls  ──▶ backend ko proxy (khud Twilio se baat nahi karta)
   │  GET  /api/calls/:id/live  ──▶ live transcript
   ▼
Backend (backend/, Node + tsx :8080)
   POST /calls        ──▶ allowlist check ➜ call row ➜ Twilio outbound
   GET  /twiml        ──▶ <Connect><Stream> TwiML
   WS   media socket  ──▶ μ-law frames ⇄ Realtime model  (tools yahan chalte hain)
   POST /amd          ──▶ machine detect ➜ voicemail drop   🔏 signature-checked
   POST /status       ──▶ call finalize (disposition, duration) 🔏 signature-checked
   GET  /calls/:id/stats ──▶ live talk-time counters (console poll karta hai)
   ▼
PostgreSQL  →  leads · slots · calls · transcript_turns · call_scores · qualifications · meetings
```

Twilio bahar se andar aata hai, is liye **sirf backend ko `ngrok` tunnel chahiye**. Console
local hi rehta hai. 🌐

### 📁 Folder layout

```
backend/
  src/server.ts          HTTP routes + media WebSocket
  src/agent/             playbook, realtime client, tools + handlers
  src/call/              session (audio + barge-in + tools), teardown
  src/media/             μ-law codec, Twilio frame parsing, audio accounting
  src/lib/               env, db, allowlist
  db/schema.sql          poora schema (drop + create)
  tests/                 13 vitest files
  RUNBOOK.md             👈 live call karne ka operator guide
frontend/
  app/                   page + API routes (calls, leads, live)
  components/            LeadList, LivePanel, TalkBand, CallLog, Console
  scripts/seed.ts        demo data
docs/                    design spec + Phase 1 plan
```

---

## 🚀 Kaise chalayein

### 0️⃣ Zaruriyat

- Node 20+ 📦
- PostgreSQL — is machine par **port 5470** wale private cluster par chalta hai (5432 wale system cluster par nahi)
- Twilio account + ek phone number ☎️
- OpenAI API key 🔑
- `ngrok` (ya koi bhi tunnel) 🌐

### 1️⃣ Postgres start karo

```bash
pg_isready -h 127.0.0.1 -p 5470            # check
pg_ctl -D ~/.coldcall-pg -o "-p 5470 -k /tmp" start   # agar band ho
```

> 💡 Pehli baar ki sab se aam ghalti yahi hai — cluster band ho to `npm test` aur `db:reset`
> sirf "connection refused" dete hain, ye nahi batate ke Postgres start karna hai.

### 2️⃣ Database banao aur schema lagao

```bash
createdb -h 127.0.0.1 -p 5470 -U sb coldcall
createdb -h 127.0.0.1 -p 5470 -U sb coldcall_test

cd backend
npm install
npm run db:reset     # ⚠️ ye coldcall ki saari tables drop + recreate karta hai
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall_test -f db/schema.sql
```

Phir kuch **khali meeting slots** daal do (warna agent meeting book nahi kar sakta 📅):

```bash
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -c "insert into slots (starts_at) select generate_series(
  date_trunc('hour', now()) + interval '1 day',
  date_trunc('hour', now()) + interval '10 day', interval '4 hour');"
```

### 3️⃣ Voicemail audio banao 🔊

```bash
cd backend
npx tsx scripts/make-voicemail.ts --synth      # 3-second tone placeholder
```

Asli recorded message ke liye `ffmpeg` chahiye (is machine par installed nahi hai):

```bash
sudo apt install -y ffmpeg
ffmpeg -i my-message.m4a -ar 8000 -ac 1 -c:a pcm_s16le my-message.wav
npx tsx scripts/make-voicemail.ts my-message.wav
```

### 4️⃣ `.env` bharo 📝

```bash
cd backend && cp .env.example .env
```

| Key | Kya dalna hai |
| --- | --- |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio console se. Auth **token** chahiye, API key/secret nahi ❗ |
| `TWILIO_PHONE_NUMBER` | Aapka Twilio number, E.164 |
| `OPENAI_API_KEY` | OpenAI key |
| `OPENAI_REALTIME_MODEL` | Khali chhodo to `gpt-realtime-mini` default hai |
| `DATABASE_URL` | `postgres://sb@127.0.0.1:5470/coldcall` |
| `TEST_DATABASE_URL` | `postgres://sb@127.0.0.1:5470/coldcall_test` (tests ke liye lazmi) |
| `VERIFIED_NUMBERS` | 🚨 **Sirf apne numbers**, comma-separated E.164. Yehi wahid guard hai |
| `PUBLIC_BASE_URL` | Aapka ngrok https URL |
| `VOICEMAIL_AUDIO_PATH` | `./assets/voicemail.ulaw` |
| `PORT` | `8080` |

### 5️⃣ Server chalao ▶️

```bash
# terminal 1
ngrok http 8080          # jo https URL mile use .env me PUBLIC_BASE_URL par dalo

# terminal 2
cd backend && npm start  # ya: npm run dev  (watch mode)
```

> 🔁 Har ngrok restart ke baad `PUBLIC_BASE_URL` update karna **zaruri** hai — warna Twilio ki
> signature match nahi hoti, `/amd` aur `/status` 403 dete hain, aur calls kabhi finalize nahi
> hotin. Log me dhoondo: `rejected: bad Twilio signature`.

### 6️⃣ Operator console (optional lekin behtar) 🖥️

```bash
cd frontend
npm install
npm run dev      # http://localhost:3100
npm run seed     # demo data (optional)
```

Console wahi Postgres parhta hai aur dial karne ke liye backend ko proxy karta hai
(`BACKEND_URL`, default `http://127.0.0.1:8080`).

---

## 📱 Pehli call

```bash
# lead banao
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -t -c "insert into leads (name, company, phone)
  values ('Test Lead', 'Test Co', '<apna-number>') returning id;"

# call karo
curl -s -X POST localhost:8080/calls \
  -H 'content-type: application/json' \
  -d '{"leadId":"<upar wali id>","to":"<apna-number>"}' | jq
```

Number `VERIFIED_NUMBERS` me na ho to **403** milega — ye bug nahi, design hai ✅

Natija dekhne ke liye:

```bash
psql -h 127.0.0.1 -p 5470 -U sb -d coldcall -c "select disposition, duration_s, amd_verdict,
  voicemail_dropped from calls order by started_at desc limit 1;"
```

Poora acceptance procedure (3 test calls — answered / voicemail / no-answer, pass criteria,
aur known warts) [backend/RUNBOOK.md](backend/RUNBOOK.md) me hai. 👈 Live call se pehle ye zarur parho.

---

## 🧪 Tests

```bash
cd backend
TEST_DATABASE_URL=postgres://sb@127.0.0.1:5470/coldcall_test npm test
npm run typecheck

cd ../frontend && npm test
```

> ⚠️ Backend tests `leads`, `calls`, `slots` ko **truncate** karte hain. Console ka seed data
> ur jata hai — baad me `frontend/` me `npm run seed` dobara chala lena.

---

## 🧭 Phases

- ✅ **Phase 1 — one working call.** Call route, media socket, playbook, tools, slots, voicemail
  drop, audio accounting. Saara technical risk yahi tha.
- 🚧 **Phase 2 — operator surface.** Lead table, one-click dial, live transcript, talk band, call log.
- ⏳ **Phase 3 — post-call intelligence.** Summary, disposition reasoning, next-step recommendation,
  transcript-derived scoring.

Design spec: [docs/superpowers/specs/2026-08-06-cold-calling-assistant-design.md](docs/superpowers/specs/2026-08-06-cold-calling-assistant-design.md)

---

## 🩹 Aam masail

| Symptom | Wajah |
| --- | --- |
| `connection to server ... failed` | Postgres cluster (port 5470) band hai |
| `npm test` `TEST_DATABASE_URL` ka rona rota hai | Ye jaan boojh kar hai — DB ka naam `_test` par khatam hona chahiye |
| Call connect ho kar foran drop | `PUBLIC_BASE_URL` purana hai (ngrok restart ke baad) |
| Dono taraf khamoshi 🔇 | Audio format mismatch — dono taraf `g711_ulaw` hona chahiye, resample bilkul nahi |
| Agent baar baar aap par bol parta hai | `SILENCE_DURATION_MS` (`src/agent/playbook.ts`) kam hai, 100ms barhao |
| `/calls` se 403 | Number allowlist me nahi — sahi behaviour ✅ |
| Socket khul kar foran band | `OPENAI_REALTIME_MODEL` id ghalat/purani hai |
| Console ka talk band khali | Backend `BACKEND_URL` par reachable nahi, ya call server-side connected nahi |

Baaki sab, aur AMD false-positive wali known limitation, [backend/RUNBOOK.md](backend/RUNBOOK.md) me. 📖

---

## 🔒 Ethics & scope

- Sirf apne numbers par call — `VERIFIED_NUMBERS` code me enforce hai, UI se bypass nahi ho sakta.
- Recording **band** hai. Agar kabhi on karo, to agent ke opener me disclose karna lazmi hai — chupke se nahi.
- `/amd` aur `/status` dono destructive hain, is liye Twilio signature verify karte hain.
