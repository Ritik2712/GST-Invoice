import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse, orderGid } from '@/lib/api'
import { checkInvoiceability } from '@/lib/gst/invoice'
import { invoiceFileKey } from '@/lib/gst/numbering'
import { resolvePlaceOfSupply } from '@/lib/gst/placeOfSupply'
import { explainRules } from '@/lib/gst/rates'
import { isSettingsComplete } from '@/lib/gst/settings'
import { effectiveRateTable } from '@/lib/invoice-service'
import { fetchOrderWithRaw } from '@/lib/shopify/orders'
import * as store from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One order, in four layers: Shopify's raw response, the normalised order the engine sees,
 * the GST decisions taken from it, and its invoice history.
 *
 *   GET /api/orders/6727651950769          everything
 *   GET /api/orders/<id>?raw=0             skip Shopify's raw payload
 *   GET /api/orders/<id>?trace=0           skip the per-line rule trace
 *
 * Read-only: no number is allotted and nothing is written. The response carries the
 * customer's name, address, email and phone, so treat it as you would the order itself.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const params = request.nextUrl.searchParams

    const [settings, rawTable, fetched] = await Promise.all([
      store.getSettings(),
      store.getRateTable(),
      fetchOrderWithRaw(orderGid(id)),
    ])

    if (!fetched) {
      return NextResponse.json(
        { error: `No order found for "${id}". Pass the numeric order id.`, code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    const { order, raw, blocks } = fetched
    const table = effectiveRateTable(rawTable, settings)
    const withTrace = params.get('trace') !== '0'

    // Every line as the engine sees it, with the rule that decides its rate and HSN.
    const lines = order.lines.map((line) => {
      const { evaluations, resolved } = explainRules(line, table, settings.pricesIncludeGst)
      return {
        id: line.id,
        title: line.title,
        variantTitle: line.variantTitle ?? null,
        sku: line.sku ?? null,
        productType: line.productType ?? null,
        vendor: line.vendor ?? null,
        tags: line.tags ?? [],
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount,
        hsnOverride: line.hsnOverride ?? null,
        resolved,
        ...(withTrace ? { trace: evaluations } : {}),
      }
    })

    const history = (await store.getInvoicesByOrderId()).get(order.id) ?? []

    return NextResponse.json({
      order,
      placeOfSupply: resolvePlaceOfSupply(order),
      invoiceability: checkInvoiceability(
        order,
        isSettingsComplete(settings),
        settings.allowTestOrderInvoices,
      ),
      lines,
      shipping: order.shipping,
      invoices: history.map((entry) => ({
        ...entry,
        invoiceKey: invoiceFileKey(entry.invoiceNumber),
        pdfUrl: `/api/invoices/${invoiceFileKey(entry.invoiceNumber)}/pdf`,
      })),
      /** Which optional query blocks were available; a false one explains missing data. */
      shopifyBlocks: blocks,
      rateTableVersion: table.version,
      ...(params.get('raw') === '0' ? {} : { raw }),
    })
  } catch (error) {
    return errorResponse(error)
  }
}
