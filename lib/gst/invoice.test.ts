import { describe, expect, it } from 'vitest'

import { buildInvoice, checkInvoiceability, prefixFor, seriesFor } from './invoice'
import { resolvePlaceOfSupply } from './placeOfSupply'
import { DEFAULT_SETTINGS, validateSettings, type AppSettings } from './settings'
import { stateFromShopifyAddress } from './states'
import type { NormalizedOrder, RateTable } from './types'
import { amountInWords } from './words'

const rateTable: RateTable = {
  version: 7,
  fallback: { hsn: '9999', rate: 18 },
  rules: [],
}

const settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  legalBusinessName: 'Aurum Design LLP',
  gstin: '27ABCDE1234F1Z5',
  sellerStateCode: '27',
  sellerStateName: 'Maharashtra',
  registeredAddress: '12 Turner Road\nBandra West\nMumbai 400050',
  invoicePrefix: 'AD/',
  defaultHsn: '9999',
  pricesIncludeGst: true,
}

const order = (overrides: Partial<NormalizedOrder> = {}): NormalizedOrder => ({
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
  shippingAddress: { name: 'Rhea Kapoor', city: 'Pune', stateCode: 'MH', stateName: 'Maharashtra', country: 'IN' },
  billingAddress: null,
  customerDefaultAddress: null,
  lines: [{ id: 'l1', title: 'Linen shirt', quantity: 2, unitPrice: 1180, discount: 0 }],
  shipping: { amount: 118, discount: 0, title: 'Standard' },
  orderTotal: 2478,
  ...overrides,
})

describe('place of supply', () => {
  it('prefers the shipping address', () => {
    const resolved = resolvePlaceOfSupply(
      order({
        shippingAddress: { stateCode: 'KA', country: 'IN' },
        billingAddress: { stateCode: 'MH', country: 'IN' },
      }),
    )
    expect(resolved).toMatchObject({ stateCode: '29', source: 'shipping-address' })
  })

  it('falls back to billing, then the customer default address', () => {
    expect(
      resolvePlaceOfSupply(order({ shippingAddress: null, billingAddress: { stateCode: 'DL', country: 'IN' } })),
    ).toMatchObject({ stateCode: '07', source: 'billing-address' })

    expect(
      resolvePlaceOfSupply(
        order({
          shippingAddress: null,
          billingAddress: null,
          customerDefaultAddress: { stateCode: 'TN', country: 'IN' },
        }),
      ),
    ).toMatchObject({ stateCode: '33', source: 'customer-default-address' })
  })

  it('uses the buyer GSTIN as a last resort', () => {
    expect(
      resolvePlaceOfSupply(
        order({ shippingAddress: null, billingAddress: null, customerGstin: '29ABCDE1234F1Z5' }),
      ),
    ).toMatchObject({ stateCode: '29', source: 'buyer-gstin' })
  })

  it('returns null rather than guessing for a non-Indian address', () => {
    expect(
      resolvePlaceOfSupply(order({ shippingAddress: { stateCode: 'CA', country: 'US' }, billingAddress: null })),
    ).toBeNull()
  })

  it('resolves a state from its name when the province code is missing', () => {
    expect(stateFromShopifyAddress({ province: 'Tamil Nadu', countryCode: 'IN' })?.code).toBe('33')
  })
})

