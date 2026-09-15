import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api'
import * as store from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The frozen snapshot, exactly as stored. */
export async function GET(_request: NextRequest, context: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await context.params
    const invoice = await store.getInvoice(key)
    if (!invoice) return NextResponse.json({ error: 'Invoice not found', code: 'NOT_FOUND' }, { status: 404 })
    return NextResponse.json(invoice)
  } catch (error) {
    return errorResponse(error)
  }
}
