import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { invoiceFileKey } from '../gst/numbering'
import type { AppSettings } from '../gst/settings'
import type { InvoiceSnapshot, RateTable } from '../gst/types'
import { withLock } from '../mutex'
import { DEFAULT_RATE_TABLE } from '../seed/rate-table'
import type { InvoiceSeries } from '../gst/types'
import {
  activeEntry,
  counterKey,
  mergeSettings,
  StoreError,
  toIndexEntry,
  type Counter,
  type InvoiceIndexEntry,
  type LegacySettings,
  type StorageBackend,
} from './shared'

/**
 * JSON files under ./data. For local development and tests; it needs a durable, writable
 * disk and a single server process, so it cannot run on Vercel - use MongoDB there.
 *
 * Layout (gitignored):
 *   settings.json                    seller details + invoice config
 *   counter.json                     { "2026-27": 106 }
 *   hsn-rates.json                   rate rules
 *   invoices/<key>.json              immutable snapshot, one per issued invoice
 *   invoices/_index.json             orderId -> invoice pointers (rebuildable from the files)
 */

const DATA_DIR = path.resolve(process.cwd(), 'data')
const INVOICE_DIR = path.join(DATA_DIR, 'invoices')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json')
const RATES_FILE = path.join(DATA_DIR, 'hsn-rates.json')
const INDEX_FILE = path.join(INVOICE_DIR, '_index.json')

/**
 * orderId -> every invoice ever issued for that order, oldest first. An order can hold
 * more than one once a cancelled invoice is reissued.
 */
type InvoiceIndex = Record<string, InvoiceIndexEntry[]>

/* ---------------------------------- IO ---------------------------------- */

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

/* ------------------------------- settings ------------------------------- */

async function getSettings(): Promise<AppSettings> {
  return mergeSettings(await readJson<Partial<AppSettings> & LegacySettings>(SETTINGS_FILE, {}))
}

async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  return withLock('settings', async () => {
    await writeJsonAtomic(SETTINGS_FILE, settings)
    return settings
  })
}

/* ------------------------------ rate table ------------------------------ */

async function getRateTable(): Promise<RateTable> {
  if (!(await exists(RATES_FILE))) {
    await withLock('rates', async () => {
      if (!(await exists(RATES_FILE))) await writeJsonAtomic(RATES_FILE, DEFAULT_RATE_TABLE)
    })
    return DEFAULT_RATE_TABLE
  }
  return readJson<RateTable>(RATES_FILE, DEFAULT_RATE_TABLE)
}

async function saveRateTable(table: RateTable): Promise<RateTable> {
  return withLock('rates', async () => {
    await writeJsonAtomic(RATES_FILE, table)
    return table
  })
}

/* -------------------------------- counter ------------------------------- */

async function getCounter(): Promise<Counter> {
  return readJson<Counter>(COUNTER_FILE, {})
}

async function getLastIssued(series: InvoiceSeries, financialYear: string): Promise<number> {
  return (await getCounter())[counterKey(series, financialYear)] ?? 0
}

async function setLastIssued(series: InvoiceSeries, financialYear: string, value: number): Promise<number> {
  return withLock('invoice-number', async () => {
    const onDisk = await highestSequenceOnDisk(series, financialYear)
    if (value < onDisk) {
      throw new StoreError(
        `Invoice ${financialYear}/${onDisk} has already been issued; the counter cannot be set below ${onDisk}.`,
        'COUNTER_TOO_LOW',
      )
    }
    const counter = await getCounter()
    counter[counterKey(series, financialYear)] = value
    await writeJsonAtomic(COUNTER_FILE, counter)
    return value
  })
}

/* ------------------------------- invoices ------------------------------- */

function invoicePath(invoiceNumberOrKey: string): string {
  // invoiceFileKey is idempotent, so a number and its key resolve to the same file.
  return path.join(INVOICE_DIR, `${invoiceFileKey(invoiceNumberOrKey)}.json`)
}

async function getInvoice(invoiceNumberOrKey: string): Promise<InvoiceSnapshot | null> {
  return readJson<InvoiceSnapshot | null>(invoicePath(invoiceNumberOrKey), null)
}

async function listInvoices(): Promise<InvoiceIndexEntry[]> {
  const index = await getIndex()
  return Object.values(index)
    .flat()
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
}

async function getInvoicesByOrderId(orderIds?: string[]): Promise<Map<string, InvoiceIndexEntry[]>> {
  const index = await getIndex()
  if (!orderIds) return new Map(Object.entries(index))
  return new Map(orderIds.filter((id) => index[id]).map((id) => [id, index[id]]))
}

async function getInvoiceForOrder(orderId: string): Promise<InvoiceSnapshot | null> {
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

/** An index in the old one-entry-per-order shape triggers a rebuild from the files. */
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

async function highestSequenceOnDisk(series: InvoiceSeries, financialYear: string): Promise<number> {
  const snapshots = await readAllSnapshots()
  return snapshots
    .filter((s) => (s.series ?? 'REAL') === series && s.financialYear === financialYear)
    .reduce((max, s) => Math.max(max, s.sequence), 0)
}

/**
 * The counter is advanced only after the snapshot file is written, so a failure in
 * `produce` burns no number; one process-wide lock serialises concurrent issues.
 */
async function issueInvoice(
  series: InvoiceSeries,
  financialYear: string,
  produce: (sequence: number) => Promise<InvoiceSnapshot>,
): Promise<InvoiceSnapshot> {
  return withLock('invoice-number', async () => {
    const counter = await getCounter()
    const key = counterKey(series, financialYear)
    // Never behind the files, e.g. after a crash between the two writes.
    const next = Math.max(counter[key] ?? 0, await highestSequenceOnDisk(series, financialYear)) + 1

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

    counter[key] = next
    await writeJsonAtomic(COUNTER_FILE, counter)

    return snapshot
  })
}

async function cancelInvoice(
  invoiceNumberOrKey: string,
  cancelledAt: string,
  reason: string | null,
): Promise<InvoiceSnapshot | null> {
  return withLock('invoice-number', async () => {
    const snapshot = await getInvoice(invoiceNumberOrKey)
    if (!snapshot) return null
    if (snapshot.status === 'CANCELLED') return snapshot

    const updated: InvoiceSnapshot = {
      ...snapshot,
      status: 'CANCELLED',
      cancelledAt,
      cancellationReason: reason,
    }
    await writeJsonAtomic(invoicePath(invoiceNumberOrKey), updated)
    await appendToIndex(updated)
    return updated
  })
}

export const fileBackend: StorageBackend = {
  getSettings,
  saveSettings,
  getRateTable,
  saveRateTable,
  getCounter,
  getLastIssued,
  setLastIssued,
  getInvoice,
  listInvoices,
  getInvoicesByOrderId,
  getInvoiceForOrder,
  issueInvoice,
  cancelInvoice,
}
