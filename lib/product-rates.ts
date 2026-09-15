import { explainRules, resolveRate, type RuleEvaluation } from './gst/rates'
import type { AppSettings } from './gst/settings'
import type { RateRule, RateTable, TaxableLineInput } from './gst/types'
import type { ShopifyProduct, ShopifyProductDetail } from './shopify/products'

/**
 * Answers the question "what HSN and rate will this product actually get, and where does
 * that come from?" for every variant in the catalogue.
 *
 * Worth having because the resolution is layered: a product's own HSN beats a rate-table
 * rule, which beats the default HSN setting. Without a trace you cannot tell a correct
 * HSN from a lucky one - the default happening to match what the product should have.
 */

/**
 * Precedence, most specific first. A variant's own HS code beats a product-wide tag
 * because it is per-variant and is the field Shopify itself maintains; the trace always
 * names which one won, so nothing is decided invisibly.
 */
export type HsnSource =
  | 'variant-hs-code'
  | 'product-tag'
  | 'product-metafield'
  | 'rate-table-rule'
  | 'default-setting'

export interface VariantRate {
  variantId: string
  variantTitle: string
  sku: string | null
  price: number
  hsn: string
  rate: number
  /** Which rule decided the rate: a rule id, or `fallback`. */
  rateSource: string
  hsnSource: HsnSource
}

export interface ProductRate {
  id: string
  title: string
  handle: string
  productType: string | null
  vendor: string | null
  tags: string[]
  status: string
  variants: VariantRate[]
  /**
   * True when nothing about this product pins its HSN - it is riding on a rate-table rule
   * or the default setting. Fine for a single-category store, wrong as soon as the
   * catalogue mixes garment types (T-shirts 6109 vs woven shirts 6205).
   */
  hsnFromProduct: boolean
  /** Variants whose rate differs from the first one, i.e. a price slab boundary is crossed. */
  mixedRates: boolean
}

/** `hsn:61091000` product tag, matching what the order normaliser reads. */
function hsnTag(tags: string[]): string | null {
  const tag = tags.find((t) => /^hsn[:=]/i.test(t.trim()))
  const digits = tag?.split(/[:=]/)[1]?.trim()
  return digits && /^\d{4,8}$/.test(digits) ? digits : null
}

function ruleById(table: RateTable, id: string): RateRule | undefined {
  return table.rules.find((r) => r.id === id)
}

export function resolveProductRates(
  products: ShopifyProduct[],
  table: RateTable,
  settings: AppSettings,
): ProductRate[] {
  // The default HSN setting is the table's fallback HSN, exactly as when invoicing.
  const effective: RateTable = {
    ...table,
    fallback: { hsn: settings.defaultHsn || table.fallback.hsn, rate: table.fallback.rate },
  }

  return products.map((product) => {
    const tagHsn = hsnTag(product.tags)
    const productOverride = tagHsn ?? product.hsnMetafield

    const variants = product.variants.map<VariantRate>((variant) => {
      const override = variant.harmonizedSystemCode ?? productOverride
      const line: TaxableLineInput = {
        id: variant.id,
        title: product.title,
        variantTitle: variant.title,
        sku: variant.sku,
        productType: product.productType,
        vendor: product.vendor,
        tags: product.tags,
        hsnOverride: override,
        quantity: 1,
        unitPrice: variant.price,
        discount: 0,
      }
      const resolved = resolveRate(line, effective, settings.pricesIncludeGst)

      let hsnSource: HsnSource
      if (variant.harmonizedSystemCode) hsnSource = 'variant-hs-code'
      else if (tagHsn) hsnSource = 'product-tag'
      else if (product.hsnMetafield) hsnSource = 'product-metafield'
      else if (resolved.source !== 'fallback' && ruleById(effective, resolved.source)?.hsn) {
        hsnSource = 'rate-table-rule'
      } else hsnSource = 'default-setting'

      return {
        variantId: variant.id,
        variantTitle: variant.title,
        sku: variant.sku,
        price: variant.price,
        hsn: resolved.hsn,
        rate: resolved.rate,
        rateSource: resolved.source,
        hsnSource,
      }
    })

    return {
      id: product.id,
      title: product.title,
      handle: product.handle,
      productType: product.productType,
      vendor: product.vendor,
      tags: product.tags,
      status: product.status,
      variants,
      hsnFromProduct: variants.every(
        (v) => v.hsnSource !== 'rate-table-rule' && v.hsnSource !== 'default-setting',
      ),
      mixedRates: new Set(variants.map((v) => v.rate)).size > 1,
    }
  })
}

export interface CatalogueAudit {
  products: number
  variants: number
  /** How many products get their HSN from each source. */
  hsnSources: Record<HsnSource, number>
  /** HSN + rate combinations actually in use, most common first. */
  combinations: Array<{ hsn: string; rate: number; products: number }>
  /** Products with no product-level HSN, grouped by the rule carrying them. */
  ridingOnRules: Array<{ rateSource: string; hsn: string; products: number }>
}

