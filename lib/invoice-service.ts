import { financialYearKeyIst } from './gst/fy'
import { buildInvoice, checkInvoiceability, prefixFor, seriesFor } from './gst/invoice'
import { formatInvoiceNumber } from './gst/numbering'
import { isSettingsComplete, type AppSettings } from './gst/settings'
import type { InvoiceSnapshot, NormalizedOrder, RateTable } from './gst/types'
import { renderInvoicePdf } from './pdf/render'
import { fetchOrder } from './shopify/orders'
import * as store from './store'

/**
 * Ties the pure engine, the Shopify layer and the store together. This is the only place
 * that decides whether an order gets a *new* invoice or an existing snapshot is replayed.
 */

export class InvoiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'InvoiceError'
  }
}

/** The default HSN from Settings is the table's fallback HSN. */
export function effectiveRateTable(table: RateTable, settings: AppSettings): RateTable {
  return {
    ...table,
    fallback: {
      hsn: settings.defaultHsn || table.fallback.hsn,
      rate: table.fallback.rate,
    },
  }
}

export interface IssueResult {
  invoice: InvoiceSnapshot
  pdf: Buffer
  /** False when a stored snapshot was replayed rather than a new number allotted. */
  created: boolean
}

/**
 * Returns the invoice for an order, issuing one if it does not exist yet.
 *
 * Existing invoice  -> replayed verbatim from the snapshot; nothing is recalculated, so a
 *                      later change to settings or the rate table cannot alter it. If the
 *                      order has since been cancelled, the snapshot is flagged CANCELLED
 *                      but keeps its number and its numbers.
 * No invoice yet    -> invoiceability is checked first (paid, not cancelled, resolvable
 *                      place of supply). The number is allotted, the PDF rendered and the
 *                      snapshot written before the counter is advanced, so a failure
 *                      anywhere burns no number.
 */
export async function getOrIssueInvoice(orderId: string): Promise<IssueResult> {
  const existing = await store.getInvoiceForOrder(orderId)
  if (existing) {
    const reconciled = await reconcileCancellation(existing)
    return { invoice: reconciled, pdf: await renderInvoicePdf(reconciled), created: false }
  }

  const [settings, rawTable, order] = await Promise.all([
    store.getSettings(),
    store.getRateTable(),
    fetchOrder(orderId),
  ])

  if (!order) {
    throw new InvoiceError('Order not found in Shopify', 'ORDER_NOT_FOUND', 404)
  }

  const check = checkInvoiceability(order, isSettingsComplete(settings))
  if (!check.invoiceable) {
    throw new InvoiceError(check.message, check.reason, 409)
  }

  const issuedAt = new Date()
  const financialYear = financialYearKeyIst(issuedAt)
  const rateTable = effectiveRateTable(rawTable, settings)
  // A Shopify test order gets a number from the TEST series, never from the real one.
  const series = seriesFor(order)

  let pdf: Buffer | null = null

  const invoice = await store.issueInvoice(series, financialYear, async (sequence) => {
    const snapshot = buildInvoice({
      order,
      settings,
      rateTable,
      series,
      invoiceNumber: formatInvoiceNumber(prefixFor(series, settings), financialYear, sequence),
      financialYear,
      sequence,
      issuedAt,
    })
    // Render before the store commits anything: a PDF failure must not burn a number.
    pdf = await renderInvoicePdf(snapshot)
    return snapshot
  })

  // Settings shows the real series only, so a test invoice must not move it.
  if (series === 'REAL') await syncSettingsCounter(settings, invoice.sequence)

  return { invoice, pdf: pdf!, created: true }
}

/**
 * Dry run: builds and renders the invoice an order *would* get, without allotting a number
 * or writing anything. Use it to check rates, HSN codes and the tax split before committing
 * to a number that can never be reused.
 *
 * If the order already has an invoice, the stored snapshot is returned instead - a preview
 * must never contradict an issued document.
 */
export interface PreviewOverrides {
  /** Try a different delivery treatment without saving it to Settings. */
  shippingTreatment?: AppSettings['shippingTreatment'] | null
}

