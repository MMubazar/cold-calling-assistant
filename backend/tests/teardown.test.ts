import {
  persistCallResult,
  persistUnbridgedCall,
  dispositionForCallStatus,
} from '../src/call/teardown.js'
import type { Db } from '../src/lib/db.js'
import type { CallResult } from '../src/call/session.js'

const result: CallResult = {
  disposition: 'booked',
  audio: { agentMs: 60000, prospectMs: 90000, talkRatio: 0.4, agentInterruptions: 2 },
  voicemailDropped: false,
  amdVerdict: 'human',
}

it('writes disposition and scores in one call', async () => {
  const seen: any[] = []
  const db = { finalizeCall: async (id: string, input: unknown) => { seen.push([id, input]) } } as unknown as Db
  await persistCallResult(db, 'c1', result)
  expect(seen[0][0]).toBe('c1')
  expect(seen[0][1].disposition).toBe('booked')
  expect(seen[0][1].audio.agentInterruptions).toBe(2)
})

// The duration is computed in SQL from calls.started_at so it matches the clock
// the console has been ticking since the row was inserted. Nothing is passed in.
it('passes no duration — the database derives it from started_at', async () => {
  const seen: any[] = []
  const db = { finalizeCall: async (_id: string, input: unknown) => { seen.push(input) } } as unknown as Db
  await persistCallResult(db, 'c1', result)
  expect(seen[0]).not.toHaveProperty('durationS')
})

it('never throws — a failed teardown must not crash the server', async () => {
  const db = { finalizeCall: async () => { throw new Error('db gone') } } as unknown as Db
  await expect(persistCallResult(db, 'c1', result)).resolves.toBeUndefined()
})

it('finalizes an unbridged call through the dedicated db path', async () => {
  const seen: [string, string][] = []
  const db = {
    finalizeUnbridgedCall: async (id: string, d: string) => { seen.push([id, d]) },
  } as unknown as Db
  await persistUnbridgedCall(db, 'c1', 'no_answer')
  expect(seen).toEqual([['c1', 'no_answer']])
})

it('never throws when finalizing an unbridged call fails', async () => {
  const db = { finalizeUnbridgedCall: async () => { throw new Error('db gone') } } as unknown as Db
  await expect(persistUnbridgedCall(db, 'c1', 'no_answer')).resolves.toBeUndefined()
})

// no_answer is a required disposition in the design spec and was written by
// nothing at all: a call that rang out stayed NULL forever, and the console then
// treated that dead row as the live call on every load.
it('maps a rung-out call to no_answer and a failed one to failed', () => {
  expect(dispositionForCallStatus('no-answer')).toBe('no_answer')
  expect(dispositionForCallStatus('busy')).toBe('no_answer')
  expect(dispositionForCallStatus('canceled')).toBe('no_answer')
  expect(dispositionForCallStatus('')).toBe('no_answer')
  expect(dispositionForCallStatus('failed')).toBe('failed')
})
