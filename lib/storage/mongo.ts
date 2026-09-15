import { MongoClient, MongoServerError, type Db } from 'mongodb'

import { invoiceFileKey } from '../gst/numbering'
import type { AppSettings } from '../gst/settings'
import type { InvoiceSnapshot, RateTable } from '../gst/types'
import { withLock } from '../mutex'
import { DEFAULT_RATE_TABLE } from '../seed/rate-table'
import {
  mergeSettings,
  StoreError,
  toIndexEntry,
  type Counter,
  type InvoiceIndexEntry,
  type StorageBackend,
} from './shared'

/**
 * MongoDB storage. Same contract as the file store, but every guarantee about invoice
 * numbers is enforced by the database rather than by this process - which is what makes
 * it safe on Vercel, where several server instances run at once:
 *
 *  - Issuing is one transaction. The counter claim, the PDF render and the snapshot insert
 *    commit together or not at all, so a failure never burns a number.
 *  - The counter document is written first. That write locks it inside the transaction, so
 *    a concurrent issue on another instance hits a write conflict and is retried after this
 *    one commits: numbers are serialised across instances, not just within one process.
 *  - A unique index on (financialYear, sequence) means a duplicate number cannot be stored,
 *    even by a bug.
 *
 * Collections: settings, rate_tables, counters, invoices.
 */

export const COLLECTIONS = {
  settings: 'settings',
  rateTables: 'rate_tables',
  counters: 'counters',
  invoices: 'invoices',
} as const

type SettingsDoc = AppSettings & { _id: string }
type RateTableDoc = RateTable & { _id: string }
interface CounterDoc {
  _id: string
  seq: number
}
type InvoiceDoc = InvoiceSnapshot & { _id: string }

export interface MongoBackendOptions {
  uri: string
  dbName: string
  /**
   * Also serialise issues within this process. Harmless in production - it only saves
   * needless write conflicts - and switched off in tests to prove the database alone keeps
   * numbers unique across instances.
   */
  processLock?: boolean
}

export interface MongoExtras {
  readonly databaseName: string
  /** Round-trip latency of a ping, in ms. */
  ping(): Promise<number>
  registerCounts(): Promise<{ invoices: number; counters: number }>
  /** Migration only: store an already-issued snapshot exactly as it is. */
  importSnapshot(snapshot: InvoiceSnapshot): Promise<void>
  /** Migration only: set a financial year's counter. */
  importCounter(financialYear: string, seq: number): Promise<void>
  /** Test only: empty every collection. Refuses unless the database is a test database. */
  resetForTests(): Promise<void>
  /** Test only: drop every collection. Refuses unless the database is a test database. */
  dropForTests(): Promise<void>
  close(): Promise<void>
}

export type MongoBackend = StorageBackend & MongoExtras

const TEST_DB_PREFIX = 'gst_invoice_test_'

/** Never let credentials from a connection string reach an error message. */
function mask(message: string): string {
  return message.replace(/mongodb(\+srv)?:\/\/[^@\s]+@/g, 'mongodb$1://<credentials>@')
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000
}

function withoutId<T extends { _id: unknown }>(doc: T): Omit<T, '_id'> {
  const { _id, ...rest } = doc
  void _id
  return rest
}

/** Only the fields an index entry needs - keeps the Orders table off full snapshots. */
const INDEX_PROJECTION = {
  _id: 0,
  invoiceNumber: 1,
  'order.id': 1,
  'order.name': 1,
  financialYear: 1,
  sequence: 1,
  issuedAt: 1,
  status: 1,
  cancelledAt: 1,
  'totals.grandTotal': 1,
} as const

async function ensureIndexes(db: Db): Promise<void> {
  const invoices = db.collection(COLLECTIONS.invoices)
  await Promise.all([
    invoices.createIndex({ financialYear: 1, sequence: 1 }, { unique: true, name: 'unique_number_per_fy' }),
    invoices.createIndex({ 'order.id': 1, issuedAt: 1 }, { name: 'by_order' }),
    invoices.createIndex({ issuedAt: -1 }, { name: 'by_issued_at' }),
  ])
}

