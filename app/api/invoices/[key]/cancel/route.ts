import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api'
import { cancelIssuedInvoice } from '@/lib/invoice-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Cancels an issued invoice. The file is kept, the number stays consumed, and the order
 * becomes invoiceable again so a corrected invoice can take the next number.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await context.params
    const body = (await request.json().catch(() => ({}))) as { reason?: string }
    const invoice = await cancelIssuedInvoice(key, body.reason ?? '')

    return NextResponse.json({
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      cancelledAt: invoice.cancelledAt,
      cancellationReason: invoice.cancellationReason,
    })
  } catch (error) {
    return errorResponse(error)
  }
}
