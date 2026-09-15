import { describe, expect, it } from 'vitest'

import { ordersNotices, type OrderRow } from './order-rows'

const row = (overrides: Partial<OrderRow>): OrderRow =>
  ({
    id: 'gid://shopify/Order/1',
    legacyId: '1',
    name: '#1001',
    createdAt: '2026-09-01T10:00:00Z',
    displayDate: '01-09-2026',
    customerName: 'Rhea',
    placeOfSupply: { code: '07', name: 'Delhi' },
    total: 500,
    currency: 'INR',
    financialStatus: 'PAID',
    isTest: false,
    cancelledAt: null,
    invoiceNumber: null,
    invoiceKey: null,
    cancelledInvoices: [],
    invoiceStatus: 'NOT_INVOICED',
    canDownload: true,
    blockedReason: null,
    ...overrides,
  }) as OrderRow

describe('60-day notice', () => {
  it('shows when read_all_orders is known to be missing', () => {
    expect(ordersNotices([], ['read_orders', 'read_products']).limitedTo60Days).toBe(true)
  })

  it('hides when read_all_orders is granted', () => {
    expect(ordersNotices([], ['read_all_orders', 'read_orders']).limitedTo60Days).toBe(false)
  })

  it('is unknown - not false - when scopes cannot be read', () => {
    // A static token reports no scopes; staying cautious beats hiding a real limit.
    expect(ordersNotices([], null).limitedTo60Days).toBeNull()
  })
})

describe('no-address notice', () => {
  it('stays empty when every order has an address', () => {
    expect(ordersNotices([row({ name: '#1001' }), row({ name: '#1002' })], null).ordersWithoutAddress).toEqual([])
  })

  it('lists orders that still need an invoice but have no address', () => {
    const rows = [
      row({ name: '#1001' }),
      row({ name: '#1002', placeOfSupply: null }),
      row({ name: '#1003', placeOfSupply: null }),
    ]
    expect(ordersNotices(rows, null).ordersWithoutAddress).toEqual(['#1002', '#1003'])
  })

  it('ignores orders already invoiced or cancelled - nothing left to fix there', () => {
    const rows = [
      row({ name: '#1001', placeOfSupply: null, invoiceKey: 'INV_26-27_1', invoiceNumber: 'INV/26-27/1' }),
      row({ name: '#1002', placeOfSupply: null, cancelledAt: '2026-09-02T00:00:00Z' }),
    ]
    expect(ordersNotices(rows, null).ordersWithoutAddress).toEqual([])
  })
})