describe('invoiceability', () => {
  it('allows a paid order', () => {
    expect(checkInvoiceability(order(), true).invoiceable).toBe(true)
    expect(checkInvoiceability(order({ financialStatus: 'PARTIALLY_PAID' }), true).invoiceable).toBe(true)
  })

  it('allows a test order - it goes to the test series instead of being refused', () => {
    expect(checkInvoiceability(order({ isTest: true }), true).invoiceable).toBe(true)
  })

  it('refuses an order that is not paid', () => {
    const result = checkInvoiceability(order({ financialStatus: 'PENDING' }), true)
    expect(result).toMatchObject({ invoiceable: false, reason: 'NOT_PAID' })
  })

  it('refuses an order cancelled before invoicing, so no number is consumed', () => {
    const result = checkInvoiceability(order({ cancelledAt: '2026-09-02T00:00:00Z' }), true)
    expect(result).toMatchObject({ invoiceable: false, reason: 'CANCELLED_BEFORE_INVOICE' })
  })

  it('refuses when the place of supply cannot be resolved', () => {
    const result = checkInvoiceability(
      order({ shippingAddress: null, billingAddress: null, customerDefaultAddress: null }),
      true,
    )
    expect(result).toMatchObject({ invoiceable: false, reason: 'NO_PLACE_OF_SUPPLY' })
  })

  it('refuses when the seller settings are incomplete', () => {
    expect(checkInvoiceability(order(), false)).toMatchObject({
      invoiceable: false,
      reason: 'SETTINGS_INCOMPLETE',
    })
  })
})

describe('buildInvoice', () => {
  const invoice = buildInvoice({
    order: order(),
    settings,
    rateTable,
    series: 'REAL',
    invoiceNumber: 'AD/26-27/106',
    financialYear: '2026-27',
    sequence: 106,
    issuedAt: new Date('2026-09-12T06:00:00Z'),
  })

  it('captures the number, FY and date', () => {
    expect(invoice).toMatchObject({
      invoiceNumber: 'AD/26-27/106',
      financialYear: '2026-27',
      sequence: 106,
      invoiceDate: '12-09-2026',
      status: 'ISSUED',
    })
  })

  it('keeps the Shopify order number as a reference only', () => {
    expect(invoice.order.name).toBe('#1042')
    expect(invoice.invoiceNumber).not.toContain('1042')
  })

  it('taxes an in-state order as CGST + SGST and includes shipping', () => {
    expect(invoice.taxKind).toBe('INTRA_STATE')
    expect(invoice.lines).toHaveLength(2)
    expect(invoice.lines[1].kind).toBe('SHIPPING')
    expect(invoice.totals.igst).toBe(0)
    expect(invoice.totals.grandTotal).toBe(2478)
  })

  it('freezes the seller snapshot so later settings edits cannot change it', () => {
    expect(invoice.seller.legalName).toBe('Aurum Design LLP')
    expect(invoice.seller.gstin).toBe('27ABCDE1234F1Z5')
    expect(invoice.rateTableVersion).toBe(7)
  })

  it('records the amount in words', () => {
    expect(invoice.amountInWords).toBe('Rupees Two Thousand Four Hundred Seventy Eight Only')
  })

  it('honours a manual place-of-supply override', () => {
    const overridden = buildInvoice({
      order: order(),
      settings,
      rateTable,
      series: 'REAL',
      invoiceNumber: 'AD/26-27/107',
      financialYear: '2026-27',
      sequence: 107,
      issuedAt: new Date('2026-09-12T06:00:00Z'),
      placeOfSupplyOverride: '29',
    })
    expect(overridden.taxKind).toBe('INTER_STATE')
    expect(overridden.totals.cgst).toBe(0)
    expect(overridden.totals.igst).toBeGreaterThan(0)
  })
})

describe('the delivery line', () => {
  const build = (overrides: Partial<AppSettings>) =>
    buildInvoice({
      order: order({ shipping: { amount: 118, discount: 0, title: '.>(' } }),
      settings: { ...settings, ...overrides },
      rateTable,
      series: 'REAL',
      invoiceNumber: 'AD/26-27/1',
      financialYear: '2026-27',
      sequence: 1,
      issuedAt: new Date('2026-09-12T06:00:00Z'),
    })

  it('uses the configured label, not the Shopify shipping rate name', () => {
    // A rate named ".>(" is customer-facing copy and must not reach a tax invoice.
    const invoice = build({ deliveryLineLabel: 'Delivery charges' })
    expect(invoice.lines.find((l) => l.kind === 'SHIPPING')?.title).toBe('Delivery charges')
  })

  it('falls back to the Shopify rate name when the label is blank', () => {
    const invoice = build({ deliveryLineLabel: '   ' })
    expect(invoice.lines.find((l) => l.kind === 'SHIPPING')?.title).toBe('.>(')
  })

  it('disappears entirely under APPORTION, with the value kept', () => {
    const composite = build({ shippingTreatment: 'COMPOSITE_LINE' })
    const apportioned = build({ shippingTreatment: 'APPORTION' })

    expect(composite.lines).toHaveLength(2)
    expect(apportioned.lines).toHaveLength(1)
    expect(apportioned.lines.some((l) => l.kind === 'SHIPPING')).toBe(false)
    // Same money either way - only the presentation and the rate basis change.
    expect(apportioned.totals.grandTotal).toBe(composite.totals.grandTotal)
    expect(apportioned.totals.taxableValue).toBe(composite.totals.taxableValue)
  })
})

