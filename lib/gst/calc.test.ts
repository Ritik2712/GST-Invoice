import { describe, expect, it } from 'vitest'

import { calculate, determineTaxKind } from './calc'
import { formatInr, round2 } from './money'
import type { CalculationInput, RateTable } from './types'

const table: RateTable = {
  version: 1,
  fallback: { hsn: '9999', rate: 18 },
  rules: [
    { id: 'gst-5', priority: 10, match: [{ field: 'tag', operator: 'equals', value: 'gst:5' }], hsn: '5555', rate: 5 },
    { id: 'gst-12', priority: 10, match: [{ field: 'tag', operator: 'equals', value: 'gst:12' }], hsn: '1212', rate: 12 },
  ],
}

const base = (overrides: Partial<CalculationInput> = {}): CalculationInput => ({
  sellerStateCode: '27',
  placeOfSupplyStateCode: '27',
  pricesIncludeGst: true,
  rateTable: table,
  lines: [{ id: '1', title: 'Widget', quantity: 1, unitPrice: 1180, discount: 0 }],
  ...overrides,
})

describe('tax split', () => {
  it('is CGST + SGST within the seller state', () => {
    expect(determineTaxKind('27', '27')).toBe('INTRA_STATE')
    const { lines, totals } = calculate(base())
    expect(lines[0]).toMatchObject({ taxableValue: 1000, cgst: 90, sgst: 90, igst: 0 })
    expect(totals.grandTotal).toBe(1180)
  })

  it('is IGST across states', () => {
    expect(determineTaxKind('27', '29')).toBe('INTER_STATE')
    const { lines } = calculate(base({ placeOfSupplyStateCode: '29' }))
    expect(lines[0]).toMatchObject({ taxableValue: 1000, cgst: 0, sgst: 0, igst: 180 })
  })

  it('splits odd paise so CGST + SGST equals the total tax exactly', () => {
    const { lines } = calculate(
      base({ lines: [{ id: '1', title: 'Odd', quantity: 1, unitPrice: 100.03, discount: 0 }] }),
    )
    expect(round2(lines[0].cgst + lines[0].sgst)).toBe(round2((lines[0].taxableValue * 18) / 100))
  })
})

describe('inclusive vs exclusive pricing', () => {
  it('back-calculates the taxable value when prices include GST', () => {
    const { lines } = calculate(base({ pricesIncludeGst: true }))
    expect(lines[0].taxableValue).toBe(1000)
    expect(lines[0].total).toBe(1180)
  })

  it('adds tax on top when prices exclude GST', () => {
    const { lines, totals } = calculate(base({ pricesIncludeGst: false }))
    expect(lines[0].taxableValue).toBe(1180)
    expect(totals.grandTotal).toBe(1392) // 1180 + 212.40, rounded
  })
})

