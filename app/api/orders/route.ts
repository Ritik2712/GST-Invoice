import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api'
import { isSettingsComplete } from '@/lib/gst/settings'
import { reconcileCancellations } from '@/lib/invoice-service'
import { ordersNotices, toOrderRow, type OrdersResponse } from '@/lib/order-rows'
import { fetchOrders, isCustomerDataAvailable } from '@/lib/shopify/orders'
import { getTokenStatus } from '@/lib/shopify/token'
import * as store from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Without `read_all_orders`, Shopify returns only the last 60 days of orders. */
const DATA_WINDOW_DAYS = 60

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams
    const pageSize = Number.parseInt(params.get('pageSize') ?? '25', 10)

    const [settings, page] = await Promise.all([
      store.getSettings(),
      fetchOrders({
        pageSize: Number.isFinite(pageSize) ? pageSize : 25,
        after: params.get('after'),
        before: params.get('before'),
        query: params.get('query'),
      }),
    ])

    // Orders cancelled since the last look get their stored invoice flagged.
    await reconcileCancellations(page.orders)

    const invoices = await store.getInvoicesByOrderId(page.orders.map((order) => order.id))
    const settingsComplete = isSettingsComplete(settings)

    const rows = page.orders.map((order) =>
      toOrderRow(order, invoices.get(order.id), settingsComplete, settings.allowTestOrderInvoices),
    )
    // Scopes arrive with a client-credentials token; a static token does not report them.
    const token = getTokenStatus()
    const grantedScopes = token.mode === 'client_credentials' && token.cached ? token.scopes : null

    const body: OrdersResponse = {
      rows,
      pageInfo: page.pageInfo,
      settingsComplete,
      dataWindowDays: DATA_WINDOW_DAYS,
      customerDataAvailable: isCustomerDataAvailable(),
      autoDownloadAfterGenerate: settings.autoDownloadAfterGenerate,
      notices: ordersNotices(rows, grantedScopes),
    }
    return NextResponse.json(body)
  } catch (error) {
    return errorResponse(error)
  }
}