describe('invoice series', () => {
  it('sends a Shopify test order to the TEST series and a real one to REAL', () => {
    expect(seriesFor(order({ isTest: true }))).toBe('TEST')
    expect(seriesFor(order({ isTest: false }))).toBe('REAL')
  })

  it('prints each series with its own prefix', () => {
    expect(prefixFor('REAL', settings)).toBe('AD/')
    expect(prefixFor('TEST', { ...settings, testInvoicePrefix: 'TEST/' })).toBe('TEST/')
  })

  it('records the series on the snapshot', () => {
    const args = {
      order: order({ isTest: true }),
      settings,
      rateTable,
      financialYear: '2026-27',
      sequence: 1,
      issuedAt: new Date('2026-09-12T06:00:00Z'),
    }
    expect(buildInvoice({ ...args, series: 'TEST', invoiceNumber: 'TEST/26-27/1' }).series).toBe('TEST')
    expect(buildInvoice({ ...args, series: 'REAL', invoiceNumber: 'AD/26-27/1' }).series).toBe('REAL')
  })
})

describe('settings validation', () => {
  it('accepts a complete profile', () => {
    expect(validateSettings(settings)).toEqual({})
  })

  it('rejects a GSTIN whose state does not match the selected state', () => {
    const errors = validateSettings({ ...settings, sellerStateCode: '29' })
    expect(errors.sellerStateCode).toContain('different state')
  })

  it('treats the delivery SAC as optional, but rejects a malformed one', () => {
    expect(validateSettings({ ...settings, shippingHsn: '' }).shippingHsn).toBeUndefined()
    expect(validateSettings({ ...settings, shippingHsn: '996812' }).shippingHsn).toBeUndefined()
    expect(validateSettings({ ...settings, shippingHsn: 'abc' }).shippingHsn).toBeDefined()
  })

  it('builds a code-less 18% delivery line from default settings', () => {
    const invoice = buildInvoice({
      series: 'REAL',
      order: order(),
      settings: { ...settings, shippingHsn: '' },
      rateTable: { ...rateTable, rules: [{ id: 'shipping-default', priority: 90, appliesTo: 'SHIPPING', match: [{ field: 'any', operator: 'regex', value: '.*' }], hsn: '', rate: 18 }] },
      invoiceNumber: 'AD/26-27/1',
      financialYear: '2026-27',
      sequence: 1,
      issuedAt: new Date('2026-09-12T06:00:00Z'),
    })
    expect(invoice.lines.find((l) => l.kind === 'SHIPPING')).toMatchObject({ hsn: '', rate: 18 })
  })

  it('rejects a bad GSTIN, missing name and bad HSN', () => {
    const errors = validateSettings({ ...settings, gstin: 'nope', legalBusinessName: '', defaultHsn: '12' })
    expect(errors.gstin).toBeDefined()
    expect(errors.legalBusinessName).toBeDefined()
    expect(errors.defaultHsn).toBeDefined()
  })
})

describe('amount in words', () => {
  it('uses the Indian numbering system', () => {
    expect(amountInWords(12345678)).toBe(
      'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only',
    )
  })

  it('includes paise when present', () => {
    expect(amountInWords(1200.5)).toBe('Rupees One Thousand Two Hundred and Fifty Paise Only')
  })

  it('handles zero', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only')
  })
})
