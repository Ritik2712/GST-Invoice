import { type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api'
import { financialYearKeyIst } from '@/lib/gst/fy'
import { renderInvoicePdf } from '@/lib/pdf/render'
import { buildSamplePreview } from '@/lib/sample-invoice'
import * as store from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Layout preview: renders a fabricated order through the real engine and the real template
 * using your current settings and rate table.
 *
 * Read-only by construction - it never calls `store.issueInvoice`, so no number is
 * allotted and no file is written. The PDF is stamped SAMPLE so it cannot be mistaken for
 * a tax invoice.
 *
 *   GET /api/sample-invoice              place of supply = seller state (CGST + SGST)
 *   GET /api/sample-invoice?pos=29       place of supply = Karnataka (IGST)
 *   GET /api/sample-invoice?download=1   download instead of viewing inline
 */
export async function GET(request: NextRequest) {
  try {
    const [settings, rateTable] = await Promise.all([store.getSettings(), store.getRateTable()])
    const lastIssued = await store.getLastIssued(financialYearKeyIst(new Date()))

    const { invoice } = buildSamplePreview({
      settings,
      rateTable,
      lastIssued,
      placeOfSupplyStateCode: request.nextUrl.searchParams.get('pos'),
    })

    const pdf = await renderInvoicePdf(invoice, { watermark: 'SAMPLE' })
    const download = request.nextUrl.searchParams.get('download') === '1'

    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.byteLength),
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="sample-invoice.pdf"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
