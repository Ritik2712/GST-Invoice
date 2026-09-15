import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InvoiceSnapshot } from './gst/types'

/**
 * Exercises the numbering guarantees against the real filesystem in a temp directory:
 * gapless within a financial year, never allotted on failure, never reused, and safe
 * under concurrent callers.
 */

let dataRoot: string
let store: typeof import('./store')

beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gst-store-'))
  vi.spyOn(process, 'cwd').mockReturnValue(dataRoot)
  vi.stubEnv('MONGODB_URI', '')
  vi.stubEnv('VERCEL', '')
  vi.resetModules()
  store = await import('./store')
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await fs.rm(dataRoot, { recursive: true, force: true })
})

function snapshot(sequence: number, orderId = `gid://shopify/Order/${sequence}`): InvoiceSnapshot {
  return {
    schemaVersion: 1,
    invoiceNumber: `AD/26-27/${sequence}`,
    financialYear: '2026-27',
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
  }
}

describe('invoice numbering on disk', () => {
  it('starts at 1 and increments', async () => {
    const first = await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))
    const second = await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))

    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(2)
    expect(await store.getLastIssued('2026-27')).toBe(2)
  })

  it('continues from an edited counter', async () => {
    await store.setLastIssued('2026-27', 105)
    const issued = await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))
    expect(issued.invoiceNumber).toBe('AD/26-27/106')
  })

  it('burns no number when the producer fails', async () => {
    await store.setLastIssued('2026-27', 10)

    await expect(
      store.issueInvoice('2026-27', async () => {
        throw new Error('PDF render exploded')
      }),
    ).rejects.toThrow('PDF render exploded')

    expect(await store.getLastIssued('2026-27')).toBe(10)
    const next = await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))
    expect(next.sequence).toBe(11)
  })

  it('keeps each financial year on its own series', async () => {
    await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))
    await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))
    const newYear = await store.issueInvoice('2027-28', async (sequence) => ({
      ...snapshot(sequence),
      financialYear: '2027-28',
      invoiceNumber: `AD/27-28/${sequence}`,
      order: { ...snapshot(sequence).order, id: 'gid://shopify/Order/new-year' },
    }))

    expect(newYear.sequence).toBe(1)
    expect(await store.getLastIssued('2026-27')).toBe(2)
  })

  it('gives concurrent callers distinct, gapless numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.issueInvoice('2026-27', async (sequence) => {
          // Force interleaving: without the lock these would collide on the same number.
          await new Promise((resolve) => setTimeout(resolve, 5 - index))
          return snapshot(sequence, `gid://shopify/Order/${index}`)
        }),
      ),
    )

    expect([...results.map((r) => r.sequence)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('refuses to move the counter below an issued number', async () => {
    await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))
    await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))
    await expect(store.setLastIssued('2026-27', 1)).rejects.toThrow(/already been issued/)
  })

  it('recovers a counter that fell behind the files on disk', async () => {
    await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))
    await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))

    // Simulate a crash between writing the snapshot and writing the counter.
    await fs.writeFile(path.join(dataRoot, 'data', 'counter.json'), JSON.stringify({ '2026-27': 1 }))

    const next = await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))
    expect(next.sequence).toBe(3)
  })
})

describe('cancellation and immutability', () => {
  it('marks an invoice cancelled without deleting it or reusing the number', async () => {
    const issued = await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))
    const cancelled = await store.cancelInvoice(issued.invoiceNumber, '2026-09-20T00:00:00Z', 'CUSTOMER')

    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancellationReason: 'CUSTOMER' })
    expect(cancelled!.invoiceNumber).toBe(issued.invoiceNumber)
    expect(cancelled!.totals).toEqual(issued.totals)

    const file = path.join(dataRoot, 'data', 'invoices', 'AD_26-27_1.json')
    await expect(fs.access(file)).resolves.toBeUndefined()

    // The number stays consumed: the next invoice is 2, not 1.
    const next = await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))
    expect(next.sequence).toBe(2)
  })

  it('refuses to overwrite an existing invoice file', async () => {
    await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))

    // Last-resort guard: a producer that hands back a number other than the one it was
    // allotted must not clobber an invoice that already exists.
    await expect(store.issueInvoice('2026-27', async () => snapshot(1))).rejects.toThrow(/already exists/)
    expect(await store.getLastIssued('2026-27')).toBe(1)
  })

  it('will not let the counter be rewound past an issued invoice', async () => {
    await store.setLastIssued('2026-27', 5)
    await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence))
    await expect(store.setLastIssued('2026-27', 3)).rejects.toThrow(/cannot be set below 6/)
  })

  it('replays the stored snapshot for an order', async () => {
    const issued = await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence, 'gid://shopify/Order/42'))
    const replayed = await store.getInvoiceForOrder('gid://shopify/Order/42')
    expect(replayed).toEqual(issued)
  })

  it('rebuilds a lost index from the snapshot files', async () => {
    await store.issueInvoice('2026-27', async (sequence) => snapshot(sequence, 'gid://shopify/Order/7'))
    await fs.rm(path.join(dataRoot, 'data', 'invoices', '_index.json'))

    vi.resetModules()
    const reloaded = await import('./store')
    expect((await reloaded.getInvoiceForOrder('gid://shopify/Order/7'))?.sequence).toBe(1)
  })
})

