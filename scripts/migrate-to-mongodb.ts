/**
 * One-off: copies the JSON-file register under ./data into MongoDB.
 *
 *   npm run migrate:mongodb              dry run - shows what would be copied
 *   npm run migrate:mongodb -- --apply   copies, then verifies every document read back
 *
 * Refuses to write into a database that already holds invoices or counters, so it can never
 * merge two registers or overwrite a live one. The files in ./data are left untouched and
 * remain a backup. Settings and the rate table in the target are replaced by the file
 * versions (the app may have seeded a default rate table there before the migration).
 */
import { existsSync } from 'node:fs'

import type { InvoiceSnapshot } from '../lib/gst/types'
import { fileBackend } from '../lib/storage/file'
import { createMongoBackend } from '../lib/storage/mongo'

const apply = process.argv.includes('--apply')
if (existsSync('.env')) process.loadEnvFile('.env')

const uri = (process.env.MONGODB_URI ?? '').trim()
const dbName = (process.env.MONGODB_DB ?? '').trim() || 'gst_invoice'

/** Key-order-insensitive comparison: MongoDB may not preserve the order JSON had. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    )
  }
  return value
}

const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

async function main(): Promise<void> {
  if (!uri) throw new Error('MONGODB_URI is not set in .env')

  const settings = await fileBackend.getSettings()
  const rateTable = await fileBackend.getRateTable()
  const counter = await fileBackend.getCounter()
  const entries = await fileBackend.listInvoices()

  const snapshots: InvoiceSnapshot[] = []
  for (const entry of entries) {
    const snapshot = await fileBackend.getInvoice(entry.invoiceNumber)
    if (!snapshot) throw new Error(`The index lists ${entry.invoiceNumber}, but its file is missing`)
    snapshots.push(snapshot)
  }
  snapshots.sort((a, b) => a.financialYear.localeCompare(b.financialYear) || a.sequence - b.sequence)

  console.log('Source: ./data')
  console.log(`  settings    : ${settings.legalBusinessName || '(blank)'}`)
  console.log(`  rate table  : version ${rateTable.version}, ${rateTable.rules.length} rules`)
  console.log(`  counters    : ${JSON.stringify(counter)}`)
  console.log(
    `  invoices    : ${snapshots.length} (${snapshots.filter((s) => s.status === 'ISSUED').length} issued, ${snapshots.filter((s) => s.status === 'CANCELLED').length} cancelled)`,
  )

  const mongo = createMongoBackend({ uri, dbName })
  try {
    const existing = await mongo.registerCounts()
    console.log(`\nTarget: MongoDB database "${dbName}" - ${existing.invoices} invoices, ${existing.counters} counters already there`)

    if (!apply) {
      console.log('\nDry run only. Re-run with --apply to copy.')
      return
    }
    if (existing.invoices > 0 || existing.counters > 0) {
      throw new Error('Refusing to copy: the target already holds an invoice register. Nothing was written.')
    }

    await mongo.saveSettings(settings)
    await mongo.saveRateTable(rateTable)
    for (const [financialYear, seq] of Object.entries(counter)) await mongo.importCounter(financialYear, seq)
    for (const snapshot of snapshots) await mongo.importSnapshot(snapshot)

    const problems: string[] = []
    if (!same(await mongo.getSettings(), settings)) problems.push('settings differ')
    if (!same(await mongo.getRateTable(), rateTable)) problems.push('rate table differs')
    if (!same(await mongo.getCounter(), counter)) problems.push('counters differ')
    for (const snapshot of snapshots) {
      if (!same(await mongo.getInvoice(snapshot.invoiceNumber), snapshot)) problems.push(`invoice ${snapshot.invoiceNumber} differs`)
    }
    const after = await mongo.registerCounts()
    if (after.invoices !== snapshots.length) problems.push(`expected ${snapshots.length} invoices, found ${after.invoices}`)

    if (problems.length) throw new Error(`Copied, but verification failed:\n  - ${problems.join('\n  - ')}`)
    console.log(`\nCopied and verified: settings, rate table, ${Object.keys(counter).length} counter(s), ${after.invoices} invoices.`)
    console.log('The files in ./data are untouched and remain a backup.')
  } finally {
    await mongo.close()
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
