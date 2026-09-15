import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type AppSettings } from './gst/settings'
import type { RateTable } from './gst/types'
import { renderInvoicePdf } from './pdf/render'
import { buildSamplePreview, sampleOrder } from './sample-invoice'
import { DEFAULT_RATE_TABLE } from './seed/rate-table'

const configured: AppSettings = {
  ...DEFAULT_SETTINGS,
  legalBusinessName: 'Aurum Design LLP',
  gstin: '27ABCDE1234F1Z5',
  sellerStateCode: '27',
  sellerStateName: 'Maharashtra',
  registeredAddress: '12 Turner Road\nBandra West\nMumbai 400050',
  invoicePrefix: 'AD/',
  defaultHsn: '9999',
  terms: 'Payment due on receipt.',
  bank: { bankName: 'HDFC Bank', accountName: 'Aurum Design LLP', accountNumber: '50200012345678', ifsc: 'HDFC0000123' },
}

const issuedAt = new Date('2026-09-12T06:00:00Z')

const preview = (settings: AppSettings, pos?: string, rateTable: RateTable = DEFAULT_RATE_TABLE) =>
  buildSamplePreview({ settings, rateTable, lastIssued: 105, placeOfSupplyStateCode: pos, issuedAt })

describe('sample invoice preview', () => {
  it('shows the number the next real invoice would get', () => {
    const { invoice } = preview(configured)
    expect(invoice.invoiceNumber).toBe('AD/26-27/106')
    expect(invoice.sequence).toBe(106)
  })

  it('defaults the place of supply to the seller state, giving CGST + SGST', () => {
    const { invoice } = preview(configured)
    expect(invoice.taxKind).toBe('INTRA_STATE')
    expect(invoice.placeOfSupply.stateCode).toBe('27')
    expect(invoice.totals.igst).toBe(0)
    expect(invoice.totals.cgst).toBeGreaterThan(0)
  })

  it('switches to IGST for another state', () => {
    const { invoice } = preview(configured, '29')
    expect(invoice.taxKind).toBe('INTER_STATE')
    expect(invoice.placeOfSupply.stateName).toBe('Karnataka')
    expect(invoice.totals.cgst).toBe(0)
    expect(invoice.totals.igst).toBeGreaterThan(0)
  })

  it('exercises three different rates so the HSN summary is not trivial', () => {
    const { invoice } = preview(configured)
    const rates = new Set(invoice.lines.map((line) => line.rate))
    // apparel slab (12), gst:5 tag (5), fallback (18); delivery is its own 18% service.
    expect(rates.has(5)).toBe(true)
    expect(rates.has(12)).toBe(true)
    expect(rates.has(18)).toBe(true)
    expect(invoice.hsnSummary.length).toBeGreaterThanOrEqual(3)
  })

  it('renders with placeholder seller details when settings are empty', () => {
    const { invoice, usedPlaceholders } = preview(DEFAULT_SETTINGS)
    expect(usedPlaceholders).toBe(true)
    expect(invoice.seller.legalName).toContain('Settings')
    expect(invoice.seller.gstin).toBe('27AAAAA0000A1Z5')
  })

  it('reports no placeholders once settings validate', () => {
    expect(preview(configured).usedPlaceholders).toBe(false)
  })

  it('keeps the sample order out of the real order namespace', () => {
    // Order id 0 can never collide with a real Shopify order, so even if a preview
    // snapshot were somehow persisted it could not shadow a real invoice.
    expect(sampleOrder('27').id).toBe('gid://shopify/Order/0')
    expect(sampleOrder('27').name).toContain('sample')
  })

  it('renders a SAMPLE-stamped PDF', async () => {
    const { invoice } = preview(configured)
    const pdf = await renderInvoicePdf(invoice, { watermark: 'SAMPLE' })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')

    await fs.writeFile(path.join(os.tmpdir(), 'sample-invoice.pdf'), pdf)
  }, 30_000)

  it('renders the IGST variant too', async () => {
    const { invoice } = preview(configured, '29')
    const pdf = await renderInvoicePdf(invoice, { watermark: 'SAMPLE' })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    await fs.writeFile(path.join(os.tmpdir(), 'sample-invoice-igst.pdf'), pdf)
  }, 30_000)
})
