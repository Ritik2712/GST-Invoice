import { formatIstDate } from './gst/fy'
import { checkInvoiceability } from './gst/invoice'
import { invoiceFileKey } from './gst/numbering'
import { resolvePlaceOfSupply } from './gst/placeOfSupply'
import type { FinancialStatus, InvoiceSeries, NormalizedOrder } from './gst/types'
import type { InvoiceIndexEntry } from './store'

/** What the Orders table renders. Shared by the API route and the client component. */
export interface OrderRow {
  id: string
  legacyId: string
  name: string
  createdAt: string
  displayDate: string
  customerName: string
  placeOfSupply: { code: string; name: string } | null
  total: number
  currency: string
  financialStatus: FinancialStatus
  isTest: boolean
  cancelledAt: string | null
  invoiceNumber: string | null
  /** URL-safe form of the invoice number, used in the PDF route. */
  invoiceKey: string | null
  /** Which numbering series this order's invoices belong to, once it has any. */
  invoiceSeries: InvoiceSeries | null
  /**
   * Invoices cancelled for this order, oldest first. They keep their numbers for ever and
   * stay downloadable; the order itself is free to be invoiced again.
   */
  cancelledInvoices: Array<{ invoiceNumber: string; invoiceKey: string; cancelledAt: string | null }>
  invoiceStatus: 'ISSUED' | 'CANCELLED' | 'NOT_INVOICED' | 'NOT_INVOICEABLE'
  canDownload: boolean
  /** Why the download button is disabled, shown as a tooltip / status detail. */
  blockedReason: string | null
}

export interface OrdersResponse {
  rows: OrderRow[]
  pageInfo: {
    hasNextPage: boolean
    hasPreviousPage: boolean
    startCursor: string | null
    endCursor: string | null
  }
  settingsComplete: boolean
  /** Oldest order Shopify will return without the protected customer-data scope. */
  dataWindowDays: number
  /**
   * False when `read_customers` is not granted. Everything still works; only the
   * customer's default address - the third place-of-supply fallback - is unavailable.
   */
  customerDataAvailable: boolean
  /** Mirrors the Settings checkbox: start the download as soon as an invoice is issued. */
  autoDownloadAfterGenerate: boolean
  /** Facts that decide which informational banners are worth showing. */
  notices: OrdersNotices
}

/**
 * Informational banners are driven by facts about this store and this page, not shown
 * unconditionally: a banner that is always on gets ignored, and then is missed on the day
 * it actually matters.
 */
export interface OrdersNotices {
  /**
   * True when Shopify is known to be limiting orders to the last 60 days (`read_all_orders`
   * not granted). Null when the granted scopes cannot be read - a static token does not
   * report them - in which case the screen stays cautious and mentions the limit.
   */
  limitedTo60Days: boolean | null
  /**
   * Orders on this page that still need an invoice but have no Indian address to take a
   * place of supply from. Already-invoiced and cancelled orders are left out: there is
   * nothing left to do for them.
   */
  ordersWithoutAddress: string[]
}

export function ordersNotices(rows: OrderRow[], grantedScopes: string[] | null): OrdersNotices {
  return {
    limitedTo60Days: grantedScopes ? !grantedScopes.includes('read_all_orders') : null,
    ordersWithoutAddress: rows
      .filter((row) => row.placeOfSupply === null && !row.invoiceKey && !row.cancelledAt)
      .map((row) => row.name),
  }
}

export function toOrderRow(
  order: NormalizedOrder,
  invoices: InvoiceIndexEntry[] | undefined,
  settingsComplete: boolean,
): OrderRow {
  const place = resolvePlaceOfSupply(order)
  const all = invoices ?? []
  const live = all.filter((e) => e.status === 'ISSUED').at(-1) ?? null
  const cancelledInvoices = all
    .filter((e) => e.status === 'CANCELLED')
    .map((e) => ({
      invoiceNumber: e.invoiceNumber,
      invoiceKey: invoiceFileKey(e.invoiceNumber),
      cancelledAt: e.cancelledAt ?? null,
    }))

  // A live invoice is always downloadable - the document exists and must stay retrievable.
  if (live) {
    return {
      ...base(order, place),
      invoiceNumber: live.invoiceNumber,
      invoiceKey: invoiceFileKey(live.invoiceNumber),
      invoiceSeries: live.series,
      cancelledInvoices,
      invoiceStatus: 'ISSUED',
      canDownload: true,
      blockedReason: null,
    }
  }

  // Cancelled invoices leave the order invoiceable again; their numbers stay consumed.
  const check = checkInvoiceability(order, settingsComplete)
  return {
    ...base(order, place),
    invoiceNumber: null,
    invoiceKey: null,
    invoiceSeries: all.at(-1)?.series ?? null,
    cancelledInvoices,
    invoiceStatus: cancelledInvoices.length
      ? 'CANCELLED'
      : check.invoiceable
        ? 'NOT_INVOICED'
        : 'NOT_INVOICEABLE',
    canDownload: check.invoiceable,
    blockedReason: check.invoiceable ? null : check.message,
  }
}

function base(order: NormalizedOrder, place: ReturnType<typeof resolvePlaceOfSupply>) {
  return {
    id: order.id,
    legacyId: order.id.split('/').pop() ?? '',
    name: order.name,
    createdAt: order.createdAt,
    displayDate: formatIstDate(new Date(order.processedAt ?? order.createdAt)),
    customerName: order.customerName ?? '-',
    placeOfSupply: place ? { code: place.stateCode, name: place.stateName } : null,
    total: order.orderTotal,
    currency: order.currency,
    financialStatus: order.financialStatus,
    isTest: order.isTest,
    cancelledAt: order.cancelledAt ?? null,
  }
}
