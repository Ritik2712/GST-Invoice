import { DEFAULT_SETTINGS, type AppSettings } from '../gst/settings'
import type { InvoiceSnapshot, RateTable } from '../gst/types'

/**
 * What every storage backend shares: the contract callers rely on, the error type they
 * catch, and the small pure helpers both backends need to behave identically.
 */

export type Counter = Record<string, number>

export interface InvoiceIndexEntry {
  invoiceNumber: string
  orderId: string
  orderName: string
  financialYear: string
  sequence: number
  issuedAt: string
  status: InvoiceSnapshot['status']
  cancelledAt?: string | null
  grandTotal: number
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'StoreError'
  }
}

/**
 * The persistence contract. Guarantees every implementation must keep:
 *  - `issueInvoice` allots numbers gaplessly per financial year, never allots one when the
 *    producer fails, never hands the same number out twice, and never overwrites an invoice;
 *  - `setLastIssued` refuses to move below a number already issued;
 *  - `cancelInvoice` never deletes and is idempotent.
 */
export interface StorageBackend {
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  getRateTable(): Promise<RateTable>
  saveRateTable(table: RateTable): Promise<RateTable>
  getCounter(): Promise<Counter>
  getLastIssued(financialYear: string): Promise<number>
  setLastIssued(financialYear: string, value: number): Promise<number>
  /** Accepts the invoice number or its URL-safe key. */
  getInvoice(invoiceNumberOrKey: string): Promise<InvoiceSnapshot | null>
  listInvoices(): Promise<InvoiceIndexEntry[]>
  /** Every invoice per order, oldest first; limited to `orderIds` when given. */
  getInvoicesByOrderId(orderIds?: string[]): Promise<Map<string, InvoiceIndexEntry[]>>
  getInvoiceForOrder(orderId: string): Promise<InvoiceSnapshot | null>
  issueInvoice(
    financialYear: string,
    produce: (sequence: number) => Promise<InvoiceSnapshot>,
  ): Promise<InvoiceSnapshot>
  cancelInvoice(
    invoiceNumberOrKey: string,
    cancelledAt: string,
    reason: string | null,
  ): Promise<InvoiceSnapshot | null>
}

/** The live invoice for an order: the newest one that has not been cancelled. */
export function activeEntry(entries: InvoiceIndexEntry[] | undefined): InvoiceIndexEntry | null {
  if (!entries?.length) return null
  const issued = entries.filter((e) => e.status === 'ISSUED')
  return issued.length ? issued[issued.length - 1] : null
}

export function toIndexEntry(snapshot: InvoiceSnapshot): InvoiceIndexEntry {
  return {
    invoiceNumber: snapshot.invoiceNumber,
    orderId: snapshot.order.id,
    orderName: snapshot.order.name,
    financialYear: snapshot.financialYear,
    sequence: snapshot.sequence,
    issuedAt: snapshot.issuedAt,
    status: snapshot.status,
    cancelledAt: snapshot.cancelledAt ?? null,
    grandTotal: snapshot.totals.grandTotal,
  }
}

/** Fields written by earlier versions of the app, read once and translated forward. */
export interface LegacySettings {
  shippingRateMode?: 'HIGHEST_LINE_RATE' | 'TABLE'
}

function migrateShippingMode(mode: LegacySettings['shippingRateMode']): AppSettings['shippingTreatment'] {
  if (mode === 'TABLE') return 'SEPARATE_SERVICE'
  if (mode === 'HIGHEST_LINE_RATE') return 'COMPOSITE_LINE'
  return DEFAULT_SETTINGS.shippingTreatment
}

/** Stored settings merged over the defaults, so an older document stays loadable. */
export function mergeSettings(stored: Partial<AppSettings> & LegacySettings): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    shippingTreatment: stored.shippingTreatment ?? migrateShippingMode(stored.shippingRateMode),
    bank: { ...DEFAULT_SETTINGS.bank, ...(stored.bank ?? {}) },
  }
}
