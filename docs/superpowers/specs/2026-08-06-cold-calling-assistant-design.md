# Cold Calling Assistant — Design

**Date:** 2026-08-06
**Status:** Approved, pending implementation plan
**Optimization target:** speed — fastest to build, fastest models, lowest call latency

## 1. Summary

An autonomous AI voice caller. You add leads to a web dashboard and click **Call**. Twilio
dials the number and bridges the audio to a realtime speech-to-speech model, which runs the
whole conversation: it opens, qualifies the prospect, handles objections, and books a meeting
by calling a tool mid-call. You watch the transcript stream in live.

Calls that reach an answering machine get a pre-recorded voicemail message instead of a
conversation. Calls that reach a human are scored afterward — talk ratio, discovery questions
asked, objections handled, interruption count — so the playbook can be tuned against numbers
rather than impressions.

**Non-goals.** This is a practice project that makes real calls to numbers the operator owns.
It is not a production outbound system. There is no DNC list, no consent capture, no campaign
scheduler, no CRM sync, and no multi-tenant support. Adding those later is a separate project.

## 2. Build phases

Speed of delivery is a stated goal, so the build is ordered rather than trimmed. Everything in
scope survives; Phase 1 is simply the shortest path to hearing the agent work.

**Phase 1 — one working call.** Call-initiation route, media WebSocket, agent playbook, tools,
`slots` table, voicemail drop, per-call audio accounting. Trigger calls with `curl`.
Success: you pick up your phone, the agent qualifies you and books a meeting.
This is the entire technical risk of the project.

**Phase 2 — the operator surface.** Lead table, one-click dial, SSE live transcript, outcome
cards, score display. Straightforward CRUD and streaming over a system already proven to work.

**Phase 3 — post-call intelligence.** Status webhook, summary, disposition, next-step
recommendation, transcript-derived scoring.

Phase 1 is where all the uncertainty lives. Phases 2 and 3 are predictable work and should not
be allowed to delay proving Phase 1.

## 3. Scope guard

Dialing is restricted to an allowlist of numbers the operator controls, supplied as the
`VERIFIED_NUMBERS` environment variable (comma-separated E.164). `POST /api/calls` rejects
any destination not on that list with a 403 before touching Twilio.

This is enforced in code rather than left to discipline, because it is the single control that
keeps the project free of telemarketing compliance obligations. It must not be bypassable from
the UI.

## 4. Architecture

```
Browser (lead table)                              [Phase 2]
   │ POST /api/calls          ── validates allowlist, creates call row, Twilio REST outbound
   │ GET  /api/calls/:id/live ── SSE, tails transcript_turns rows
   ▼
Twilio ──TwiML <Connect><Stream>──▶ /api/media (WebSocket)
   │                                    │  μ-law 8kHz base64 frames, both directions
   │                                    │  frame counters → agent_ms / prospect_ms
   │                                    ▼
   │                          Realtime speech-to-speech session
   │                          tools: book_meeting
   │                                 save_qualification   (fire-and-forget)
   │                                 end_call
   │                          slots preloaded into session instructions
   │
   └─ async AMD callback: machine ──▶ swap to voicemail drop, close model session
                                                                            [Phase 1]
   Twilio status callback ──▶ /api/calls/webhook ──▶ fast text model    [Phase 3]
                                                     summary + disposition + next step
                                                     + transcript-derived scores
```

Five server surfaces: the dashboard, the call-initiation route, the live-transcript SSE stream,
the media WebSocket, and the status webhook. The WebSocket handler is the only one with real
complexity.

### Why this shape

Twilio Media Streams and the realtime session both speak `g711_ulaw` at 8 kHz. The socket
handler is therefore a base64 relay in both directions — no resampling, no voice activity
detection, no endpointing logic of our own. The model handles turn-taking natively. This is
both the fastest to build and the lowest-latency option; a cascade (STT → LLM → TTS) would add
a full second of turn delay and require writing endpointing by hand.

Barge-in is the only genuine audio work. When the model emits `input_audio_buffer.speech_started`,
the handler sends Twilio a `clear` message to flush audio already queued for playback, and
cancels the in-flight model response. Playback position is tracked using Twilio `mark` events
so we know what the prospect actually heard.

### Hosting tradeoff

Vercel Functions support WebSockets on Fluid Compute, so the media stream can live in the same
app as the dashboard — one repo, no separate process.

The cost: Vercel Functions cap at 300 seconds, so a call running past five minutes is cut off.
Cold calls that go well end in two to three minutes, so this is acceptable here. It is the
first constraint to remove if this ever becomes real. The socket handler is therefore written
transport-agnostic: it takes a duplex message channel and a session config, so it can be lifted
into a long-lived Node process without touching the conversation logic.

**Note:** Twilio dials from its own infrastructure and must reach this WebSocket over the public
internet. Since nothing may be deployed, Phase 1 runs locally behind an ngrok tunnel. See §12.

## 5. Latency budget

The number that matters is *perceived turn delay* — the gap between the prospect finishing a
sentence and hearing the agent begin. Realistic budget:

