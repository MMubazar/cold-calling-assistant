import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const BACKEND = process.env.BACKEND_URL ?? 'http://127.0.0.1:8080'

/**
 * Dialling is forwarded to the backend call server rather than done here.
 * That server owns the Twilio credentials and the VERIFIED_NUMBERS allowlist,
 * and its 403 is the guard that keeps this project from calling strangers —
 * so the console must never place a call by another route.
 */
export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Send a JSON body.' }, { status: 400 })
  }

  try {
    const upstream = await fetch(`${BACKEND}/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })

    const text = await upstream.text()
    const payload = text.length > 0 ? JSON.parse(text) : {}
    return NextResponse.json(payload, { status: upstream.status })
  } catch {
    return NextResponse.json(
      { error: 'The call server is not reachable.' },
      { status: 503 },
    )
  }
}
