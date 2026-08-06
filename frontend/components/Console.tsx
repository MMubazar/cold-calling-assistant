'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { LeadList } from './LeadList'
import { LivePanel, type Turn } from './LivePanel'
import type { LeadRow } from '@/lib/db'
import { type CallSnapshot, LIVE_PHASES, phaseOf } from '@/lib/call-state'

interface StreamFrame {
  call: CallSnapshot | null
  turns: Turn[]
  done: boolean
}

export function Console({
  initialLeads,
  initialCall,
  initialTurns,
}: {
  initialLeads: LeadRow[]
  initialCall: CallSnapshot | null
  initialTurns: Turn[]
}) {
  const [leads, setLeads] = useState(initialLeads)
  const [call, setCall] = useState(initialCall)
  const [turns, setTurns] = useState(initialTurns)
  const [notice, setNotice] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [dialing, setDialing] = useState(false)

  const stream = useRef<EventSource | null>(null)

  const follow = useCallback((callId: string) => {
    stream.current?.close()
    const source = new EventSource(`/api/calls/${callId}/live`)
    stream.current = source

    source.onmessage = (event) => {
      const frame: StreamFrame = JSON.parse(event.data)
      if (frame.call) setCall(frame.call)
      if (frame.turns.length > 0) setTurns((prev) => [...prev, ...frame.turns])
      if (frame.done) {
        source.close()
        stream.current = null
        // The log and the lead list both change once a call resolves.
        void refreshLeads()
      }
    }

    source.onerror = () => {
      source.close()
      stream.current = null
      setNotice('Lost the live feed. The call may still be running — reload to reattach.')
    }
  }, [])

  // Reattach to a call that was already running when the page loaded.
  useEffect(() => {
    if (initialCall && LIVE_PHASES.includes(phaseOf(initialCall))) follow(initialCall.id)
    return () => stream.current?.close()
  }, [initialCall, follow])

  // Duration ticker. Derived from the start time so it survives a lost frame.
  useEffect(() => {
    if (!call) {
      setElapsed(0)
      return
    }
    if (call.endedAt) {
      setElapsed(call.durationS ?? 0)
      return
    }
    const start = new Date(call.startedAt).getTime()
    const tick = () => setElapsed((Date.now() - start) / 1000)
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [call])

  async function refreshLeads() {
    try {
      const res = await fetch('/api/leads', { cache: 'no-store' })
      if (res.ok) setLeads(await res.json())
    } catch {
      /* the list is stale, not broken — leave what is on screen */
    }
  }

  async function dial(lead: LeadRow) {
    setDialing(true)
    setNotice(null)
    setTurns([])
    setCall(null)
    try {
      const res = await fetch('/api/calls', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leadId: lead.id, to: lead.phone }),
      })
      const body = await res.json().catch(() => ({}))

      if (!res.ok) {
        setNotice(dialError(res.status, body?.error))
        return
      }
      follow(body.callId)
    } catch {
      setNotice(
        'Could not reach the call server. Start it with `npm start` in backend/, then try again.',
      )
    } finally {
      setDialing(false)
    }
  }

  async function addLead(name: string, company: string, phone: string): Promise<string | null> {
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, company, phone }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        return body?.error ?? 'Could not save that lead.'
      }
      const lead: LeadRow = await res.json()
      setLeads((prev) => [lead, ...prev])
      return null
    } catch {
      return 'Could not reach the database.'
    }
  }

  const busy = dialing || (call !== null && LIVE_PHASES.includes(phaseOf(call)))

  return (
    <div className="deck">
      <LeadList leads={leads} busy={busy} onDial={dial} onAdd={addLead} />
      <LivePanel call={call} turns={turns} elapsed={elapsed} notice={notice} />
    </div>
  )
}

/** Errors say what happened and what to do, in the console's own voice. */
function dialError(status: number, message?: string): string {
  if (status === 403) {
    return 'That number is not on your verified list. Add it to VERIFIED_NUMBERS in backend/.env and restart the call server.'
  }
  if (status === 404) return 'That lead no longer exists. Reload the page.'
  if (status === 502) return 'Twilio rejected the call. Check the credentials in backend/.env.'
  if (status === 503) {
    return 'The call server is not running. Start it with `npm start` in backend/, then try again.'
  }
  return message ?? 'The call could not be placed.'
}
