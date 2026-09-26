import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { InvoiceSnapshot } from '../gst/types'
import { createMongoBackend, type MongoBackend } from './mongo'

/**
 * The numbering guarantees, proven against a real MongoDB. Skipped unless TEST_MONGODB_URI
 * is set, so `npm test` needs no network. Each run uses its own throwaway
 * gst_invoice_test_* database and drops it afterwards; the backend refuses to wipe anything
 * else. The process lock is off, so concurrency is enforced by transactions alone - exactly
 * the situation of several Vercel instances.
 */

const uri = process.env.TEST_MONGODB_URI
const suite = uri ? describe : describe.skip

function snapshot(sequence: number, orderId = `gid://shopify/Order/${sequence}`, fy = '2026-27'): InvoiceSnapshot {
  return {
    schemaVersion: 2,
    series: 'REAL',
    invoiceNumber: `AD/${fy.slice(2)}/${sequence}`,
    financialYear: fy,
    sequence,
    issuedAt: new Date(2026, 8, 12, 12, 0, sequence).toISOString(),
    invoiceDate: '12-09-2026',
    status: 'ISSUED',
    seller: { legalName: 'Seller', gstin: '27ABCDE1234F1Z5', stateCode: '27', stateName: 'Maharashtra', address: 'Mumbai' },
    buyer: { name: 'Buyer' },
    order: { id: orderId, name: `#${1000 + sequence}`, number: 1000 + sequence, placedAt: '2026-09-01T00:00:00Z', financialStatus: 'PAID', currency: 'INR', shopifyTotal: 118 },
    placeOfSupply: { stateCode: '27', stateName: 'Maharashtra', source: 'shipping-address' },
    taxKind: 'INTRA_STATE',
    pricesIncludeGst: true,
    reverseCharge: false,
    lines: [],
    hsnSummary: [],
    totals: { taxableValue: 100, discount: 0, cgst: 9, sgst: 9, igst: 0, cess: 0, taxTotal: 18, subTotal: 118, roundOff: 0, grandTotal: 118 },
    amountInWords: 'Rupees One Hundred Eighteen Only',
    rateTableVersion: 1,
  } as InvoiceSnapshot
}

