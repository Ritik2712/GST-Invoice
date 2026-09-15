import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { DEFAULT_SETTINGS, type AppSettings } from './gst/settings'
import { invoiceFileKey } from './gst/numbering'
import type { InvoiceSnapshot, RateTable } from './gst/types'
import { withLock } from './mutex'
import { DEFAULT_RATE_TABLE } from './seed/rate-table'

/**
 * The only module that touches the filesystem. Every caller goes through these functions,
 * so swapping JSON files for Prisma later means reimplementing this file and nothing else.
 *
 * Layout under ./data (gitignored):
 *   settings.json                    seller details + invoice config
 *   counter.json                     { "2026-27": 106 }
 *   hsn-rates.json                   rate rules
 *   invoices/<key>.json              immutable snapshot, one per issued invoice
 *   invoices/_index.json             orderId -> invoice pointer (rebuildable from the files)
 */

const DATA_DIR = path.resolve(process.cwd(), 'data')
const INVOICE_DIR = path.join(DATA_DIR, 'invoices')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json')
const RATES_FILE = path.join(DATA_DIR, 'hsn-rates.json')
const INDEX_FILE = path.join(INVOICE_DIR, '_index.json')

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

/**
 * orderId -> every invoice ever issued for that order, oldest first. An order can hold
 * more than one once a cancelled invoice is reissued: the cancelled numbers stay in the
 * register for ever and the newest ISSUED entry is the live document.
 */
type InvoiceIndex = Record<string, InvoiceIndexEntry[]>

/* -------------------------------------------------------------------------- */
/* Low-level IO                                                                */
/* -------------------------------------------------------------------------- */

async function ensureDirs(): Promise<void> {
  await fs.mkdir(INVOICE_DIR, { recursive: true })
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

/** Write to a sibling temp file and rename, so a crash never leaves a half-written file. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDirs()
  const temp = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(temp, file)
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export async function getSettings(): Promise<AppSettings> {
  const stored = await readJson<Partial<AppSettings> & LegacySettings>(SETTINGS_FILE, {})
  // Merge over defaults so a settings file written by an older version stays loadable.
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    shippingTreatment: stored.shippingTreatment ?? migrateShippingMode(stored.shippingRateMode),
    bank: { ...DEFAULT_SETTINGS.bank, ...(stored.bank ?? {}) },
  }
}

/** Fields written by earlier versions of the app, read once and translated forward. */
interface LegacySettings {
  shippingRateMode?: 'HIGHEST_LINE_RATE' | 'TABLE'
}

function migrateShippingMode(mode: LegacySettings['shippingRateMode']): AppSettings['shippingTreatment'] {
  if (mode === 'TABLE') return 'SEPARATE_SERVICE'
  if (mode === 'HIGHEST_LINE_RATE') return 'COMPOSITE_LINE'
  return DEFAULT_SETTINGS.shippingTreatment
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  return withLock('settings', async () => {
    await writeJsonAtomic(SETTINGS_FILE, settings)
    return settings
  })
}

/* -------------------------------------------------------------------------- */
/* Rate table                                                                  */
/* -------------------------------------------------------------------------- */

export async function getRateTable(): Promise<RateTable> {
  if (!(await exists(RATES_FILE))) {
    await withLock('rates', async () => {
      if (!(await exists(RATES_FILE))) await writeJsonAtomic(RATES_FILE, DEFAULT_RATE_TABLE)
    })
    return DEFAULT_RATE_TABLE
  }
  return readJson<RateTable>(RATES_FILE, DEFAULT_RATE_TABLE)
}

export async function saveRateTable(table: RateTable): Promise<RateTable> {
  return withLock('rates', async () => {
    await writeJsonAtomic(RATES_FILE, table)
    return table
  })
}

/* -------------------------------------------------------------------------- */
/* Counter                                                                     */
/* -------------------------------------------------------------------------- */

export async function getCounter(): Promise<Counter> {
  return readJson<Counter>(COUNTER_FILE, {})
}

export async function getLastIssued(financialYear: string): Promise<number> {
  return (await getCounter())[financialYear] ?? 0
}

/**
 * Manual correction from Settings - lets the series start mid-year or be repaired. Refuses
 * to move below a number that has already been issued, since that would mint duplicates.
 */
export async function setLastIssued(financialYear: string, value: number): Promise<number> {
  return withLock('invoice-number', async () => {
    const onDisk = await highestSequenceOnDisk(financialYear)
    if (value < onDisk) {
      throw new StoreError(
        `Invoice ${financialYear}/${onDisk} has already been issued; the counter cannot be set below ${onDisk}.`,
        'COUNTER_TOO_LOW',
      )
    }
    const counter = await getCounter()
    counter[financialYear] = value
    await writeJsonAtomic(COUNTER_FILE, counter)
    return value
  })
}

/* -------------------------------------------------------------------------- */
/* Invoices                                                                    */
/* -------------------------------------------------------------------------- */

function invoicePath(invoiceNumber: string): string {
  return path.join(INVOICE_DIR, `${invoiceFileKey(invoiceNumber)}.json`)
}

export async function getInvoice(invoiceNumber: string): Promise<InvoiceSnapshot | null> {
  return readJson<InvoiceSnapshot | null>(invoicePath(invoiceNumber), null)
}

export async function listInvoices(): Promise<InvoiceIndexEntry[]> {
  const index = await getIndex()
  return Object.values(index)
    .flat()
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
}

/** Invoice pointers keyed by Shopify order GID, for the Orders table. */
export async function getInvoicesByOrderId(): Promise<Map<string, InvoiceIndexEntry[]>> {
  return new Map(Object.entries(await getIndex()))
}

/** The live invoice for an order: the newest one that has not been cancelled. */
export function activeEntry(entries: InvoiceIndexEntry[] | undefined): InvoiceIndexEntry | null {
  if (!entries?.length) return null
  const issued = entries.filter((e) => e.status === 'ISSUED')
  return issued.length ? issued[issued.length - 1] : null
}

/**
 * The invoice a re-download should serve. Cancelled invoices are deliberately *not*
 * returned here - once cancelled, the order is free to be invoiced again - but their files
 * stay on disk and remain retrievable by number.
 */
export async function getInvoiceForOrder(orderId: string): Promise<InvoiceSnapshot | null> {
  const entry = activeEntry((await getIndex())[orderId])
  return entry ? getInvoice(entry.invoiceNumber) : null
}

async function getIndex(): Promise<InvoiceIndex> {
  const index = await readJson<InvoiceIndex | null>(INDEX_FILE, null)
  if (isCurrentShape(index)) return index as InvoiceIndex
  return withLock('invoice-index', async () => {
    const again = await readJson<InvoiceIndex | null>(INDEX_FILE, null)
    if (isCurrentShape(again)) return again as InvoiceIndex
    const rebuilt = await rebuildIndex()
    await writeJsonAtomic(INDEX_FILE, rebuilt)
    return rebuilt
  })
}

async function appendToIndex(snapshot: InvoiceSnapshot): Promise<void> {
  const index = await getIndex()
  const entries = (index[snapshot.order.id] ?? []).filter(
    (e) => e.invoiceNumber !== snapshot.invoiceNumber,
  )
  entries.push(toIndexEntry(snapshot))
  index[snapshot.order.id] = entries.sort((a, b) => a.sequence - b.sequence)
  await writeJsonAtomic(INDEX_FILE, index)
}

/** The snapshot files are the source of truth; the index is a derived cache. */
async function rebuildIndex(): Promise<InvoiceIndex> {
  await ensureDirs()
  const index: InvoiceIndex = {}
  const snapshots = (await readAllSnapshots()).sort((a, b) => a.sequence - b.sequence)
  for (const snapshot of snapshots) {
    const entries = index[snapshot.order.id] ?? []
    entries.push(toIndexEntry(snapshot))
    index[snapshot.order.id] = entries
  }
  return index
}

/**
 * Earlier versions stored a single entry per order. Rather than migrate that shape in
 * place, any non-array value triggers a rebuild from the snapshot files, which are
 * authoritative anyway.
 */
function isCurrentShape(index: InvoiceIndex | null): boolean {
  if (!index) return false
  return Object.values(index).every((value) => Array.isArray(value))
}

async function readAllSnapshots(): Promise<InvoiceSnapshot[]> {
  await ensureDirs()
  const files = (await fs.readdir(INVOICE_DIR)).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_'),
  )
  const snapshots: InvoiceSnapshot[] = []
  for (const file of files) {
    const snapshot = await readJson<InvoiceSnapshot | null>(path.join(INVOICE_DIR, file), null)
    if (snapshot?.invoiceNumber) snapshots.push(snapshot)
  }
  return snapshots
}

