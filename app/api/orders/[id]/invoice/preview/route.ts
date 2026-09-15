import { type NextRequest } from 'next/server'

import { errorResponse, orderGid } from '@/lib/api'
import type { AppSettings } from '@/lib/gst/settings'
import { previewInvoiceForOrder } from '@/lib/invoice-service'

type Treatment = AppSettings['shippingTreatment']
const TREATMENTS: Treatment[] = ['APPORTION', 'COMPOSITE_LINE', 'SEPARATE_SERVICE']

function isTreatment(value: string | null): value is Treatment {
  return TREATMENTS.includes(value as Treatment)
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Dry run for one real order: the exact invoice it would get, rendered but never issued.
 * A GET is safe here precisely because nothing is allotted or written.
 *
 * `?shipping=APPORTION|COMPOSITE_LINE|SEPARATE_SERVICE` previews a different delivery
 * treatment without saving it to Settings, so the three can be compared side by side.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const shipping = request.nextUrl.searchParams.get('shipping')
    const { invoice, pdf } = await previewInvoiceForOrder(orderGid(id), {
      shippingTreatment: isTreatment(shipping) ? shipping : null,
    })
    const download = request.nextUrl.searchParams.get('download') === '1'

    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.byteLength),
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="preview-${invoice.order.number}.pdf"`,
        'Cache-Control': 'no-store',
        // Handy for the UI without parsing the PDF.
        'X-Invoice-Number': invoice.invoiceNumber,
        'X-Invoice-Total': String(invoice.totals.grandTotal),
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