suite('MongoDB store (live database)', () => {
  let store: MongoBackend

  beforeAll(() => {
    store = createMongoBackend({ uri: uri!, dbName: `gst_invoice_test_${randomUUID().slice(0, 8)}`, processLock: false })
  })

  beforeEach(async () => {
    await store.resetForTests()
  })

  afterAll(async () => {
    await store?.dropForTests().catch(() => {})
    await store?.close()
  })

  it('refuses to wipe a database that is not a test database', async () => {
    const live = createMongoBackend({ uri: uri!, dbName: 'gst_invoice', processLock: false })
    await expect(live.resetForTests()).rejects.toThrow(/Refusing to wipe/)
    await live.close()
  })

  it('starts at 1 and increments', async () => {
    expect((await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq))).sequence).toBe(1)
    expect((await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq))).sequence).toBe(2)
    expect(await store.getLastIssued('REAL', '2026-27')).toBe(2)
  })

  it('continues from an edited counter', async () => {
    await store.setLastIssued('REAL', '2026-27', 105)
    expect((await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq))).sequence).toBe(106)
  })

  it('burns no number when the producer fails', async () => {
    await store.setLastIssued('REAL', '2026-27', 10)
    await expect(
      store.issueInvoice('REAL', '2026-27', async () => {
        throw new Error('PDF render exploded')
      }),
    ).rejects.toThrow('PDF render exploded')

    expect(await store.getLastIssued('REAL', '2026-27')).toBe(10)
    expect((await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq))).sequence).toBe(11)
  })

  it('keeps each financial year on its own series', async () => {
    await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq))
    await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq))
    const next = await store.issueInvoice('REAL', '2027-28', async (seq) => snapshot(seq, 'gid://shopify/Order/ny', '2027-28'))
    expect(next.sequence).toBe(1)
    expect(await store.getLastIssued('REAL', '2026-27')).toBe(2)
  })

  it('gives concurrent issues distinct, gapless numbers using transactions alone', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq, `gid://shopify/Order/c${i}`)),
      ),
    )
    expect(results.map((r) => r.sequence).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    expect(await store.getLastIssued('REAL', '2026-27')).toBe(5)
  }, 90_000)

  it('counts the two series separately and allows the same sequence in each', async () => {
    const testSnapshot = (sequence: number) => ({
      ...snapshot(sequence, `gid://shopify/Order/t${sequence}`),
      series: 'TEST' as const,
      invoiceNumber: `TEST/26-27/${sequence}`,
    })

    const real = await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq))
    const test = await store.issueInvoice('TEST', '2026-27', async (seq) => testSnapshot(seq))

    expect(real.sequence).toBe(1)
    expect(test.sequence).toBe(1)
    expect(await store.getLastIssued('REAL', '2026-27')).toBe(1)
    expect(await store.getLastIssued('TEST', '2026-27')).toBe(1)
    expect(await store.getInvoice(test.invoiceNumber)).toMatchObject({ series: 'TEST' })
  })

  it('keeps the series when invoices are listed', async () => {
    // The index projection once dropped `series`, so everything read back as REAL.
    const testSnapshot = { ...snapshot(1, 'gid://shopify/Order/s1'), series: 'TEST' as const, invoiceNumber: 'TEST/26-27/1' }
    await store.issueInvoice('TEST', '2026-27', async () => testSnapshot)

    expect((await store.listInvoices())[0]).toMatchObject({ invoiceNumber: 'TEST/26-27/1', series: 'TEST' })
    const byOrder = await store.getInvoicesByOrderId(['gid://shopify/Order/s1'])
    expect(byOrder.get('gid://shopify/Order/s1')?.[0]).toMatchObject({ series: 'TEST' })
  })

  it('renumbers an invoice into the other series without losing it', async () => {
    const issued = await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq, 'gid://shopify/Order/9'))
    await store.renumberInvoice(issued.invoiceNumber, { ...issued, series: 'TEST', invoiceNumber: 'TEST/26-27/1' })

    expect(await store.getInvoice(issued.invoiceNumber)).toBeNull()
    expect(await store.getInvoice('TEST/26-27/1')).toMatchObject({ series: 'TEST', sequence: 1, totals: issued.totals })
    expect(await store.listInvoices()).toHaveLength(1)
  })

  it('refuses to move the counter below an issued number', async () => {
    await store.setLastIssued('REAL', '2026-27', 5)
    await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq))
    await expect(store.setLastIssued('REAL', '2026-27', 3)).rejects.toThrow(/cannot be set below 6/)
  })

  it('recovers a counter that fell behind the register', async () => {
    await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq))
    await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq))
    await store.importCounter('2026-27', 1)
    expect((await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq))).sequence).toBe(3)
  })

  it('refuses to overwrite an existing invoice, and rolls the counter back', async () => {
    await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq))
    await expect(store.issueInvoice('REAL', '2026-27', async () => snapshot(1))).rejects.toThrow(/already exists/)
    expect(await store.getLastIssued('REAL', '2026-27')).toBe(1)
  })

  it('reads an invoice by number and by URL-safe key', async () => {
    const issued = await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq, 'gid://shopify/Order/42'))
    expect(await store.getInvoice(issued.invoiceNumber)).toEqual(issued)
    expect(await store.getInvoice('AD_26-27_1')).toEqual(issued)
    expect(await store.getInvoiceForOrder('gid://shopify/Order/42')).toEqual(issued)
  })

  it('cancels without deleting, frees the order, and reissues under the next number', async () => {
    const first = await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq, 'gid://shopify/Order/7'))
    const cancelled = await store.cancelInvoice(first.invoiceNumber, '2026-09-20T00:00:00Z', 'Wrong rate')
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Wrong rate' })
    expect(await store.getInvoiceForOrder('gid://shopify/Order/7')).toBeNull()

    const again = await store.cancelInvoice(first.invoiceNumber, '2026-09-21T00:00:00Z', 'Second')
    expect(again?.cancellationReason).toBe('Wrong rate')

    const reissued = await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq, 'gid://shopify/Order/7'))
    expect(reissued.sequence).toBe(2)

    const history = (await store.getInvoicesByOrderId(['gid://shopify/Order/7'])).get('gid://shopify/Order/7')!
    expect(history.map((e) => [e.sequence, e.status])).toEqual([
      [1, 'CANCELLED'],
      [2, 'ISSUED'],
    ])
    expect(await store.listInvoices()).toHaveLength(2)
  })

  it('limits the order lookup to the ids asked for', async () => {
    await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq, 'gid://shopify/Order/a'))
    await store.issueInvoice('REAL', '2026-27', async (seq) => snapshot(seq, 'gid://shopify/Order/b'))
    const map = await store.getInvoicesByOrderId(['gid://shopify/Order/a'])
    expect([...map.keys()]).toEqual(['gid://shopify/Order/a'])
  })

  it('rejects a duplicate number even through the import path', async () => {
    await store.importSnapshot(snapshot(3))
    await expect(store.importSnapshot(snapshot(3))).rejects.toThrow(/already exists/)
  })

  it('round-trips settings and merges missing fields over the defaults', async () => {
    const settings = await store.getSettings()
    await store.saveSettings({ ...settings, legalBusinessName: 'U3 Fashion' })
    const back = await store.getSettings()
    expect(back.legalBusinessName).toBe('U3 Fashion')
    expect(back.deliveryLineLabel).toBe('Delivery charges')
  })

  it('seeds the rate table on first read', async () => {
    const table = await store.getRateTable()
    expect(table.rules.length).toBeGreaterThan(0)
    expect((await store.getRateTable()).version).toBe(table.version)
  })
}, 120_000)