| Stage | Cost | Tunable? |
| --- | --- | --- |
| Endpoint detection (VAD silence threshold) | 300–500 ms | **Yes — dominant term** |
| Model first audio token | 250–450 ms | Partly, via model tier |
| Network hops (Twilio ↔ handler ↔ model) | 60–160 ms | Via region colocation |
| Twilio playback buffering | 40–100 ms | No |
| **Total perceived** | **~650 ms – 1.1 s** | |

Endpointing dominates, and it is the one term fully under our control. Optimizations, in order
of payoff:

1. **Tune `silence_duration_ms` to ~400 ms** (from a typical 500–700 ms default). This is the
   single largest win. The tradeoff is real and unavoidable: too low and the agent talks over
   prospects who pause mid-sentence, which on a cold call is worse than being slightly slow.
   Start at 400 ms and tune against the `agent_interruptions` metric from §8 — a measured
   number, not intuition.
2. **Preload slot availability into the session instructions** at call start, eliminating
   `check_availability` entirely. A tool round trip mid-sentence is dead air the prospect hears;
   a cold call's slot list does not change during the call, so fetching it live buys nothing.
3. **Make `save_qualification` fire-and-forget.** The agent must never wait on a write it does
   not need the result of.
4. **Colocate.** Pin the function region to match the Twilio media region and the model
   endpoint. Cross-continent hops cost more than any model choice.
5. **Keep the system prompt tight.** A long prompt slows first-token time modestly; the playbook
   should be dense, not verbose.
6. **Batch transcript writes.** No per-frame database work on the socket path.

`book_meeting` stays synchronous. It is a single indexed insert, well under 20 ms, and the agent
must not claim a booking that failed.

## 6. Model split

| Job | Model | Reason |
| --- | --- | --- |
| Live conversation | Mini/fast realtime speech-to-speech tier | Lower first-token latency and materially cheaper per minute than the full tier. |
| Post-call reasoning and scoring | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | Summarizing a two-minute transcript, picking one of seven dispositions, and counting discovery questions is well within Haiku. |

Claude has no native speech-to-speech API, which is why the conversation runs on a realtime
model and Claude handles the text reasoning. Verify the current realtime model id at
implementation time rather than trusting a hardcoded name.

**Quality tradeoff, stated plainly.** The fast conversation tier handles the scripted objection
library fine — those are pattern-matched responses. It is weaker at the unscripted case: a
prospect who argues, goes off-script, or raises a technical question. If real calls show the
agent losing those exchanges, upgrading the conversation model to the full realtime tier is a
one-line change and the first thing to try. Do not upgrade preemptively.

## 7. Voicemail drop

Most cold dials reach an answering machine. Without handling, those calls burn a model session
and produce nothing.

**Detection.** Twilio answering-machine detection runs in **async** mode — the call connects and
the media stream opens immediately, and the detection verdict arrives separately by callback.
This matters: synchronous machine detection delays call connection by two to four seconds while
Twilio listens, which would blow the entire latency budget in §5 for every human-answered call.
Async detection costs nothing on the happy path. Confirm the exact parameter names against
current Twilio documentation at implementation time.

**Behavior.** On a `machine_start` verdict, the handler closes the model session, plays a
pre-recorded message from `VOICEMAIL_AUDIO_URL` as μ-law frames, and hangs up. Disposition is
set to `voicemail` and `voicemail_dropped` is recorded true. No model session is billed beyond
the few seconds before the verdict.

**The false-positive risk is the real design problem.** Machine detection sometimes misfires on
a human who answers with a long, flat greeting — and this project's test calls, all made to the
operator's own phone, are exactly the case most likely to trigger it. Mitigations:

- The model session is not closed until the verdict arrives, so the first seconds of a
  misclassified human call are already handled normally.
- If the prospect speaks during voicemail playback, abort the drop and reconnect the model
  session. A human interrupting a voicemail message is unambiguous evidence of misclassification.
- Every dropped call is logged with the detection verdict so false positives are countable
  rather than invisible.

The voicemail message itself is a static audio file the operator records. Generating it per-lead
is deliberately out of scope — it adds a TTS dependency for no measurable gain.

## 8. Call scoring

Phase 3 already parses the full transcript, so scoring is close to free. It exists to make the
playbook tunable against numbers instead of impressions.

**Measured in the socket handler** (exact, no inference needed). Twilio media frames are a fixed
20 ms each, so counting inbound and outbound frames yields precise speaking time for both
parties without timestamps or heuristics:

| Metric | Source |
| --- | --- |
| `agent_ms`, `prospect_ms` | Outbound and inbound frame counts × 20 ms |
| `talk_ratio` | `agent_ms / (agent_ms + prospect_ms)` |
| `agent_interruptions` | Count of agent speech starts while inbound frames were still arriving |

**Derived from the transcript** by Haiku in the post-call pass:

| Metric | Definition |
| --- | --- |
| `discovery_questions_asked` | How many of the four discovery questions were actually asked (0–4) |
| `objections` | jsonb list of objections encountered, each with `handled: bool` |
| `yielded_correctly` | Whether the agent stopped after two refusals per the yield rule |