export function createMongoBackend(options: MongoBackendOptions): MongoBackend {
  let connecting: Promise<{ client: MongoClient; db: Db }> | null = null

  function connection(): Promise<{ client: MongoClient; db: Db }> {
    if (!connecting) {
      const client = new MongoClient(options.uri, {
        serverSelectionTimeoutMS: 10_000,
        maxPoolSize: 10,
        // Optional snapshot fields left undefined are omitted, as in the JSON files,
        // instead of being stored as null.
        ignoreUndefined: true,
        appName: 'gst-invoice-app',
      })
      connecting = client
        .connect()
        .then(async () => {
          const db = client.db(options.dbName)
          await ensureIndexes(db)
          return { client, db }
        })
        .catch(async (error: unknown) => {
          connecting = null
          await client.close().catch(() => {})
          const message = error instanceof Error ? error.message : String(error)
          throw new StoreError(`Could not connect to MongoDB: ${mask(message)}`, 'DB_UNAVAILABLE')
        })
    }
    return connecting
  }

  async function collections() {
    const { client, db } = await connection()
    return {
      client,
      db,
      settings: db.collection<SettingsDoc>(COLLECTIONS.settings),
      rateTables: db.collection<RateTableDoc>(COLLECTIONS.rateTables),
      counters: db.collection<CounterDoc>(COLLECTIONS.counters),
      invoices: db.collection<InvoiceDoc>(COLLECTIONS.invoices),
    }
  }

  function assertTestDatabase(): void {
    if (!options.dbName.startsWith(TEST_DB_PREFIX)) {
      throw new Error(`Refusing to wipe "${options.dbName}": test helpers only run on ${TEST_DB_PREFIX}* databases.`)
    }
  }

  async function highestSequence(
    invoices: Awaited<ReturnType<typeof collections>>['invoices'],
    financialYear: string,
    session?: import('mongodb').ClientSession,
  ): Promise<number> {
    const top = await invoices
      .find({ financialYear }, { session })
      .sort({ sequence: -1 })
      .limit(1)
      .project<{ sequence: number }>({ _id: 0, sequence: 1 })
      .next()
    return top?.sequence ?? 0
  }

  const backend: MongoBackend = {
    databaseName: options.dbName,

    async getSettings() {
      const { settings } = await collections()
      const doc = await settings.findOne({ _id: 'settings' })
      return mergeSettings(doc ? withoutId(doc) : {})
    },

    async saveSettings(value) {
      const { settings } = await collections()
      await settings.replaceOne({ _id: 'settings' }, value, { upsert: true })
      return value
    },

    async getRateTable() {
      const { rateTables } = await collections()
      const doc = await rateTables.findOne({ _id: 'current' })
      if (doc) return withoutId(doc) as RateTable
      // Seed once; $setOnInsert keeps a concurrent first read from overwriting anything.
      await rateTables.updateOne({ _id: 'current' }, { $setOnInsert: DEFAULT_RATE_TABLE }, { upsert: true })
      const seeded = await rateTables.findOne({ _id: 'current' })
      return seeded ? (withoutId(seeded) as RateTable) : DEFAULT_RATE_TABLE
    },

    async saveRateTable(table) {
      const { rateTables } = await collections()
      await rateTables.replaceOne({ _id: 'current' }, table, { upsert: true })
      return table
    },

    async getCounter() {
      const { counters } = await collections()
      const docs = await counters.find({}).toArray()
      return Object.fromEntries(docs.map((d) => [d._id, d.seq])) as Counter
    },

    async getLastIssued(financialYear) {
      const { counters } = await collections()
      return (await counters.findOne({ _id: financialYear }))?.seq ?? 0
    },

    async setLastIssued(financialYear, value) {
      const { client, counters, invoices } = await collections()
      const session = client.startSession()
      try {
        await session.withTransaction(async () => {
          const issued = await highestSequence(invoices, financialYear, session)
          if (value < issued) {
            throw new StoreError(
              `Invoice ${financialYear}/${issued} has already been issued; the counter cannot be set below ${issued}.`,
              'COUNTER_TOO_LOW',
            )
          }
          await counters.updateOne({ _id: financialYear }, { $set: { seq: value } }, { upsert: true, session })
        })
        return value
      } finally {
        await session.endSession()
      }
    },

    async getInvoice(invoiceNumberOrKey) {
      const { invoices } = await collections()
      const doc = await invoices.findOne({ _id: invoiceFileKey(invoiceNumberOrKey) })
      return doc ? (withoutId(doc) as InvoiceSnapshot) : null
    },

    async listInvoices() {
      const { invoices } = await collections()
      const docs = await invoices.find({}).sort({ issuedAt: -1 }).project<InvoiceSnapshot>(INDEX_PROJECTION).toArray()
      return docs.map(toIndexEntry)
    },

    async getInvoicesByOrderId(orderIds) {
      const { invoices } = await collections()
      const filter = orderIds ? { 'order.id': { $in: orderIds } } : {}
      const docs = await invoices
        .find(filter)
        .sort({ issuedAt: 1, sequence: 1 })
        .project<InvoiceSnapshot>(INDEX_PROJECTION)
        .toArray()
      const byOrder = new Map<string, InvoiceIndexEntry[]>()
      for (const doc of docs) {
        const entry = toIndexEntry(doc)
        byOrder.set(entry.orderId, [...(byOrder.get(entry.orderId) ?? []), entry])
      }
      return byOrder
    },

    async getInvoiceForOrder(orderId) {
      const { invoices } = await collections()
      const doc = await invoices.findOne({ 'order.id': orderId, status: 'ISSUED' }, { sort: { issuedAt: -1 } })
      return doc ? (withoutId(doc) as InvoiceSnapshot) : null
    },

    async issueInvoice(financialYear, produce) {
      const run = async (): Promise<InvoiceSnapshot> => {
        const { client, counters, invoices } = await collections()
        const session = client.startSession()
        const issued: { value: InvoiceSnapshot | null } = { value: null }
        try {
          await session.withTransaction(
            async () => {
              // Claim the counter first: this write locks the document for the rest of the
              // transaction, so a concurrent issue anywhere waits its turn via a retry.
              const claimed = await counters.findOneAndUpdate(
                { _id: financialYear },
                { $inc: { seq: 1 } },
                { upsert: true, returnDocument: 'after', session },
              )
              let next = claimed?.seq ?? 1

              // Never behind the register, e.g. after a manual edit of the counter.
              const top = await highestSequence(invoices, financialYear, session)
              if (top >= next) {
                next = top + 1
                await counters.updateOne({ _id: financialYear }, { $set: { seq: next } }, { session })
              }

              const snapshot = await produce(next)
              try {
                await invoices.insertOne({ ...snapshot, _id: invoiceFileKey(snapshot.invoiceNumber) }, { session })
              } catch (error) {
                if (isDuplicateKey(error)) {
                  throw new StoreError(
                    `Invoice ${snapshot.invoiceNumber} already exists; refusing to overwrite it.`,
                    'INVOICE_EXISTS',
                  )
                }
                throw error
              }
              issued.value = snapshot
            },
            { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
          )
        } finally {
          await session.endSession()
        }
        if (!issued.value) throw new StoreError('The invoice transaction did not commit.', 'TRANSACTION_ABORTED')
        return issued.value
      }

      return options.processLock === false ? run() : withLock('invoice-number', run)
    },

    async cancelInvoice(invoiceNumberOrKey, cancelledAt, reason) {
      const { invoices } = await collections()
      const _id = invoiceFileKey(invoiceNumberOrKey)
      // Only an ISSUED invoice flips, atomically, so cancelling twice keeps the first reason.
      const updated = await invoices.findOneAndUpdate(
        { _id, status: 'ISSUED' },
        { $set: { status: 'CANCELLED', cancelledAt, cancellationReason: reason } },
        { returnDocument: 'after' },
      )
      const doc = updated ?? (await invoices.findOne({ _id }))
      return doc ? (withoutId(doc) as InvoiceSnapshot) : null
    },

    async ping() {
      const { db } = await connection()
      const started = Date.now()
      await db.command({ ping: 1 })
      return Date.now() - started
    },

    async registerCounts() {
      const { invoices, counters } = await collections()
      const [invoiceCount, counterCount] = await Promise.all([
        invoices.countDocuments({}),
        counters.countDocuments({}),
      ])
      return { invoices: invoiceCount, counters: counterCount }
    },

    async importSnapshot(snapshot) {
      const { invoices } = await collections()
      try {
        await invoices.insertOne({ ...snapshot, _id: invoiceFileKey(snapshot.invoiceNumber) })
      } catch (error) {
        if (isDuplicateKey(error)) {
          throw new StoreError(`Invoice ${snapshot.invoiceNumber} already exists; refusing to overwrite it.`, 'INVOICE_EXISTS')
        }
        throw error
      }
    },

    async importCounter(financialYear, seq) {
      const { counters } = await collections()
      await counters.updateOne({ _id: financialYear }, { $set: { seq } }, { upsert: true })
    },

    async resetForTests() {
      assertTestDatabase()
      const { db } = await connection()
      await Promise.all(Object.values(COLLECTIONS).map((name) => db.collection(name).deleteMany({})))
    },

    async dropForTests() {
      assertTestDatabase()
      const { db } = await connection()
      await Promise.all(Object.values(COLLECTIONS).map((name) => db.collection(name).drop().catch(() => false)))
    },

    async close() {
      if (!connecting) return
      const pending = connecting
      connecting = null
      const { client } = await pending.catch(() => ({ client: null }))
      await client?.close()
    },
  }

  return backend
}
