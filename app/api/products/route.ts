import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api'
import { auditCatalogue, resolveProductRates } from '@/lib/product-rates'
import { fetchProducts } from '@/lib/shopify/products'
import * as store from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Catalogue with the GST treatment each product would get, and where that treatment comes
 * from. Read-only: nothing is written and no invoice number is touched.
 *
 *   GET /api/products                       first 50, by title
 *   GET /api/products?first=250             a bigger page
 *   GET /api/products?query=shirt           Shopify product search syntax
 *   GET /api/products?after=<cursor>        next page
 *   GET /api/products?audit=1               summary only, no per-product rows
 */
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams
    const first = Number.parseInt(params.get('first') ?? '50', 10)

    const [settings, table, page] = await Promise.all([
      store.getSettings(),
      store.getRateTable(),
      fetchProducts({
        first: Number.isFinite(first) ? first : 50,
        after: params.get('after'),
        query: params.get('query'),
      }),
    ])

    const products = resolveProductRates(page.products, table, settings)
    const audit = auditCatalogue(products)
    const auditOnly = params.get('audit') === '1'

    return NextResponse.json({
      audit,
      rateTableVersion: table.version,
      defaultHsn: settings.defaultHsn,
      pricesIncludeGst: settings.pricesIncludeGst,
      pageInfo: page.pageInfo,
      ...(auditOnly ? {} : { products }),
    })
  } catch (error) {
    return errorResponse(error)
  }
}