export function auditCatalogue(rates: ProductRate[]): CatalogueAudit {
  // Typed without a cast, so adding an HsnSource without a counter here is a compile error.
  // A cast used to hide a missing 'variant-hs-code' key, and its count came out as null.
  const hsnSources: Record<HsnSource, number> = {
    'variant-hs-code': 0,
    'product-tag': 0,
    'product-metafield': 0,
    'rate-table-rule': 0,
    'default-setting': 0,
  }
  const combos = new Map<string, { hsn: string; rate: number; products: number }>()
  const rules = new Map<string, { rateSource: string; hsn: string; products: number }>()
  let variants = 0

  for (const product of rates) {
    variants += product.variants.length
    const first = product.variants[0]
    if (!first) continue

    hsnSources[first.hsnSource] += 1

    const key = `${first.hsn}|${first.rate}`
    const combo = combos.get(key) ?? { hsn: first.hsn, rate: first.rate, products: 0 }
    combo.products += 1
    combos.set(key, combo)

    if (!product.hsnFromProduct) {
      const rk = `${first.rateSource}|${first.hsn}`
      const entry = rules.get(rk) ?? { rateSource: first.rateSource, hsn: first.hsn, products: 0 }
      entry.products += 1
      rules.set(rk, entry)
    }
  }

  return {
    products: rates.length,
    variants,
    hsnSources,
    combinations: [...combos.values()].sort((a, b) => b.products - a.products),
    ridingOnRules: [...rules.values()].sort((a, b) => b.products - a.products),
  }
}

export interface VariantRateDetail extends VariantRate {
  compareAtPrice?: number | null
  barcode?: string | null
  inventoryQuantity?: number | null
  options?: Array<{ name: string; value: string }>
  /** Every rule that was considered, in the order the resolver considers them. */
  trace: RuleEvaluation[]
}

export interface ProductRateDetail extends Omit<ProductRate, 'variants'> {
  legacyId: string
  description: string
  totalInventory: number | null
  createdAt: string
  updatedAt: string
  onlineStoreUrl: string | null
  featuredImage: { url: string; altText: string | null } | null
  hsnMetafield: string | null
  variants: VariantRateDetail[]
  /** Plain-language summary of why this product gets the HSN it gets. */
  hsnExplanation: string
}

/**
 * One product with the full resolution trace per variant. The trace is the difference
 * between "this says 6109" and "this says 6109 *because* the title matched the t-shirt
 * rule, and here is what else was tried" - which is what you need before issuing an
 * invoice you cannot edit.
 */
export function resolveProductDetail(
  product: ShopifyProductDetail,
  table: RateTable,
  settings: AppSettings,
): ProductRateDetail {
  const effective: RateTable = {
    ...table,
    fallback: { hsn: settings.defaultHsn || table.fallback.hsn, rate: table.fallback.rate },
  }
  const summary = resolveProductRates([product as ShopifyProduct], effective, {
    ...settings,
    // resolveProductRates applies the default HSN itself; do not apply it twice.
    defaultHsn: settings.defaultHsn,
  })[0]

  const tagHsn = hsnTag(product.tags)
  const productOverride = tagHsn ?? product.hsnMetafield

  const variants = product.variants.map<VariantRateDetail>((variant, index) => {
    const base = summary.variants[index]
    const override = variant.harmonizedSystemCode ?? productOverride
    const { evaluations } = explainRules(
      {
        id: variant.id,
        title: product.title,
        variantTitle: variant.title,
        sku: variant.sku,
        productType: product.productType,
        vendor: product.vendor,
        tags: product.tags,
        hsnOverride: override,
        quantity: 1,
        unitPrice: variant.price,
        discount: 0,
      },
      effective,
      settings.pricesIncludeGst,
    )
    return {
      ...base,
      compareAtPrice: variant.compareAtPrice ?? null,
      barcode: variant.barcode ?? null,
      inventoryQuantity: variant.inventoryQuantity ?? null,
      options: variant.options ?? [],
      trace: evaluations,
    }
  })

  return {
    ...summary,
    legacyId: product.legacyId,
    description: product.description,
    totalInventory: product.totalInventory,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    onlineStoreUrl: product.onlineStoreUrl,
    featuredImage: product.featuredImage,
    hsnMetafield: product.hsnMetafield,
    variants,
    hsnExplanation: explainHsn(variants[0], tagHsn, product.hsnMetafield, settings),
  }
}

function explainHsn(
  variant: VariantRateDetail | undefined,
  tagHsn: string | null,
  metafield: string | null,
  settings: AppSettings,
): string {
  if (!variant) return 'This product has no variants, so nothing was resolved.'
  const winner = variant.trace.find((e) => e.winner)
  const rateFrom = winner ? `rule "${winner.id}"` : 'the table fallback'

  if (variant.hsnSource === 'variant-hs-code') {
    return `HSN ${variant.hsn} comes from the variant's own Harmonized System code in Shopify, which overrides everything else. The ${variant.rate}% rate still comes from ${rateFrom}.`
  }
  if (tagHsn) {
    return `HSN ${variant.hsn} comes from the product tag "hsn:${tagHsn}", which overrides the rate table. The ${variant.rate}% rate still comes from ${winner ? `rule "${winner.id}"` : 'the table fallback'}.`
  }
  if (metafield) {
    return `HSN ${variant.hsn} comes from the product's custom.hsn metafield. The ${variant.rate}% rate still comes from ${winner ? `rule "${winner.id}"` : 'the table fallback'}.`
  }
  if (winner?.hsn) {
    return `HSN ${variant.hsn} and the ${variant.rate}% rate both come from rule "${winner.id}". Nothing on the product pins its HSN, so renaming or retyping the product could change it - tag the product "hsn:${variant.hsn}" to fix it in place.`
  }
  return `No rule matched, so HSN ${variant.hsn} came from the Default HSN setting (${settings.defaultHsn}) and the ${variant.rate}% rate from the table fallback. Worth an explicit rule or a product tag.`
}
