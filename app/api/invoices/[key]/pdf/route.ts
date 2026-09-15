import { type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api'
import { pdfFileName, renderInvoicePdf } from '@/lib/pdf/render'
import * as store from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Re-renders the stored snapshot. Nothing is recalculated and no number is allotted, so
 * this is safe to call any number of times - including for a cancelled invoice, which
 * still has to be retrievable.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await context.params
    const invoice = await store.getInvoice(key)
    if (!invoice) {
      return new Response(JSON.stringify({ error: 'Invoice not found', code: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const pdf = await renderInvoicePdf(invoice)
    const inline = request.nextUrl.searchParams.get('disposition') === 'inline'

    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.byteLength),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${pdfFileName(invoice)}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