export async function previewInvoiceForOrder(
  orderId: string,
  overrides: PreviewOverrides = {},
): Promise<IssueResult> {
  const existing = await store.getInvoiceForOrder(orderId)
  if (existing) {
    return { invoice: existing, pdf: await renderInvoicePdf(existing), created: false }
  }

  const [stored, rawTable, order] = await Promise.all([
    store.getSettings(),
    store.getRateTable(),
    fetchOrder(orderId),
  ])
  if (!order) throw new InvoiceError('Order not found in Shopify', 'ORDER_NOT_FOUND', 404)

  const settings: AppSettings = overrides.shippingTreatment
    ? { ...stored, shippingTreatment: overrides.shippingTreatment }
    : stored

  const check = checkInvoiceability(order, isSettingsComplete(settings))
  if (!check.invoiceable) throw new InvoiceError(check.message, check.reason, 409)

  const issuedAt = new Date()
  const financialYear = financialYearKeyIst(issuedAt)
  const series = seriesFor(order)
  const sequence = (await store.getLastIssued(series, financialYear)) + 1

  const invoice = buildInvoice({
    order,
    settings,
    rateTable: effectiveRateTable(rawTable, settings),
    series,
    invoiceNumber: formatInvoiceNumber(prefixFor(series, settings), financialYear, sequence),
    financialYear,
    sequence,
    issuedAt,
  })

  return { invoice, pdf: await renderInvoicePdf(invoice, { watermark: 'PREVIEW' }), created: false }
}

/** Re-renders an already-issued invoice. Never allots a number. */
export async function renderExistingInvoice(invoiceNumber: string): Promise<IssueResult> {
  const invoice = await store.getInvoice(invoiceNumber)
  if (!invoice) throw new InvoiceError('Invoice not found', 'INVOICE_NOT_FOUND', 404)
  return { invoice, pdf: await renderInvoicePdf(invoice), created: false }
}

/**
 * Cancels an invoice on request (a wrong rate, a wrong address, a duplicate). The snapshot
 * is flagged CANCELLED with a timestamp and reason and is never deleted, and its number is
 * never reused - a cancelled tax invoice still has to be reportable. The order then becomes
 * invoiceable again, so a corrected invoice takes the *next* number.
 */
export async function cancelIssuedInvoice(
  invoiceNumber: string,
  reason: string,
): Promise<InvoiceSnapshot> {
  const existing = await store.getInvoice(invoiceNumber)
  if (!existing) throw new InvoiceError('Invoice not found', 'INVOICE_NOT_FOUND', 404)
  if (existing.status === 'CANCELLED') {
    throw new InvoiceError('This invoice is already cancelled', 'ALREADY_CANCELLED', 409)
  }

  const trimmed = reason.trim()
  if (trimmed.length < 3) {
    throw new InvoiceError('Give a reason for the cancellation', 'REASON_REQUIRED', 422)
  }

  const cancelled = await store.cancelInvoice(invoiceNumber, new Date().toISOString(), trimmed)
  if (!cancelled) throw new InvoiceError('Invoice not found', 'INVOICE_NOT_FOUND', 404)
  return cancelled
}

/**
 * An order cancelled *after* invoicing keeps its invoice; the snapshot is marked CANCELLED
 * with a timestamp and reason. The file is never deleted and the number is never reused.
 */
export async function reconcileCancellation(invoice: InvoiceSnapshot): Promise<InvoiceSnapshot> {
  if (invoice.status === 'CANCELLED') return invoice

  const order = await fetchOrder(invoice.order.id).catch(() => null)
  if (!order?.cancelledAt) return invoice

  const updated = await store.cancelInvoice(
    invoice.invoiceNumber,
    order.cancelledAt,
    order.cancelReason ?? null,
  )
  return updated ?? invoice
}

/** Bulk version used when rendering the Orders table. */
export async function reconcileCancellations(orders: NormalizedOrder[]): Promise<void> {
  const index = await store.getInvoicesByOrderId(orders.map((order) => order.id))
  for (const order of orders) {
    if (!order.cancelledAt) continue
    const entry = store.activeEntry(index.get(order.id))
    if (!entry) continue
    await store.cancelInvoice(entry.invoiceNumber, order.cancelledAt, order.cancelReason ?? null)
  }
}

async function syncSettingsCounter(settings: AppSettings, sequence: number): Promise<void> {
  if (settings.lastIssuedNumber === sequence) return
  await store.saveSettings({ ...settings, lastIssuedNumber: sequence })
}
