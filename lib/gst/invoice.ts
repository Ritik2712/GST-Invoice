import { calculate } from './calc'
import { formatIstDate } from './fy'
import { resolvePlaceOfSupply, type PlaceOfSupply } from './placeOfSupply'
import { stateByCode } from './states'
import type { AppSettings } from './settings'
import { amountInWords } from './words'
import type {
  InvoiceSeries,
  InvoiceSnapshot,
  NormalizedOrder,
  PartyAddress,
  RateTable,
  TaxableLineInput,
} from './types'

// 2 added `series`; snapshots written before it are REAL.
export const INVOICE_SCHEMA_VERSION = 2

/** Test orders are not supplies, so they never take a number from the real series. */
export function seriesFor(order: NormalizedOrder): InvoiceSeries {
  return order.isTest ? 'TEST' : 'REAL'
}

/** The prefix a series prints with. */
export function prefixFor(series: InvoiceSeries, settings: AppSettings): string {
  return series === 'TEST' ? settings.testInvoicePrefix : settings.invoicePrefix
}

export type InvoiceabilityReason =
  | 'CANCELLED_BEFORE_INVOICE'
  | 'NOT_PAID'
  | 'NO_PLACE_OF_SUPPLY'
  | 'NO_LINES'
  | 'SETTINGS_INCOMPLETE'

export type Invoiceability =
  | { invoiceable: true }
  | { invoiceable: false; reason: InvoiceabilityReason; message: string }

/**
 * Whether an order may be invoiced *now*. An order cancelled before an invoice existed
 * never gets one and never consumes a number; an order cancelled afterwards keeps the
 * invoice it already has (handled by the caller, which checks for an existing snapshot
 * before calling this).
 */
export function checkInvoiceability(
  order: NormalizedOrder,
  settingsComplete: boolean,
): Invoiceability {
  // A Shopify test order is invoiceable: it simply lands in the TEST series, which keeps
  // its number out of the real one. `seriesFor` decides which.
  if (order.cancelledAt) {
    return {
      invoiceable: false,
      reason: 'CANCELLED_BEFORE_INVOICE',
      message: 'Order was cancelled before an invoice was issued',
    }
  }
  if (order.financialStatus !== 'PAID' && order.financialStatus !== 'PARTIALLY_PAID') {
    return {
      invoiceable: false,
      reason: 'NOT_PAID',
      message: `Payment not confirmed (${order.financialStatus.toLowerCase().replace(/_/g, ' ')})`,
    }
  }
  if (order.lines.length === 0) {
    return { invoiceable: false, reason: 'NO_LINES', message: 'Order has no line items' }
  }
  if (!resolvePlaceOfSupply(order)) {
    return {
      invoiceable: false,
      reason: 'NO_PLACE_OF_SUPPLY',
      message: 'No Indian state could be resolved from the order addresses',
    }
  }
  if (!settingsComplete) {
    return {
      invoiceable: false,
      reason: 'SETTINGS_INCOMPLETE',
      message: 'Complete the seller details in Settings first',
    }
  }
  return { invoiceable: true }
}

export interface BuildInvoiceArgs {
  order: NormalizedOrder
  settings: AppSettings
  rateTable: RateTable
  invoiceNumber: string
  series: InvoiceSeries
  financialYear: string
  sequence: number
  issuedAt: Date
  /** Overrides the address-derived place of supply when the user picks one manually. */
  placeOfSupplyOverride?: string | null
}

/**
 * Builds the immutable snapshot. Everything an invoice ever needs to render is captured
 * here - seller details, bank details, terms, logo, rates - so a later settings or rate
 * change can never alter an invoice that has already been issued.
 */
export function buildInvoice(args: BuildInvoiceArgs): InvoiceSnapshot {
  const { order, settings, rateTable, issuedAt } = args

  const place = resolvePlaceOfSupplyOrThrow(order, args.placeOfSupplyOverride)
  const lines = withShippingLine(order, settings)

  const result = calculate({
    sellerStateCode: settings.sellerStateCode,
    placeOfSupplyStateCode: place.stateCode,
    pricesIncludeGst: settings.pricesIncludeGst,
    lines,
    rateTable,
    shippingTreatment: settings.shippingTreatment,
  })

  const sellerState = stateByCode(settings.sellerStateCode)

  return {
    schemaVersion: INVOICE_SCHEMA_VERSION,
    series: args.series,
    invoiceNumber: args.invoiceNumber,
    financialYear: args.financialYear,
    sequence: args.sequence,
    issuedAt: issuedAt.toISOString(),
    invoiceDate: formatIstDate(issuedAt),
    status: 'ISSUED',
    cancelledAt: null,
    cancellationReason: null,

    seller: {
      legalName: settings.legalBusinessName,
      gstin: settings.gstin,
      stateCode: settings.sellerStateCode,
      stateName: sellerState?.name ?? settings.sellerStateName,
      address: settings.registeredAddress,
      pan: settings.pan || undefined,
      bank: settings.bank,
      logoDataUri: settings.logoDataUri,
      invoiceTitle: settings.invoiceTitle.trim() || 'INVOICE RECEIPT',
    },

    buyer: {
      name: order.customerName || order.shippingAddress?.name || order.billingAddress?.name || 'Customer',
      gstin: order.customerGstin ?? null,
      email: order.customerEmail ?? null,
      phone: order.customerPhone ?? null,
      billingAddress: order.billingAddress ?? null,
      shippingAddress: order.shippingAddress ?? null,
    },

    order: {
      id: order.id,
      name: order.name,
      number: order.orderNumber,
      placedAt: order.processedAt ?? order.createdAt,
      financialStatus: order.financialStatus,
      currency: order.currency,
      shopifyTotal: order.orderTotal,
    },

    placeOfSupply: place,
    taxKind: result.taxKind,
    pricesIncludeGst: settings.pricesIncludeGst,
    reverseCharge: false,

    lines: result.lines,
    hsnSummary: result.hsnSummary,
    totals: result.totals,
    amountInWords: amountInWords(result.totals.grandTotal, order.currency),

    terms: settings.terms || undefined,
    rateTableVersion: rateTable.version,
  }
}

function resolvePlaceOfSupplyOrThrow(
  order: NormalizedOrder,
  override?: string | null,
): PlaceOfSupply {
  if (override) {
    const state = stateByCode(override)
    if (!state) throw new Error(`Unknown place-of-supply state code: ${override}`)
    return { stateCode: state.code, stateName: state.name, source: 'manual-override' }
  }
  const resolved = resolvePlaceOfSupply(order)
  if (!resolved) throw new Error('Could not resolve a place of supply for this order')
  return resolved
}

/** Appends shipping as a taxable pseudo-line when the order was charged for freight. */
function withShippingLine(order: NormalizedOrder, settings: AppSettings): TaxableLineInput[] {
  const lines = [...order.lines]
  const shipping = order.shipping
  if (shipping && shipping.amount > 0) {
    lines.push({
      id: 'shipping',
      title: settings.deliveryLineLabel.trim() || shipping.title || 'Delivery charges',
      quantity: 1,
      unitPrice: shipping.amount,
      discount: shipping.discount,
      hsnOverride: settings.shippingHsn || null,
      kind: 'SHIPPING',
    })
  }
  return lines
}

/** Single-line address rendering for the PDF. */
export function formatAddress(address: PartyAddress | null | undefined): string[] {
  if (!address) return []
  return [
    address.name,
    address.line1,
    address.line2,
    [address.city, address.stateName].filter(Boolean).join(', '),
    address.pincode,
    address.phone,
  ].filter((part): part is string => Boolean(part && part.trim()))
}
