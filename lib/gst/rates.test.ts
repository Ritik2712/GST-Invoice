import { describe, expect, it } from 'vitest'

import { explainRules, resolveRate, resolveSlabRate } from './rates'
import type { RateTable, TaxableLineInput } from './types'

const line = (overrides: Partial<TaxableLineInput> = {}): TaxableLineInput => ({
  id: '1',
  title: 'Shirt',
  quantity: 1,
  unitPrice: 500,
  discount: 0,
  ...overrides,
})

const table: RateTable = {
  version: 1,
  fallback: { hsn: '9999', rate: 18 },
  rules: [
    { id: 'tag-5', priority: 10, match: [{ field: 'tag', operator: 'equals', value: 'gst:5' }], hsn: '', rate: 5 },
    {
      id: 'apparel',
      priority: 50,
      match: [{ field: 'productType', operator: 'contains', value: 'apparel' }],
      hsn: '6109',
      slabs: [{ maxUnitTaxableValue: 1000, rate: 5 }, { rate: 12 }],
    },
    { id: 'vendor-acme', priority: 60, match: [{ field: 'vendor', operator: 'equals', value: 'Acme' }], hsn: '1111', rate: 28 },
  ],
}

describe('rate resolution', () => {
  it('falls back when nothing matches', () => {
    const resolved = resolveRate(line(), table, false)
    expect(resolved).toMatchObject({ hsn: '9999', rate: 18, source: 'fallback' })
  })

  it('matches by tag and takes the HSN from the fallback when the rule has none', () => {
    const resolved = resolveRate(line({ tags: ['gst:5'] }), table, false)
    expect(resolved).toMatchObject({ hsn: '9999', rate: 5, source: 'tag-5' })
  })

  it('honours priority over array order', () => {
    // The product is both apparel and an Acme product; apparel has the lower priority number.
    const resolved = resolveRate(line({ productType: 'Apparel', vendor: 'Acme' }), table, false)
    expect(resolved.source).toBe('apparel')
  })

  it('lets a line HSN override the rule HSN without changing the rate', () => {
    const resolved = resolveRate(line({ tags: ['gst:5'], hsnOverride: '61091000' }), table, false)
    expect(resolved).toMatchObject({ hsn: '61091000', rate: 5 })
  })

  it('is case-insensitive by default', () => {
    expect(resolveRate(line({ productType: 'MENS APPAREL' }), table, false).source).toBe('apparel')
  })

  it('ignores a malformed regex rule instead of throwing', () => {
    const broken: RateTable = {
      ...table,
      rules: [{ id: 'bad', priority: 1, match: [{ field: 'title', operator: 'regex', value: '([' }], hsn: '1', rate: 1 }],
    }
    expect(resolveRate(line(), broken, false).source).toBe('fallback')
  })
})

describe('price slabs', () => {
  const slabs = [{ maxUnitTaxableValue: 1000, rate: 5 }, { rate: 12 }]

  it('picks the low slab below the threshold (tax-exclusive)', () => {
    expect(resolveSlabRate(slabs, 900, false)).toBe(5)
  })

  it('picks the high slab above the threshold (tax-exclusive)', () => {
    expect(resolveSlabRate(slabs, 1500, false)).toBe(12)
  })

  it('strips tax before testing the threshold when prices are inclusive', () => {
    // 1030 inclusive of 5% is 980.95 taxable, which is under Rs.1,000.
    expect(resolveSlabRate(slabs, 1030, true)).toBe(5)
  })

  it('resolves the inconsistent band by the gross value', () => {
    // At 5% the net (1047.62) is over the threshold; at 12% the net (982.14) is under it.
    // Neither slab is self-consistent, so the gross value decides: 12%.
    expect(resolveSlabRate(slabs, 1100, true)).toBe(12)
  })

  it('accounts for the discount when choosing a slab', () => {
    const discounted = line({ productType: 'apparel', unitPrice: 1200, quantity: 1, discount: 300 })
    expect(resolveRate(discounted, table, false).rate).toBe(5)
  })
})

describe('explainRules', () => {
  const traced = (l: Partial<TaxableLineInput>) => explainRules(line(l), table, false)

  it('marks exactly one winner, and it is the one resolveRate picks', () => {
    const { evaluations, resolved } = traced({ productType: 'Apparel', vendor: 'Acme' })
    const winners = evaluations.filter((e) => e.winner)

    expect(winners).toHaveLength(1)
    expect(winners[0].id).toBe(resolved.source)
    expect(winners[0].id).toBe('apparel')
  })

  it('still reports lower-priority rules that would have matched', () => {
    // The near-miss is the point: it shows what the answer *was* before a rule was added.
    const { evaluations } = traced({ productType: 'Apparel', vendor: 'Acme' })
    const acme = evaluations.find((e) => e.id === 'vendor-acme')!
    expect(acme).toMatchObject({ matched: true, winner: false })
  })

  it('says which condition failed', () => {
    const { evaluations } = traced({})
    expect(evaluations.find((e) => e.id === 'apparel')?.failedOn).toBe(
      'productType contains "apparel"',
    )
  })

  it('reports rules that only apply to another line kind', () => {
    const shippingRule: RateTable = {
      ...table,
      rules: [
        { id: 'freight', priority: 5, appliesTo: 'SHIPPING', match: [{ field: 'any', operator: 'regex', value: '.*' }], hsn: '996511', rate: 18 },
      ],
    }
    const { evaluations } = explainRules(line(), shippingRule, false)
    expect(evaluations[0]).toMatchObject({ matched: false, failedOn: 'applies to SHIPPING lines only' })
  })

  it('evaluates rules in priority order', () => {
    const { evaluations } = traced({ tags: ['gst:5'] })
    const priorities = evaluations.map((e) => e.priority)
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities)
  })
})
