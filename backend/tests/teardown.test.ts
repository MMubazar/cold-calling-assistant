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