describe('cancel and reissue', () => {
  it('frees the order for a new invoice under the next number', async () => {
    const first = await store.issueInvoice('2026-27', async (seq) =>
      snapshot(seq, 'gid://shopify/Order/42'),
    )
    await store.cancelInvoice(first.invoiceNumber, '2026-09-20T00:00:00Z', 'Wrong GST rate')

    // The cancelled invoice is no longer the order's live document...
    expect(await store.getInvoiceForOrder('gid://shopify/Order/42')).toBeNull()

    // ...but it is still on disk and still readable by number.
    const stored = await store.getInvoice(first.invoiceNumber)
    expect(stored).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Wrong GST rate' })

    const reissued = await store.issueInvoice('2026-27', async (seq) =>
      snapshot(seq, 'gid://shopify/Order/42'),
    )
    expect(reissued.sequence).toBe(2) // 1 stays consumed
    expect((await store.getInvoiceForOrder('gid://shopify/Order/42'))?.sequence).toBe(2)
  })

  it('keeps both invoices in the order history', async () => {
    const first = await store.issueInvoice('2026-27', async (seq) => snapshot(seq, 'gid://shopify/Order/7'))
    await store.cancelInvoice(first.invoiceNumber, '2026-09-20T00:00:00Z', 'Duplicate')
    await store.issueInvoice('2026-27', async (seq) => snapshot(seq, 'gid://shopify/Order/7'))

    const entries = (await store.getInvoicesByOrderId()).get('gid://shopify/Order/7')!
    expect(entries.map((e) => [e.sequence, e.status])).toEqual([
      [1, 'CANCELLED'],
      [2, 'ISSUED'],
    ])
    expect(store.activeEntry(entries)?.sequence).toBe(2)
    expect(await store.listInvoices()).toHaveLength(2)
  })

  it('rebuilds an order history of several invoices from the files', async () => {
    const first = await store.issueInvoice('2026-27', async (seq) => snapshot(seq, 'gid://shopify/Order/9'))
    await store.cancelInvoice(first.invoiceNumber, '2026-09-20T00:00:00Z', 'Wrong address')
    await store.issueInvoice('2026-27', async (seq) => snapshot(seq, 'gid://shopify/Order/9'))
    await fs.rm(path.join(dataRoot, 'data', 'invoices', '_index.json'))

    vi.resetModules()
    const reloaded = await import('./store')
    const entries = (await reloaded.getInvoicesByOrderId()).get('gid://shopify/Order/9')!
    expect(entries).toHaveLength(2)
    expect(reloaded.activeEntry(entries)?.sequence).toBe(2)
  })

  it('migrates an index written in the old one-invoice-per-order shape', async () => {
    const issued = await store.issueInvoice('2026-27', async (seq) => snapshot(seq, 'gid://shopify/Order/5'))

    // The pre-cancellation format stored a bare entry, not an array.
    await fs.writeFile(
      path.join(dataRoot, 'data', 'invoices', '_index.json'),
      JSON.stringify({ 'gid://shopify/Order/5': { invoiceNumber: issued.invoiceNumber, sequence: 1, status: 'ISSUED' } }),
    )

    vi.resetModules()
    const reloaded = await import('./store')
    const entries = (await reloaded.getInvoicesByOrderId()).get('gid://shopify/Order/5')!
    expect(Array.isArray(entries)).toBe(true)
    expect(entries[0].invoiceNumber).toBe(issued.invoiceNumber)
  })

  it('cancelling twice is a no-op rather than a second cancellation', async () => {
    const issued = await store.issueInvoice('2026-27', async (seq) => snapshot(seq))
    await store.cancelInvoice(issued.invoiceNumber, '2026-09-20T00:00:00Z', 'First')
    const again = await store.cancelInvoice(issued.invoiceNumber, '2026-09-21T00:00:00Z', 'Second')
    expect(again?.cancellationReason).toBe('First')
  })
})

describe('settings and rate table', () => {
  it('round-trips settings and merges over the defaults', async () => {
    const settings = await store.getSettings()
    await store.saveSettings({ ...settings, legalBusinessName: 'Aurum Design LLP' })
    expect((await store.getSettings()).legalBusinessName).toBe('Aurum Design LLP')
    // A field absent from the saved file comes back as its default.
    expect((await store.getSettings()).deliveryLineLabel).toBe('Delivery charges')
  })

  it('defaults a field a previously-written settings file does not have', async () => {
    // A settings.json saved before autoDownloadAfterGenerate existed must still load, with
    // the new field taking its default rather than coming back undefined.
    await fs.mkdir(path.join(dataRoot, 'data'), { recursive: true })
    await fs.writeFile(
      path.join(dataRoot, 'data', 'settings.json'),
      JSON.stringify({ legalBusinessName: 'U3 Fashion', invoicePrefix: 'INV/' }),
    )

    const settings = await store.getSettings()
    expect(settings.legalBusinessName).toBe('U3 Fashion')
    expect(settings.autoDownloadAfterGenerate).toBe(false)
    expect(settings.pricesIncludeGst).toBe(true)
  })

  it('seeds the rate table on first read', async () => {
    const table = await store.getRateTable()
    expect(table.rules.length).toBeGreaterThan(0)
    await expect(fs.access(path.join(dataRoot, 'data', 'hsn-rates.json'))).resolves.toBeUndefined()
  })
})