function toIndexEntry(snapshot: InvoiceSnapshot): InvoiceIndexEntry {
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

async function highestSequenceOnDisk(financialYear: string): Promise<number> {
  const snapshots = await readAllSnapshots()
  return snapshots
    .filter((s) => s.financialYear === financialYear)
    .reduce((max, s) => Math.max(max, s.sequence), 0)
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
 * Allocates the next sequence number for `financialYear` and persists the invoice that
 * `produce` builds from it.
 *
 * The counter is advanced on disk *only* after the snapshot file has been written, so a
 * failure anywhere in `produce` (rate lookup, PDF render, disk error) leaves the counter
 * untouched and burns no number. The whole sequence runs under one lock, so two
 * simultaneous downloads cannot claim the same number.
 */
export async function issueInvoice(
  financialYear: string,
  produce: (sequence: number) => Promise<InvoiceSnapshot>,
): Promise<InvoiceSnapshot> {
  return withLock('invoice-number', async () => {
    const counter = await getCounter()
    // Defend against a counter that fell behind the files (e.g. a crash between the two
    // writes): the next number is always past anything already on disk.
    const next = Math.max(counter[financialYear] ?? 0, await highestSequenceOnDisk(financialYear)) + 1

    const snapshot = await produce(next)

    const file = invoicePath(snapshot.invoiceNumber)
    if (await exists(file)) {
      throw new StoreError(
        `Invoice ${snapshot.invoiceNumber} already exists; refusing to overwrite it.`,
        'INVOICE_EXISTS',
      )
    }
    await writeJsonAtomic(file, snapshot)
    await appendToIndex(snapshot)

    counter[financialYear] = next
    await writeJsonAtomic(COUNTER_FILE, counter)

    return snapshot
  })
}

/**
 * Marks an already-issued invoice cancelled. The file is never deleted and the number is
 * never reused - a cancelled tax invoice still has to be reportable.
 */
export async function cancelInvoice(
  invoiceNumber: string,
  cancelledAt: string,
  reason: string | null,
): Promise<InvoiceSnapshot | null> {
  return withLock('invoice-number', async () => {
    const snapshot = await getInvoice(invoiceNumber)
    if (!snapshot) return null
    if (snapshot.status === 'CANCELLED') return snapshot

    const updated: InvoiceSnapshot = {
      ...snapshot,
      status: 'CANCELLED',
      cancelledAt,
      cancellationReason: reason,
    }
    await writeJsonAtomic(invoicePath(invoiceNumber), updated)
    await appendToIndex(updated)

    return updated
  })
}