**Interpretation.** For cold calls the agent should hold roughly 40–50% of talk time; above 60%
means it is pitching instead of discovering. `agent_interruptions` is the feedback signal for the
`silence_duration_ms` tuning in §5 — a rising count means endpointing is too aggressive, which is
what previously had no way to be measured.

Scores are stored, not acted on automatically. Nothing in the system self-tunes; the operator
reads the numbers and edits the playbook.

## 9. Data model

| Table | Columns |
| --- | --- |
| `leads` | `id`, `name`, `company`, `phone`, `notes`, `status`, `created_at` |
| `calls` | `id`, `lead_id`, `twilio_sid`, `started_at`, `ended_at`, `duration_s`, `disposition`, `summary`, `next_step`, `voicemail_dropped`, `amd_verdict` |
| `transcript_turns` | `id`, `call_id`, `role` (`agent` \| `prospect`), `text`, `created_at` |
| `call_scores` | `call_id`, `agent_ms`, `prospect_ms`, `talk_ratio`, `agent_interruptions`, `discovery_questions_asked`, `objections` (jsonb), `yielded_correctly` |
| `qualifications` | `call_id`, `need`, `timing`, `authority`, `current_solution`, `score`, `raw` (jsonb) |
| `meetings` | `id`, `call_id`, `lead_id`, `slot_id`, `starts_at`, `confirmed` |
| `slots` | `id`, `starts_at`, `duration_min`, `taken` |

Transcript turns are written in batches during the call. That is what makes the live view work
over plain SSE without a second WebSocket to the browser.

`disposition` is one of: `booked`, `qualified_no_meeting`, `not_interested`, `callback`,
`voicemail`, `no_answer`, `failed`.

Frame counters accumulate in socket-handler memory and are written once at call end — never
per frame.

Database: local Postgres, per §12.

## 10. Failure modes

| Failure | Handling |
| --- | --- |
| Answering machine | Async AMD verdict → voicemail drop, disposition `voicemail`. See §7. |
| AMD false positive on a human | Prospect speaking during playback aborts the drop and reconnects the model session. Verdict logged for counting. |
| No answer | Disposition `no_answer`. No conversation attempted. |
| Realtime session drops mid-call | Agent speaks a fallback line, call hangs up, disposition `failed`. Partial transcript, qualification, and frame counts are retained. |
| `book_meeting` fails | Agent offers to follow up by email rather than asserting a booking that did not happen. |
| `save_qualification` fails | Logged and swallowed. It is fire-and-forget by design and must never surface to the caller. |
| Agent interrupts the prospect repeatedly | `silence_duration_ms` too low. Visible as rising `agent_interruptions` (§8) rather than as vague dissatisfaction. |
| Call hits the 300s ceiling | Socket closes; the status webhook still fires, so summary, disposition, and scores are produced from the partial transcript. |
| Destination not on allowlist | 403 from `POST /api/calls`, before any Twilio request. |
| Duplicate booking attempt | `book_meeting` is idempotent per call; a second attempt returns the existing meeting. |

## 11. Testing

- **Playbook, disposition logic, tool handlers, score computation** — pure functions, tested in
  isolation with no network. Frame-count-to-milliseconds math and talk-ratio derivation are
  trivially unit-testable and worth covering exactly because they look too simple to break.
- **Socket handler** — tested against recorded Twilio frame fixtures (a captured `start` event,
  a run of `media` frames, a `stop`). Barge-in is verified by asserting a `clear` is emitted on
  a simulated `speech_started`. The voicemail path and the false-positive abort each get a
  fixture. No live call required.
- **Allowlist enforcement** — explicit test that an off-list number is rejected.
- **Acceptance** — one manual end-to-end call to the operator's own phone reaching a booked
  meeting, with `agent_interruptions` at zero. One manual call left unanswered to confirm the
  voicemail drop fires and the recorded message plays cleanly.

## 12. Local-only constraint

Nothing may be deployed, pushed, or published. Consequences:

- **Hosting:** the app runs locally (`next dev`). Twilio must still reach the WebSocket, so
  Phase 1 uses an ngrok tunnel giving Twilio a temporary public URL to the local machine.
  Nothing is hosted; Twilio connects inbound only while a call is active.
- **Database:** local Postgres rather than a hosted provider. Same schema, same driver.
- **Voicemail audio:** served from the local app over the tunnel, not uploaded to storage.
- Twilio and the model APIs are unavoidable third-party calls — they are the product. No code,
  documents, or artifacts leave the machine.

## 13. Environment

```
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER
OPENAI_API_KEY          # realtime session
ANTHROPIC_API_KEY       # post-call reasoning and scoring
DATABASE_URL            # local Postgres
VERIFIED_NUMBERS        # comma-separated E.164 allowlist
PUBLIC_BASE_URL         # ngrok URL for TwiML stream, status callback, voicemail audio
VOICEMAIL_AUDIO_URL     # path to the operator's recorded message
```

## 14. Recording note

Twilio call recording is left **off**. Two-party consent applies in many jurisdictions, and the
transcript already satisfies every need this project has. If recording is enabled later, the
agent must disclose it in the opener.
