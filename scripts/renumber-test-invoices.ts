/**
 * One-off: moves invoices that were raised on Shopify *test* orders into the TEST series,
 * so the real series can start clean at 1.
 *
 *   npm run renumber:test              dry run - shows every change
 *   npm run renumber:test -- --apply   renumbers, then verifies
 *
 * For each affected invoice the sequence is kept as it is (so the order of the register is
 * preserved) and only the number and series change, e.g. INV/26-27/4 -> TEST/26-27/4.
 * Every order is checked against Shopify first: if an invoice belongs to a real order the
 * script stops and changes nothing, because a real invoice must never be renumbered.
 */
import { existsSync } from 'node:fs'

import { prefixFor } from '../lib/gst/invoice'
import { formatInvoiceNumber } from '../lib/gst/numbering'
import { counterKey } from '../lib/storage/shared'
import type { InvoiceSnapshot } from '../lib/gst/types'
import { fetchOrder } from '../lib/shopify/orders'
import { createMongoBackend } from '../lib/storage/mongo'

const apply = process.argv.includes('--apply')
if (existsSync('.env')) process.loadEnvFile('.env')

const uri = (process.env.MONGODB_URI ?? '').trim()
const dbName = (process.env.MONGODB_DB ?? '').trim() || 'gst_invoice'

async function main(): Promise<void> {
  if (!uri) throw new Error('MONGODB_URI is not set in .env')
  const store = createMongoBackend({ uri, dbName })

  try {
    const settings = await store.getSettings()
    const entries = await store.listInvoices()
    if (entries.length === 0) {
      console.log('No invoices in the register - nothing to do.')
      return
    }

    // Ask Shopify which orders were test orders; cache per order id.
    const isTest = new Map<string, boolean>()
    for (const id of new Set(entries.map((e) => e.orderId))) {
      const order = await fetchOrder(id)
      if (!order) throw new Error(`Order ${id} no longer exists in Shopify; cannot tell if it was a test order`)
      isTest.set(id, order.isTest)
    }

    const snapshots: InvoiceSnapshot[] = []
    for (const entry of entries) {
      const snapshot = await store.getInvoice(entry.invoiceNumber)
      if (!snapshot) throw new Error(`Invoice ${entry.invoiceNumber} is in the index but missing`)
      snapshots.push(snapshot)
    }
    snapshots.sort((a, b) => a.financialYear.localeCompare(b.financialYear) || a.sequence - b.sequence)

    const onRealOrders = snapshots.filter((s) => !isTest.get(s.order.id))
    const toMove = snapshots.filter((s) => isTest.get(s.order.id) && (s.series ?? 'REAL') !== 'TEST')

    console.log(`Register: ${snapshots.length} invoices`)
    console.log(`  on test orders, to move to the TEST series: ${toMove.length}`)
    console.log(`  on real orders, left untouched            : ${onRealOrders.length}`)
    if (onRealOrders.length > 0) {
      console.log('\nInvoices on real orders (these keep their numbers):')
      for (const s of onRealOrders) console.log(`  ${s.invoiceNumber} - order ${s.order.name}`)
    }
    if (toMove.length === 0) {
      console.log('\nNothing to renumber.')
      return
    }

    const planned = toMove.map((snapshot) => ({
      snapshot,
      newNumber: formatInvoiceNumber(prefixFor('TEST', settings), snapshot.financialYear, snapshot.sequence),
    }))
    console.log('\nPlanned changes:')
    for (const { snapshot, newNumber } of planned) {
      console.log(`  ${snapshot.invoiceNumber.padEnd(14)} -> ${newNumber.padEnd(15)} (${snapshot.status}, order ${snapshot.order.name})`)
    }

    // Counters afterwards: the TEST series continues from the highest moved sequence, and
    // the real series restarts, since nothing real has been issued.
    const byFy = new Map<string, number>()
    for (const { snapshot } of planned) {
      byFy.set(snapshot.financialYear, Math.max(byFy.get(snapshot.financialYear) ?? 0, snapshot.sequence))
    }
    const realTops = new Map<string, number>()
    for (const s of onRealOrders) realTops.set(s.financialYear, Math.max(realTops.get(s.financialYear) ?? 0, s.sequence))

    console.log('\nCounters afterwards:')
    for (const [fy, top] of byFy) console.log(`  ${counterKey('TEST', fy)} = ${top}`)
    for (const fy of byFy.keys()) console.log(`  ${counterKey('REAL', fy)} = ${realTops.get(fy) ?? 0}${realTops.get(fy) ? '' : '  (next real invoice will be 1)'}`)

    if (!apply) {
      console.log('\nDry run only. Re-run with --apply to make these changes.')
      return
    }

    for (const { snapshot, newNumber } of planned) {
      await store.renumberInvoice(snapshot.invoiceNumber, { ...snapshot, series: 'TEST', invoiceNumber: newNumber })
    }
    for (const [fy, top] of byFy) {
      await store.importCounter(counterKey('TEST', fy), top)
      const realTop = realTops.get(fy) ?? 0
      if (realTop > 0) await store.importCounter(counterKey('REAL', fy), realTop)
      else await store.deleteCounter(counterKey('REAL', fy))
    }
    await store.saveSettings({ ...settings, lastIssuedNumber: realTops.get([...byFy.keys()][0]) ?? 0 })

    const problems: string[] = []
    for (const { snapshot, newNumber } of planned) {
      const moved = await store.getInvoice(newNumber)
      if (!moved) problems.push(`${newNumber} is missing after the move`)
      else if (moved.series !== 'TEST') problems.push(`${newNumber} did not get series TEST`)
      else if (moved.sequence !== snapshot.sequence) problems.push(`${newNumber} changed sequence`)
      else if (moved.totals.grandTotal !== snapshot.totals.grandTotal) problems.push(`${newNumber} changed totals`)
      if (await store.getInvoice(snapshot.invoiceNumber)) problems.push(`${snapshot.invoiceNumber} still exists under its old number`)
    }
    const after = await store.listInvoices()
    if (after.length !== snapshots.length) problems.push(`register now has ${after.length} invoices, expected ${snapshots.length}`)
    if (problems.length) throw new Error(`Renumbered, but verification failed:\n  - ${problems.join('\n  - ')}`)

    console.log(`\nMoved ${planned.length} invoices to the TEST series and reset the real counter. Verified.`)
  } finally {
    await store.close()
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
