import { NextResponse } from 'next/server'

import { errorResponse } from '@/lib/api'
import * as store from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json({ invoices: await store.listInvoices(), counter: await store.getCounter() })
  } catch (error) {
    return errorResponse(error)
  }
}
