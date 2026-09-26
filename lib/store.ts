import { fileBackend } from './storage/file'
import { createMongoBackend, type MongoBackend } from './storage/mongo'
import { StoreError, type StorageBackend } from './storage/shared'

export { activeEntry, StoreError } from './storage/shared'
export type { Counter, InvoiceIndexEntry } from './storage/shared'

/**
 * The persistence entry point every caller imports. The backend behind it is chosen per
 * call from the environment:
 *
 *   MONGODB_URI set   -> MongoDB. Required wherever the filesystem is not durable and more
 *                        than one server instance can run - Vercel in particular.
 *   otherwise         -> JSON files under ./data. Local development and tests.
 *
 * MONGODB_URI holds credentials: keep it server-only. Never give it a NEXT_PUBLIC_ prefix,
 * which would inline it into the browser bundle.
 */

type StorageMode = 'mongodb' | 'file'

const globalStore = globalThis as unknown as {
  __gstMongoBackend?: { key: string; backend: MongoBackend }
}

function mongoUri(): string {
  return (process.env.MONGODB_URI ?? '').trim()
}

export function storageMode(): StorageMode {
  return mongoUri() ? 'mongodb' : 'file'
}

/** One client per URI + database, kept on globalThis so dev hot reloads reuse it. */
function mongoBackend(): MongoBackend {
  const uri = mongoUri()
  const dbName = (process.env.MONGODB_DB ?? '').trim() || 'gst_invoice'
  const key = `${uri}|${dbName}`
  const cached = globalStore.__gstMongoBackend
  if (cached?.key === key) return cached.backend

  const backend = createMongoBackend({ uri, dbName })
  globalStore.__gstMongoBackend = { key, backend }
  cached?.backend.close().catch(() => {})
  return backend
}

function backend(): StorageBackend {
  if (storageMode() === 'mongodb') return mongoBackend()
  if (process.env.VERCEL) {
    // Fail loudly: Vercel's filesystem is read-only and per-instance, so a file register
    // would either error on every write or silently hand out duplicate invoice numbers.
    throw new StoreError(
      'MONGODB_URI is not set. Vercel cannot store files, so invoices need a database.',
      'STORAGE_NOT_CONFIGURED',
    )
  }
  return fileBackend
}

// Async wrappers: a backend() failure (e.g. no MONGODB_URI on Vercel) must reject the
// promise callers await, not throw synchronously before any promise exists.
export const getSettings: StorageBackend['getSettings'] = async () => backend().getSettings()
export const saveSettings: StorageBackend['saveSettings'] = async (settings) => backend().saveSettings(settings)
export const getRateTable: StorageBackend['getRateTable'] = async () => backend().getRateTable()
export const saveRateTable: StorageBackend['saveRateTable'] = async (table) => backend().saveRateTable(table)
export const getCounter: StorageBackend['getCounter'] = async () => backend().getCounter()
export const getLastIssued: StorageBackend['getLastIssued'] = async (series, fy) =>
  backend().getLastIssued(series, fy)
export const setLastIssued: StorageBackend['setLastIssued'] = async (series, fy, value) =>
  backend().setLastIssued(series, fy, value)
export const getInvoice: StorageBackend['getInvoice'] = async (numberOrKey) => backend().getInvoice(numberOrKey)
export const listInvoices: StorageBackend['listInvoices'] = async () => backend().listInvoices()
export const getInvoicesByOrderId: StorageBackend['getInvoicesByOrderId'] = async (orderIds) =>
  backend().getInvoicesByOrderId(orderIds)
export const getInvoiceForOrder: StorageBackend['getInvoiceForOrder'] = async (orderId) =>
  backend().getInvoiceForOrder(orderId)
export const issueInvoice: StorageBackend['issueInvoice'] = async (series, fy, produce) =>
  backend().issueInvoice(series, fy, produce)
export const cancelInvoice: StorageBackend['cancelInvoice'] = async (numberOrKey, cancelledAt, reason) =>
  backend().cancelInvoice(numberOrKey, cancelledAt, reason)

export interface StorageCheck {
  mode: StorageMode
  ok: boolean
  database?: string
  latencyMs?: number
  detail?: string
}

/** For the health check: which backend is live and whether it answers. No credentials. */
export async function checkStorage(): Promise<StorageCheck> {
  const mode = storageMode()
  if (mode === 'file') {
    return process.env.VERCEL
      ? { mode, ok: false, detail: 'MONGODB_URI is not set; Vercel cannot store files.' }
      : { mode, ok: true, detail: 'JSON files under ./data' }
  }
  const mongo = mongoBackend()
  try {
    return { mode, ok: true, database: mongo.databaseName, latencyMs: await mongo.ping() }
  } catch (error) {
    return {
      mode,
      ok: false,
      database: mongo.databaseName,
      detail: error instanceof Error ? error.message : 'MongoDB did not answer',
    }
  }
}
