import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type AppSettings } from './gst/settings'
import type { RateTable } from './gst/types'
import { auditCatalogue, resolveProductRates } from './product-rates'
import type { ShopifyProduct } from './shopify/products'

/**
 * The point of the audit is to tell a *correct* HSN from a lucky one, so these tests pin
 * the precedence: product tag > product metafield > rate-table rule > default HSN setting.
 */

const settings: AppSettings = { ...DEFAULT_SETTINGS, defaultHsn: '9999', pricesIncludeGst: false }

const table: RateTable = {
  version: 1,
  fallback: { hsn: '', rate: 18 },
  rules: [
    {
      id: 'tshirt',
      priority: 20,
      match: [{ field: 'title', operator: 'regex', value: 't-?shirt' }],
      hsn: '61091000',
      slabs: [{ maxUnitTaxableValue: 1000, rate: 5 }, { rate: 12 }],
    },
    {
      id: 'shirt',
      priority: 30,
      match: [{ field: 'title', operator: 'regex', value: '\\bshirt\\b' }],
      hsn: '6205',
      rate: 5,
    },
    { id: 'rate-only', priority: 40, match: [{ field: 'vendor', operator: 'equals', value: 'RateOnly' }], hsn: '', rate: 12 },
  ],
}

const product = (overrides: Partial<ShopifyProduct> = {}): ShopifyProduct => ({
  id: 'gid://shopify/Product/1',
  title: 'Graphic T-Shirt',
  handle: 'graphic-t-shirt',
  productType: null,
  vendor: null,
  tags: [],
  status: 'ACTIVE',
  hsnMetafield: null,
  variants: [{ id: 'v1', title: 'M', sku: 'TS-M', price: 500 }],
  ...overrides,
})

const resolve = (p: ShopifyProduct) => resolveProductRates([p], table, settings)[0]

describe('HSN precedence', () => {
  it('a product tag wins over the rule', () => {
    const result = resolve(product({ tags: ['hsn:62053000'] }))
    expect(result.variants[0]).toMatchObject({ hsn: '62053000', hsnSource: 'product-tag' })
    expect(result.hsnFromProduct).toBe(true)
    // The rate still comes from the table, not from the product.
    expect(result.variants[0].rate).toBe(5)
  })

  it('the metafield is used when there is no tag', () => {
    const result = resolve(product({ hsnMetafield: '61051000' }))
    expect(result.variants[0]).toMatchObject({ hsn: '61051000', hsnSource: 'product-metafield' })
  })

  it('the rule supplies the HSN when the product carries none', () => {
    const result = resolve(product())
    expect(result.variants[0]).toMatchObject({
      hsn: '61091000',
      hsnSource: 'rate-table-rule',
      rateSource: 'tshirt',
    })
    expect(result.hsnFromProduct).toBe(false)
  })

  it('a "shirt" title does not pick up the t-shirt HSN', () => {
    // Priority ordering matters: "T-Shirt" contains "shirt", so the t-shirt rule has to be
    // consulted first or every tee would be classified as a woven shirt.
    expect(resolve(product({ title: 'Black Check Shirt For Men' })).variants[0]).toMatchObject({
      hsn: '6205',
      rateSource: 'shirt',
    })
    expect(resolve(product({ title: 'Crop T-Shirt for Women' })).variants[0].hsn).toBe('61091000')
  })

  it('falls back to the default HSN setting for a rate-only rule', () => {
    const result = resolve(product({ title: 'Mystery item', vendor: 'RateOnly' }))
    expect(result.variants[0]).toMatchObject({ hsn: '9999', rate: 12, hsnSource: 'default-setting' })
  })

  it('falls back to the default HSN setting when nothing matches', () => {
    const result = resolve(product({ title: 'Mystery item' }))
    expect(result.variants[0]).toMatchObject({ hsn: '9999', rate: 18, hsnSource: 'default-setting' })
  })
})

describe('slabs across variants', () => {
  it('flags a product whose variants straddle a slab boundary', () => {
    const result = resolve(
      product({
        variants: [
          { id: 'v1', title: 'M', sku: 'A', price: 900 },
          { id: 'v2', title: 'XL', sku: 'B', price: 1400 },
        ],
      }),
    )
    expect(result.variants.map((v) => v.rate)).toEqual([5, 12])
    expect(result.mixedRates).toBe(true)
  })

  it('does not flag a product priced entirely inside one slab', () => {
    expect(resolve(product()).mixedRates).toBe(false)
  })
})

describe('catalogue audit', () => {
  it('counts every HSN source, including variant HS codes', () => {
    const rates = resolveProductRates(
      [
        product({ id: 'p1', title: 'Graphic T-Shirt', variants: [{ id: 'v1', title: 'M', sku: 'A', price: 500, harmonizedSystemCode: '61091000' }] }),
        product({ id: 'p2', title: 'Check Shirt For Men' }),
      ],
      table,
      settings,
    )
    const audit = auditCatalogue(rates)

    // Every counter is a real number - a missing key used to surface as null (NaN).
    for (const count of Object.values(audit.hsnSources)) expect(Number.isFinite(count)).toBe(true)
    expect(audit.hsnSources['variant-hs-code']).toBe(1)
    expect(audit.hsnSources['rate-table-rule']).toBe(1)
  })

  it('counts sources and groups the HSN/rate combinations', () => {
    const rates = resolveProductRates(
      [
        product({ id: 'p1', title: 'Graphic T-Shirt' }),
        product({ id: 'p2', title: 'Crop T-Shirt' }),
        product({ id: 'p3', title: 'Check Shirt For Men' }),
        product({ id: 'p4', title: 'Tagged tee', tags: ['hsn:61099090'] }),
      ],
      table,
      settings,
    )
    const audit = auditCatalogue(rates)

    expect(audit.products).toBe(4)
    expect(audit.variants).toBe(4)
    expect(audit.hsnSources['rate-table-rule']).toBe(3)
    expect(audit.hsnSources['product-tag']).toBe(1)
    expect(audit.combinations[0]).toMatchObject({ hsn: '61091000', products: 2 })
    // Only products with no HSN of their own are reported as riding on a rule.
    expect(audit.ridingOnRules.reduce((n, r) => n + r.products, 0)).toBe(3)
  })
})
