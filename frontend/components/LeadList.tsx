'use client'

import { useState } from 'react'
import type { LeadRow } from '@/lib/db'
import { dispositionClass, dispositionLabel } from '@/lib/call-state'

/**
 * The lead list is the only place a call starts. One control per row, named
 * for what it does, disabled while any call is running — you cannot dial two
 * people at once and the interface should say so rather than fail later.
 */
export function LeadList({
  leads,
  busy,
  onDial,
  onAdd,
}: {
  leads: LeadRow[]
  busy: boolean
  onDial: (lead: LeadRow) => void
  onAdd: (name: string, company: string, phone: string) => Promise<string | null>
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="eyebrow">Leads</span>
        <span className="panel-count">{leads.length}</span>
      </div>

      {leads.length === 0 ? (
        <p className="log-empty">No leads yet. Add the first one below.</p>
      ) : (
        <ul className="lead-list">
          {leads.map((lead) => (
            <li className="lead" key={lead.id}>
              <div>
                <div className="lead-name">
                  {lead.name}
                  {lead.company && <span className="lead-org"> · {lead.company}</span>}
                </div>
                <div className="lead-phone">{lead.phone}</div>
                {lead.last_disposition && (
                  <div style={{ marginTop: 6 }}>
                    <span className={`chip ${dispositionClass(lead.last_disposition)}`}>
                      {dispositionLabel(lead.last_disposition)}
                    </span>
                  </div>
                )}
              </div>
              <button
                className="dial"
                onClick={() => onDial(lead)}
                disabled={busy}
                title={busy ? 'A call is already running' : `Call ${lead.name}`}
              >
                Call
              </button>
            </li>
          ))}
        </ul>
      )}

      <AddLead onAdd={onAdd} />
    </div>
  )
}

function AddLead({
  onAdd,
}: {
  onAdd: (name: string, company: string, phone: string) => Promise<string | null>
}) {
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const ready = name.trim().length > 0 && phone.trim().length > 0

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!ready || saving) return
    setSaving(true)
    setError(null)
    const failure = await onAdd(name.trim(), company.trim(), phone.trim())
    setSaving(false)
    if (failure) {
      setError(failure)
      return
    }
    setName('')
    setCompany('')
    setPhone('')
  }

  return (
    <form className="add-lead" onSubmit={submit}>
      <span className="eyebrow">Add a lead</span>
      <div className="add-lead-fields">
        <input
          className="field"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Lead name"
        />
        <input
          className="field"
          placeholder="Company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          aria-label="Company"
        />
        <input
          className="field field-phone"
          placeholder="+923001234567"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-label="Phone number in international format"
        />
      </div>
      {error && <p className="notice">{error}</p>}
      <button className="add-lead-submit" type="submit" disabled={!ready || saving}>
        {saving ? 'Saving' : 'Add lead'}
      </button>
    </form>
  )
}