describe('discounts, shipping and totals', () => {
  it('taxes the discounted value', () => {
    const { lines } = calculate(
      base({
        pricesIncludeGst: false,
        lines: [{ id: '1', title: 'Widget', quantity: 2, unitPrice: 500, discount: 200 }],
      }),
    )
    expect(lines[0].taxableValue).toBe(800)
    expect(lines[0].discount).toBe(200)
  })

  it('COMPOSITE_LINE taxes shipping at the predominant goods rate', () => {
    const result = calculate(
      base({
        pricesIncludeGst: false,
        shippingTreatment: 'COMPOSITE_LINE',
        lines: [
          { id: '1', title: 'Low', quantity: 1, unitPrice: 100, discount: 0, tags: ['gst:5'] },
          { id: '2', title: 'High', quantity: 1, unitPrice: 100, discount: 0, tags: ['gst:12'] },
          { id: 'shipping', title: 'Shipping', quantity: 1, unitPrice: 50, discount: 0, kind: 'SHIPPING' },
        ],
      }),
    )
    const shipping = result.lines.find((l) => l.kind === 'SHIPPING')!
    expect(shipping.rate).toBe(12)
  })

  it('can resolve shipping through the table instead', () => {
    const result = calculate(
      base({
        pricesIncludeGst: false,
        shippingTreatment: 'SEPARATE_SERVICE',
        lines: [
          { id: '1', title: 'Low', quantity: 1, unitPrice: 100, discount: 0, tags: ['gst:5'] },
          { id: 'shipping', title: 'Shipping', quantity: 1, unitPrice: 50, discount: 0, kind: 'SHIPPING' },
        ],
      }),
    )
    // No SHIPPING rule in this table, so the fallback applies.
    expect(result.lines.find((l) => l.kind === 'SHIPPING')!.rate).toBe(18)
  })

  it('rounds the grand total to the nearest rupee and records the round off', () => {
    const { totals } = calculate(
      base({
        pricesIncludeGst: false,
        lines: [{ id: '1', title: 'Widget', quantity: 1, unitPrice: 999.55, discount: 0 }],
      }),
    )
    expect(totals.grandTotal).toBe(Math.round(totals.subTotal))
    expect(round2(totals.subTotal + totals.roundOff)).toBe(totals.grandTotal)
    expect(Math.abs(totals.roundOff)).toBeLessThanOrEqual(0.5)
  })

  it('groups the HSN summary by HSN and rate', () => {
    const { hsnSummary } = calculate(
      base({
        pricesIncludeGst: false,
        lines: [
          { id: '1', title: 'A', quantity: 1, unitPrice: 100, discount: 0, tags: ['gst:5'] },
          { id: '2', title: 'B', quantity: 1, unitPrice: 200, discount: 0, tags: ['gst:5'] },
          { id: '3', title: 'C', quantity: 1, unitPrice: 300, discount: 0, tags: ['gst:12'] },
        ],
      }),
    )
    expect(hsnSummary).toHaveLength(2)
    expect(hsnSummary.find((r) => r.hsn === '5555')!.taxableValue).toBe(300)
    expect(hsnSummary.find((r) => r.hsn === '1212')!.taxableValue).toBe(300)
  })

  it('handles a zero-rated line', () => {
    const zeroTable: RateTable = { ...table, fallback: { hsn: '0000', rate: 0 } }
    const { lines, totals } = calculate(base({ rateTable: zeroTable }))
    expect(lines[0].taxableValue).toBe(1180)
    expect(totals.taxTotal).toBe(0)
  })
})

describe('money formatting', () => {
  it('groups digits the Indian way', () => {
    expect(formatInr(1234567.5)).toBe('12,34,567.50')
    expect(formatInr(999)).toBe('999.00')
    expect(formatInr(-1500)).toBe('-1,500.00')
  })

  it('rounds half up without float drift', () => {
    expect(round2(0.145)).toBe(0.15)
    expect(round2(2.675)).toBe(2.68)
  })
})

