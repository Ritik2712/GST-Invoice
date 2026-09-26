import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildInvoice } from '../gst/invoice'
import { DEFAULT_SETTINGS } from '../gst/settings'
import type { NormalizedOrder, RateTable } from '../gst/types'
import { pdfFileName, renderInvoicePdf } from './render'

/** Smoke test: the PDF layout must render without throwing for both tax splits. */

const rateTable: RateTable = { version: 1, fallback: { hsn: '9999', rate: 18 }, rules: [] }

const settings = {
  ...DEFAULT_SETTINGS,
  legalBusinessName: 'Aurum Design LLP',
  gstin: '27ABCDE1234F1Z5',
  sellerStateCode: '27',
  sellerStateName: 'Maharashtra',
  registeredAddress: '12 Turner Road\nBandra West\nMumbai 400050',
  invoicePrefix: 'AD/',
  defaultHsn: '9999',
  terms: 'Payment due on receipt.\nGoods once sold are not returnable.',
  bank: { bankName: 'HDFC Bank', accountName: 'Aurum Design LLP', accountNumber: '50200012345678', ifsc: 'HDFC0000123' },
}

function order(stateCode: string): NormalizedOrder {
  return {
    id: 'gid://shopify/Order/123',
    name: '#1042',
    orderNumber: 1042,
    createdAt: '2026-09-01T10:00:00Z',
    processedAt: '2026-09-01T10:00:00Z',
    currency: 'INR',
    financialStatus: 'PAID',
    isTest: false,
    cancelledAt: null,
    customerName: 'Rhea Kapoor',
    customerGstin: null,
    shippingAddress: {
      name: 'Rhea Kapoor',
      line1: '4 Koregaon Park',
      city: 'Pune',
      stateCode,
      stateName: 'Maharashtra',
      pincode: '411001',
      country: 'IN',
    },
    billingAddress: null,
    customerDefaultAddress: null,
    lines: [
      { id: 'l1', title: 'Linen shirt', variantTitle: 'M / Ivory', quantity: 2, unitPrice: 1180, discount: 100 },
      { id: 'l2', title: 'Cotton scarf', quantity: 1, unitPrice: 590, discount: 0 },
    ],
    shipping: { amount: 118, discount: 0, title: 'Standard shipping' },
    orderTotal: 2968,
  }
}

async function render(stateCode: string) {
  const invoice = buildInvoice({
    order: order(stateCode),
    settings,
    rateTable,
    series: 'REAL',
    invoiceNumber: 'AD/26-27/106',
    financialYear: '2026-27',
    sequence: 106,
    issuedAt: new Date('2026-09-12T06:00:00Z'),
  })
  return { invoice, pdf: await renderInvoicePdf(invoice) }
}

describe('invoice PDF', () => {
  it('renders an intra-state invoice', async () => {
    const { invoice, pdf } = await render('MH')
    expect(invoice.taxKind).toBe('INTRA_STATE')
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.byteLength).toBeGreaterThan(2000)

    // Left behind for eyeballing the layout after a change.
    await fs.writeFile(path.join(os.tmpdir(), pdfFileName(invoice)), pdf)
  }, 30_000)

  it('renders an inter-state invoice', async () => {
    const { invoice, pdf } = await render('KA')
    expect(invoice.taxKind).toBe('INTER_STATE')
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  }, 30_000)

  it('renders a cancelled invoice with its number intact', async () => {
    const { invoice } = await render('MH')
    const cancelled = { ...invoice, status: 'CANCELLED' as const, cancelledAt: '2026-09-20T00:00:00Z', cancellationReason: 'CUSTOMER' }
    const pdf = await renderInvoicePdf(cancelled)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(cancelled.invoiceNumber).toBe('AD/26-27/106')
  }, 30_000)

  it('names the file safely', async () => {
    const { invoice } = await render('MH')
    expect(pdfFileName(invoice)).toBe('AD_26-27_106.pdf')
  }, 30_000)
})
