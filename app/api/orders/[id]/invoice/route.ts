import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse, orderGid } from '@/lib/api'
import { invoiceFileKey } from '@/lib/gst/numbering'
import { getOrIssueInvoice } from '@/lib/invoice-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Issues the invoice for an order, or returns the existing one untouched.
 *
 * Deliberately a POST: allotting an invoice number is a state change, so it must not be
 * reachable by a link prefetch or a browser preview request. The client follows up with a
 * GET on the returned PDF URL, which only ever replays a stored snapshot.
 */
export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const { invoice, created } = await getOrIssueInvoice(orderGid(id))
    return NextResponse.json({
      invoiceNumber: invoice.invoiceNumber,
      invoiceKey: invoiceFileKey(invoice.invoiceNumber),
      status: invoice.status,
      issuedAt: invoice.issuedAt,
      grandTotal: invoice.totals.grandTotal,
      taxKind: invoice.taxKind,
      placeOfSupply: invoice.placeOfSupply,
      pdfUrl: `/api/invoices/${invoiceFileKey(invoice.invoiceNumber)}/pdf`,
      created,
    })
  } catch (error) {
    return errorResponse(error)
  }
}
