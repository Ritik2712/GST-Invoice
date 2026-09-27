import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildInvoice } from '../gst/invoice'
import { DEFAULT_SETTINGS } from '../gst/settings'
import type { NormalizedOrder, RateTable } from '../gst/types'
import { hsnSummaryTotals, showsDiscountColumn, totalsBreakdown } from './InvoiceDocument'
import { round2 } from '../gst/money'
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

describe('the totals column', () => {
  /** What a reader does: add the printed rows up and check they reach the grand total. */
  const columnSum = (invoice: Awaited<ReturnType<typeof render>>['invoice']) => {
    const { itemSubtotal, itemDiscount, shipping } = totalsBreakdown(invoice.lines)
    const { cgst, sgst, igst, cess, roundOff } = invoice.totals
    return round2(itemSubtotal - itemDiscount + shipping + cgst + sgst + igst + cess + roundOff)
  }

  it('adds up to the grand total', async () => {
    const { invoice } = await render('MH')
    expect(columnSum(invoice)).toBe(invoice.totals.grandTotal)
  })

  it('reaches the printed taxable value, which is what the HSN summary sums to', async () => {
    const { invoice } = await render('MH')
    const { itemSubtotal, itemDiscount, shipping } = totalsBreakdown(invoice.lines)

    expect(round2(itemSubtotal - itemDiscount + shipping)).toBe(invoice.totals.taxableValue)
    expect(round2(invoice.hsnSummary.reduce((total, row) => total + row.taxableValue, 0))).toBe(
      invoice.totals.taxableValue,
    )
  })

  it('adds up across states too', async () => {
    const { invoice } = await render('KA')
    expect(columnSum(invoice)).toBe(invoice.totals.grandTotal)
  })

  it('does not count a waived freight charge as a discount twice', async () => {
    const base = order('MH')
    const invoice = buildInvoice({
      order: {
        ...base,
        lines: [{ id: 'l1', title: 'Linen shirt', quantity: 1, unitPrice: 1180, discount: 0 }],
        // A free-shipping code: charged 118, discounted 118.
        shipping: { amount: 118, discount: 118, title: 'Free shipping' },
        orderTotal: 1180,
      },
      settings,
      rateTable,
      series: 'REAL',
      invoiceNumber: 'AD/26-27/107',
      financialYear: '2026-27',
      sequence: 107,
      issuedAt: new Date('2026-09-12T06:00:00Z'),
    })

    expect(totalsBreakdown(invoice.lines).shipping).toBe(0)
    expect(columnSum(invoice)).toBe(invoice.totals.grandTotal)
  })

  it('reads a snapshot written before grossValue existed', async () => {
    const { invoice } = await render('MH')
    const legacy = invoice.lines.map(({ grossValue: _dropped, ...line }) => line)
    const { itemSubtotal, shipping } = totalsBreakdown(legacy as typeof invoice.lines)

    expect(Number.isFinite(itemSubtotal)).toBe(true)
    expect(Number.isFinite(shipping)).toBe(true)
  })
})

describe('the HSN summary', () => {
  it('totals to the same taxable value and tax as the totals column', async () => {
    const { invoice } = await render('MH')
    const summary = hsnSummaryTotals(invoice.hsnSummary)

    expect(summary.taxableValue).toBe(invoice.totals.taxableValue)
    expect(summary.cgst).toBe(invoice.totals.cgst)
    expect(summary.sgst).toBe(invoice.totals.sgst)
    expect(round2(summary.cgst + summary.sgst + summary.igst + summary.cess)).toBe(
      invoice.totals.taxTotal,
    )
  })

  it('totals across states too, where the tax sits on IGST', async () => {
    const { invoice } = await render('KA')
    const summary = hsnSummaryTotals(invoice.hsnSummary)

    expect(summary.taxableValue).toBe(invoice.totals.taxableValue)
    expect(summary.igst).toBe(invoice.totals.igst)
    expect(summary.cgst).toBe(0)
  })
})

describe('the Discount column', () => {
  const invoiceWith = (
    lines: NormalizedOrder['lines'],
    shipping: NormalizedOrder['shipping'],
    orderTotal: number,
  ) =>
    buildInvoice({
      order: { ...order('MH'), lines, shipping, orderTotal },
      settings,
      rateTable,
      series: 'REAL',
      invoiceNumber: 'AD/26-27/108',
      financialYear: '2026-27',
      sequence: 108,
      issuedAt: new Date('2026-09-12T06:00:00Z'),
    })

  it('is dropped when nothing on the order was discounted', async () => {
    const invoice = invoiceWith(
      [{ id: 'l1', title: 'Linen shirt', quantity: 2, unitPrice: 1180, discount: 0 }],
      null,
      2360,
    )
    expect(showsDiscountColumn(invoice.lines)).toBe(false)
    // And the page still renders without it.
    expect((await renderInvoicePdf(invoice)).subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('appears when a line was discounted', () => {
    const invoice = invoiceWith(
      [{ id: 'l1', title: 'Linen shirt', quantity: 2, unitPrice: 1180, discount: 100 }],
      null,
      2260,
    )
    expect(showsDiscountColumn(invoice.lines)).toBe(true)
  })

  it('appears when only the freight was discounted', () => {
    const invoice = invoiceWith(
      [{ id: 'l1', title: 'Linen shirt', quantity: 2, unitPrice: 1180, discount: 0 }],
      { amount: 118, discount: 118, title: 'Free shipping' },
      2360,
    )
    expect(showsDiscountColumn(invoice.lines)).toBe(true)
  })
})
