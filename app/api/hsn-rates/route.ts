import { NextResponse } from 'next/server'

import { errorResponse } from '@/lib/api'
import * as store from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Read-only view of the rate table. The file at data/hsn-rates.json is meant to be edited
 * directly; exposing it here makes it easy to confirm which rules are live.
 */
export async function GET() {
  try {
    return NextResponse.json(await store.getRateTable())
  } catch (error) {
    return errorResponse(error)
  }
}
