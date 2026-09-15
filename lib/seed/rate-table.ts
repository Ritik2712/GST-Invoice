import type { RateTable } from '../gst/types'

/**
 * Seed rate table, written to data/hsn-rates.json on first run and freely editable after
 * that. Nothing here is compiled into the calculator - it is plain data.
 *
 * Matching order is by `priority` ascending, first match wins. A rule with an empty `hsn`
 * sets only the rate and leaves the HSN to the line override or the default HSN setting.
 *
 * Two ways to drive rates from Shopify without touching this file:
 *   - tag a product `gst:5` / `gst:12` / `gst:18` … to pin its rate
 *   - tag a product `hsn:61091000` to pin the printed HSN code
 */
export const DEFAULT_RATE_TABLE: RateTable = {
  version: 1,
  fallback: { hsn: '', rate: 18 },
  rules: [
    // -- Explicit per-product overrides via product tags -----------------------------
    { id: 'tag-gst-0', priority: 10, description: 'Product tagged gst:0', match: [{ field: 'tag', operator: 'equals', value: 'gst:0' }], hsn: '', rate: 0 },
    { id: 'tag-gst-0-25', priority: 10, description: 'Product tagged gst:0.25', match: [{ field: 'tag', operator: 'equals', value: 'gst:0.25' }], hsn: '', rate: 0.25 },
    { id: 'tag-gst-3', priority: 10, description: 'Product tagged gst:3', match: [{ field: 'tag', operator: 'equals', value: 'gst:3' }], hsn: '', rate: 3 },
    { id: 'tag-gst-5', priority: 10, description: 'Product tagged gst:5', match: [{ field: 'tag', operator: 'equals', value: 'gst:5' }], hsn: '', rate: 5 },
    { id: 'tag-gst-12', priority: 10, description: 'Product tagged gst:12', match: [{ field: 'tag', operator: 'equals', value: 'gst:12' }], hsn: '', rate: 12 },
    { id: 'tag-gst-18', priority: 10, description: 'Product tagged gst:18', match: [{ field: 'tag', operator: 'equals', value: 'gst:18' }], hsn: '', rate: 18 },
    { id: 'tag-gst-28', priority: 10, description: 'Product tagged gst:28', match: [{ field: 'tag', operator: 'equals', value: 'gst:28' }], hsn: '', rate: 28 },

    // -- Value-slab categories --------------------------------------------------------
    {
      id: 'apparel-slab',
      priority: 50,
      description: 'Readymade garments: 5% up to Rs.1,000 per piece, 12% above',
      match: [{ field: 'productType', operator: 'contains', value: 'apparel' }],
      hsn: '6109',
      slabs: [{ maxUnitTaxableValue: 1000, rate: 5 }, { rate: 12 }],
    },
    {
      id: 'footwear-slab',
      priority: 50,
      description: 'Footwear: 5% up to Rs.1,000 per pair, 18% above',
      match: [{ field: 'productType', operator: 'contains', value: 'footwear' }],
      hsn: '6403',
      slabs: [{ maxUnitTaxableValue: 1000, rate: 5 }, { rate: 18 }],
    },

    // -- Delivery (SEPARATE_SERVICE) -----------------------------------------------------
    {
      id: 'shipping-default',
      priority: 90,
      description: 'Freight / courier service',
      appliesTo: 'SHIPPING',
      match: [{ field: 'any', operator: 'regex', value: '.*' }],
      // Rate only: the printed code (if any) comes from the delivery SAC setting.
      hsn: '',
      rate: 18,
    },
  ],
}