describe('delivery charges', () => {
  const freightTable: RateTable = {
    ...table,
    rules: [
      ...table.rules,
      { id: 'shipping-default', priority: 90, appliesTo: 'SHIPPING', match: [{ field: 'any', operator: 'regex', value: '.*' }], hsn: '996511', rate: 18 },
    ],
  }
  const withDelivery = (overrides: Partial<CalculationInput> = {}) =>
    calculate(
      base({
        rateTable: freightTable,
        lines: [
          { id: '1', title: 'Tee', quantity: 1, unitPrice: 500, discount: 0, tags: ['gst:5'] },
          { id: 'shipping', title: 'Delivery charges', quantity: 1, unitPrice: 80, discount: 0, kind: 'SHIPPING', hsnOverride: '996812' },
        ],
        ...overrides,
      }),
    )

  it('defaults to a separate 18% delivery service under its SAC', () => {
    const shipping = withDelivery().lines.find((l) => l.kind === 'SHIPPING')!
    expect(shipping).toMatchObject({ rate: 18, hsn: '996812', rateSource: 'shipping-default' })
    // Rs.80 inclusive of 18%: 67.80 taxable + 6.10 CGST + 6.10 SGST.
    expect(shipping).toMatchObject({ taxableValue: 67.8, cgst: 6.1, sgst: 6.1, igst: 0, total: 80 })
  })

  it('prints no code on delivery when no SAC is set - not the rule code, not the goods default', () => {
    // freightTable's delivery rule carries 996511 and the table fallback carries 9999;
    // neither may leak onto a delivery line the user left without a code.
    const { lines, hsnSummary } = calculate(
      base({
        rateTable: freightTable,
        lines: [
          { id: '1', title: 'Tee', quantity: 1, unitPrice: 500, discount: 0, tags: ['gst:5'] },
          { id: 'shipping', title: 'Delivery charges', quantity: 1, unitPrice: 80, discount: 0, kind: 'SHIPPING' },
        ],
      }),
    )
    const shipping = lines.find((l) => l.kind === 'SHIPPING')!
    expect(shipping).toMatchObject({ hsn: '', rate: 18, taxableValue: 67.8 })
    expect(hsnSummary.find((r) => r.hsn === '')).toMatchObject({ label: 'Delivery charges', rate: 18 })
  })

  it('does not pull the goods line up to 18%', () => {
    const goods = withDelivery().lines.find((l) => l.kind === 'GOODS')!
    expect(goods.rate).toBe(5)
  })

  it('charges the full 18% as IGST across states', () => {
    const shipping = withDelivery({ placeOfSupplyStateCode: '29' }).lines.find((l) => l.kind === 'SHIPPING')!
    expect(shipping).toMatchObject({ rate: 18, igst: 12.2, cgst: 0, sgst: 0 })
  })

  it('gives delivery its own SAC row in the HSN summary', () => {
    const { hsnSummary } = withDelivery()
    expect(hsnSummary.map((r) => [r.hsn, r.rate])).toEqual([
      ['5555', 5],
      ['996812', 18],
    ])
  })

  const mixed = (treatment: CalculationInput['shippingTreatment']): CalculationInput =>
    base({
      pricesIncludeGst: false,
      shippingTreatment: treatment,
      lines: [
        { id: '1', title: 'Tee', quantity: 1, unitPrice: 300, discount: 0, tags: ['gst:5'] },
        { id: '2', title: 'Jacket', quantity: 1, unitPrice: 700, discount: 0, tags: ['gst:12'] },
        { id: 'shipping', title: 'Standard', quantity: 1, unitPrice: 100, discount: 0, kind: 'SHIPPING' },
      ],
    })

  it('COMPOSITE_LINE taxes delivery at the goods rate, under the goods HSN', () => {
    const { lines } = calculate(mixed('COMPOSITE_LINE'))
    const shipping = lines.find((l) => l.kind === 'SHIPPING')!

    expect(shipping.rate).toBe(12) // the principal supply, not the 18% courier rate
    expect(shipping.hsn).toBe('1212') // the principal supply's HSN, not SAC 996511
    expect(shipping.rateSource).toBe('principal-supply:gst-12')
  })

  it('picks the predominant line by value, not by position, when rates tie', () => {
    // A T-shirt (6109) and a shirt (6205) are both 5%: there is no "highest rate", so
    // without a value rule the delivery HSN would depend on Shopify's line order.
    const basket = (order: 'tshirt-first' | 'shirt-first') => {
      const tshirt = { id: 't', title: 'Tee', quantity: 1, unitPrice: 400, discount: 0, tags: ['gst:5'] }
      const shirt = { id: 's', title: 'Shirt', quantity: 1, unitPrice: 900, discount: 0, tags: ['gst:5-shirt'] }
      const shipping = { id: 'shipping', title: 'Standard', quantity: 1, unitPrice: 100, discount: 0, kind: 'SHIPPING' as const }
      return calculate(
        base({
          pricesIncludeGst: false,
          shippingTreatment: 'COMPOSITE_LINE',
          rateTable: {
            ...table,
            rules: [
              ...table.rules,
              { id: 'gst-5-shirt', priority: 10, match: [{ field: 'tag' as const, operator: 'equals' as const, value: 'gst:5-shirt' }], hsn: '6205', rate: 5 },
            ],
          },
          lines: order === 'tshirt-first' ? [tshirt, shirt, shipping] : [shirt, tshirt, shipping],
        }),
      )
    }

    // The Rs.900 shirt is the predominant supply either way.
    for (const order of ['tshirt-first', 'shirt-first'] as const) {
      const shipping = basket(order).lines.find((l) => l.kind === 'SHIPPING')!
      expect(shipping.hsn).toBe('6205')
      expect(shipping.rateSource).toBe('principal-supply:gst-5-shirt')
    }
  })

  it('names the rule that drove delivery, so the choice stays auditable', () => {
    const shipping = calculate(mixed('COMPOSITE_LINE')).lines.find((l) => l.kind === 'SHIPPING')!
    expect(shipping.rateSource).toMatch(/^principal-supply:/)
  })

  it('lets a bigger low-rate line beat a small high-rate one', () => {
    // Predominance is about value (s.2(90)), so a Rs.2,000 garment at 5% outweighs a
    // Rs.100 accessory at 18% - delivery follows the garment.
    const { lines } = calculate(
      base({
        pricesIncludeGst: false,
        shippingTreatment: 'COMPOSITE_LINE',
        lines: [
          { id: '1', title: 'Garment', quantity: 1, unitPrice: 2000, discount: 0, tags: ['gst:5'] },
          { id: '2', title: 'Trinket', quantity: 1, unitPrice: 100, discount: 0, tags: ['gst:18'] },
          { id: 'shipping', title: 'Standard', quantity: 1, unitPrice: 100, discount: 0, kind: 'SHIPPING' },
        ],
      }),
    )
    const shipping = lines.find((l) => l.kind === 'SHIPPING')!
    expect(shipping.rate).toBe(5)
    expect(shipping.hsn).toBe('5555')
  })

  it('APPORTION is unaffected by mixed rates - each part keeps its own', () => {
    const { lines, totals } = calculate(
      base({
        pricesIncludeGst: false,
        shippingTreatment: 'APPORTION',
        lines: [
          { id: '1', title: 'Garment', quantity: 1, unitPrice: 900, discount: 0, tags: ['gst:5'] },
          { id: '2', title: 'Accessory', quantity: 1, unitPrice: 100, discount: 0, tags: ['gst:18'] },
          { id: 'shipping', title: 'Standard', quantity: 1, unitPrice: 100, discount: 0, kind: 'SHIPPING' },
        ],
      }),
    )
    // Freight splits 900:100 -> 90 and 10, each taxed at its own line's rate.
    expect(lines.map((l) => [l.taxableValue, l.rate])).toEqual([
      [990, 5],
      [110, 18],
    ])
    expect(totals.taxableValue).toBe(1100)
  })

  it('SEPARATE_SERVICE keeps delivery as its own supply', () => {
    const { lines } = calculate(mixed('SEPARATE_SERVICE'))
    const shipping = lines.find((l) => l.kind === 'SHIPPING')!
    expect(shipping.rate).toBe(18) // no SHIPPING rule in this table, so the fallback
    expect(shipping.rateSource).toBe('fallback')
  })

  it('APPORTION folds delivery into the goods lines and drops the shipping line', () => {
    const { lines, totals } = calculate(mixed('APPORTION'))

    expect(lines).toHaveLength(2)
    expect(lines.some((l) => l.kind === 'SHIPPING')).toBe(false)
    // 100 split 300:700 -> 30 and 70, each taxed at its own line's rate.
    expect(lines[0].taxableValue).toBe(330)
    expect(lines[1].taxableValue).toBe(770)
    expect(totals.taxableValue).toBe(1100)
    expect(totals.cgst).toBe(round2((330 * 5) / 200 + (770 * 12) / 200))
  })

  it('APPORTION never loses or invents a paisa', () => {
    const { totals } = calculate(
      base({
        pricesIncludeGst: false,
        shippingTreatment: 'APPORTION',
        lines: [
          { id: '1', title: 'A', quantity: 1, unitPrice: 33.33, discount: 0 },
          { id: '2', title: 'B', quantity: 1, unitPrice: 33.33, discount: 0 },
          { id: '3', title: 'C', quantity: 1, unitPrice: 33.34, discount: 0 },
          { id: 'shipping', title: 'Standard', quantity: 1, unitPrice: 10, discount: 0, kind: 'SHIPPING' },
        ],
      }),
    )
    expect(totals.taxableValue).toBe(110)
  })

  it('APPORTION resolves the slab on the pre-freight value', () => {
    // A Rs.990 garment plus Rs.50 freight must stay in the 5% slab: the slab is tested on
    // the garment's own sale value, not on the value after freight is folded in.
    const slabTable: RateTable = {
      ...table,
      rules: [
        {
          id: 'apparel',
          priority: 10,
          match: [{ field: 'productType', operator: 'contains', value: 'apparel' }],
          hsn: '6109',
          slabs: [{ maxUnitTaxableValue: 1000, rate: 5 }, { rate: 12 }],
        },
      ],
    }
    const { lines } = calculate(
      base({
        pricesIncludeGst: false,
        shippingTreatment: 'APPORTION',
        rateTable: slabTable,
        lines: [
          { id: '1', title: 'Shirt', productType: 'Apparel', quantity: 1, unitPrice: 990, discount: 0 },
          { id: 'shipping', title: 'Standard', quantity: 1, unitPrice: 50, discount: 0, kind: 'SHIPPING' },
        ],
      }),
    )
    expect(lines[0].rate).toBe(5)
    expect(lines[0].taxableValue).toBe(1040)
  })

  it('handles a shipping-only order without dividing by zero', () => {
    const { lines } = calculate(
      base({
        pricesIncludeGst: false,
        shippingTreatment: 'APPORTION',
        lines: [{ id: 'shipping', title: 'Standard', quantity: 1, unitPrice: 100, discount: 0, kind: 'SHIPPING' }],
      }),
    )
    // Nothing to apportion into, so the line survives as a supply in its own right.
    expect(lines).toHaveLength(1)
    expect(lines[0].taxableValue).toBe(100)
  })
})
