import { expect, it } from 'vitest'
import {
  LIVE_PHASES,
  PITCHING,
  TARGET_HIGH,
  TARGET_LOW,
  dispositionClass,
  mergeTurns,
  phaseOf,
  shareVerdict,
  talkShare,
  type CallSnapshot,
} from './call-state'

function snapshot(over: Partial<CallSnapshot> = {}): CallSnapshot {
  return {
    id: 'c1',
    leadName: 'Ali',
    leadCompany: 'Acme',
    leadPhone: '+923001234567',
    startedAt: '2026-08-06T10:00:00.000Z',
    endedAt: null,
    durationS: null,
    disposition: null,
    voicemailDropped: false,
    amdVerdict: null,
    agentMs: 0,
    prospectMs: 0,
    agentInterruptions: 0,
    meetingAt: null,
    ...over,
  }
}

// ------------------------------------------------------------------ talk share

it('reports no share when nobody has spoken, rather than dividing by zero', () => {
  expect(talkShare(0, 0)).toBe(0)
  expect(shareVerdict(0, 0)).toBe('no speech yet')
})

it('computes the agent share of speaking time', () => {
  expect(talkShare(4000, 6000)).toBeCloseTo(0.4)
})

// The playbook target is 40-50 %: the agent asks, the prospect talks.
it('calls the 40-50 % band on target', () => {
  expect(shareVerdict(TARGET_LOW * 10_000, (1 - TARGET_LOW) * 10_000)).toBe('on target')
  expect(shareVerdict(TARGET_HIGH * 10_000, (1 - TARGET_HIGH) * 10_000)).toBe('on target')
  expect(shareVerdict(4500, 5500)).toBe('on target')
})

it('says the agent is listening more than target below 40 %', () => {
  expect(shareVerdict(3000, 7000)).toBe('agent is listening more than target')
})

it('distinguishes slightly over target from pitching', () => {
  expect(shareVerdict(5500, 4500)).toBe('agent slightly over target')
  expect(shareVerdict(6000, 4000)).toBe('agent slightly over target') // exactly 60 % is not yet pitching
})

// Past 60 % the agent is pitching rather than discovering. This is the number the
// whole system exists to produce, so the threshold is pinned.
it('calls anything over 60 % pitching', () => {
  expect(PITCHING).toBe(0.6)
  expect(shareVerdict(6001, 3999)).toBe('pitching — agent is over 60 %')
  expect(shareVerdict(9000, 1000)).toBe('pitching — agent is over 60 %')
})

// -------------------------------------------------------------------- phaseOf

it('is ready when there is no call at all', () => {
  expect(phaseOf(null)).toBe('ready')
})

it('is ringing while a live call has counted no audio yet', () => {
  expect(phaseOf(snapshot())).toBe('ringing')
})

it('is connected once either side has spoken', () => {
  expect(phaseOf(snapshot({ agentMs: 40 }))).toBe('connected')
})

// The regression that bricked the console: a call that rang out was never
// finalized, so this row came back as the live call on every load, phaseOf saw
// zero audio and returned 'ringing', and 'ringing' keeps the Call button
// disabled. A finalized call with no audio must never read as live.
it('is ended, not ringing, for a finalized call that counted no audio', () => {
  const rungOut = snapshot({
    endedAt: '2026-08-06T10:00:30.000Z',
    durationS: 30,
    disposition: 'no_answer',
  })
  expect(phaseOf(rungOut)).toBe('ended')
  expect(LIVE_PHASES).not.toContain(phaseOf(rungOut))
})

it('is failed for a call that dropped', () => {
  expect(phaseOf(snapshot({ endedAt: '2026-08-06T10:00:30.000Z', disposition: 'failed' })))
    .toBe('failed')
})

it('is voicemail while the recorded message is playing', () => {
  expect(phaseOf(snapshot({ voicemailDropped: true }))).toBe('voicemail')
})

// ------------------------------------------------------------ dispositionClass

it('styles a booked call apart from a dead one', () => {
  expect(dispositionClass('booked')).toBe('chip-booked')
  expect(dispositionClass('qualified_no_meeting')).toBe('chip-progress')
  expect(dispositionClass('callback')).toBe('chip-progress')
  expect(dispositionClass('voicemail')).toBe('chip-machine')
  expect(dispositionClass('failed')).toBe('chip-failed')
  expect(dispositionClass(null)).toBe('chip-progress')
})

it('treats an unrecognised disposition as a dead end rather than throwing', () => {
  expect(dispositionClass('no_answer')).toBe('chip-dead')
  expect(dispositionClass('not_interested')).toBe('chip-dead')
})

// ------------------------------------------------------------------ mergeTurns

const turn = (id: string) => ({ id, role: 'agent' as const, text: `t${id}` })

it('appends new turns in arrival order', () => {
  expect(mergeTurns([turn('1')], [turn('2'), turn('3')]).map((t) => t.id)).toEqual(['1', '2', '3'])
})

// The re-attach defect: the page seeds turns server-side and the stream's first
// frame returns the same ones, so every turn rendered twice with duplicate keys.
it('drops turns already on screen instead of rendering them twice', () => {
  const seeded = [turn('1'), turn('2')]
  expect(mergeTurns(seeded, [turn('1'), turn('2'), turn('3')]).map((t) => t.id))
    .toEqual(['1', '2', '3'])
})

it('dedups repeats within a single frame too', () => {
  expect(mergeTurns([], [turn('1'), turn('1')]).map((t) => t.id)).toEqual(['1'])
})

it('returns the same array when a frame carries nothing new', () => {
  const seeded = [turn('1')]
  expect(mergeTurns(seeded, [])).toBe(seeded)
  expect(mergeTurns(seeded, [turn('1')])).toBe(seeded)
})
