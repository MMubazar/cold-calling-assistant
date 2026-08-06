import { NextResponse } from 'next/server'
import { createLead, listLeads } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** Mirrors backend/src/lib/allowlist.ts so the form rejects what the dialer would. */
const E164 = /^\+[1-9]\d{7,14}$/

function normalize(raw: string): string | null {
  const stripped = raw.replace(/[\s()\-.]/g, '')
  return E164.test(stripped) ? stripped : null
}

export async function GET() {
  try {
    return NextResponse.json(await listLeads())
  } catch {
    return NextResponse.json({ error: 'Cannot reach the database.' }, { status: 503 })
  }
}

export async function POST(request: Request) {
  let body: { name?: string; company?: string; phone?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Send a JSON body.' }, { status: 400 })
  }

  const name = body.name?.trim()
  const phone = body.phone?.trim()

  if (!name) {
    return NextResponse.json({ error: 'A name is required.' }, { status: 400 })
  }
  if (!phone) {
    return NextResponse.json({ error: 'A phone number is required.' }, { status: 400 })
  }

  const normalized = normalize(phone)
  if (!normalized) {
    return NextResponse.json(
      { error: 'Use international format, starting with + and the country code.' },
      { status: 400 },
    )
  }

  try {
    const rows = await createLead(name, body.company?.trim() || null, normalized)
    return NextResponse.json(rows[0], { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Could not save that lead.' }, { status: 503 })
  }
}
