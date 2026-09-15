import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api'
import { resolveProductDetail } from '@/lib/product-rates'
import { fetchProduct } from '@/lib/shopify/products'
import * as store from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One product, with the GST treatment each variant would get and the full rule trace that
 * produced it. Read-only.
 *
 *   GET /api/products/8123456789012        numeric product id
 *   GET /api/products/mens-black-shirt     product handle
 *   GET /api/products/<id>?trace=0         omit the per-variant rule trace
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const [settings, table, product] = await Promise.all([
      store.getSettings(),
      store.getRateTable(),
      fetchProduct(decodeURIComponent(id)),
    ])
    if (!product) {
      return NextResponse.json(
        { error: `No product found for "${id}". Pass a numeric product id or a handle.`, code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    const detail = resolveProductDetail(product, table, settings)
    const withTrace = request.nextUrl.searchParams.get('trace') !== '0'

    return NextResponse.json({
      rateTableVersion: table.version,
      defaultHsn: settings.defaultHsn,
      pricesIncludeGst: settings.pricesIncludeGst,
      product: withTrace
        ? detail
        : { ...detail, variants: detail.variants.map(({ trace, ...rest }) => rest) },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
