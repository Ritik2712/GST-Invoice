/** Shapes shared by the rate table, the calculator and the stored invoice snapshot. */

export type TaxKind = 'INTRA_STATE' | 'INTER_STATE'

export interface SellerProfile {
  legalName: string
  gstin: string
  stateCode: string
  stateName: string
  address: string
  pan?: string
}

export interface PartyAddress {
  name?: string
  line1?: string
  line2?: string
  city?: string
  stateName?: string
  stateCode?: string
  pincode?: string
  country?: string
  phone?: string
}

/**
 * A line as handed to the calculator: Shopify-shaped data already normalised, with the
 * money figures in rupees. `unitPrice` is tax-inclusive when `pricesIncludeGst` is set
 * on the calculation input.
 */
export interface TaxableLineInput {
  id: string
  title: string
  variantTitle?: string | null
  sku?: string | null
  productType?: string | null
  vendor?: string | null
  tags?: string[]
  hsnOverride?: string | null
  quantity: number
  /** Per-unit price before any discount. */
  unitPrice: number
  /** Total discount allocated to this line (all units). */
  discount: number
  /** Marks the shipping/freight pseudo-line so shipping rules can apply. */
  kind?: 'GOODS' | 'SHIPPING'
  /**
   * Freight folded into this line by APPORTION, tracked separately so the line's rate can
   * still be resolved on its pre-freight value.
   */
  apportionedShipping?: number
}

export interface RateSlab {
  /** Upper bound (exclusive) on the per-unit taxable value; omit for the top slab. */
  maxUnitTaxableValue?: number
  rate: number
}

export type MatchField = 'sku' | 'tag' | 'productType' | 'vendor' | 'title' | 'any'
export type MatchOperator = 'equals' | 'startsWith' | 'contains' | 'regex'

export interface RateRuleMatch {
  field: MatchField
  operator: MatchOperator
  value: string
  caseSensitive?: boolean
}

export interface RateRule {
  id: string
  description?: string
  /** Lower number wins. Ties break on array order. */
  priority: number
  /** Every condition must match (AND). An empty list matches nothing. */
  match: RateRuleMatch[]
  hsn: string
  /** Flat rate, or omit and provide `slabs` for value-dependent rates. */
  rate?: number
  /** Evaluated in order; the first slab whose bound holds wins. */
  slabs?: RateSlab[]
  /** GST compensation cess, percent of taxable value. Rare; defaults to 0. */
  cess?: number
  /** Only consider this rule for lines of this kind. Defaults to GOODS. */
  appliesTo?: 'GOODS' | 'SHIPPING' | 'ANY'
}

export interface RateTable {
  version: number
  /** Used when no rule matches and the line carries no override. */
  fallback: { hsn: string; rate: number }
  rules: RateRule[]
}

export interface ResolvedRate {
  hsn: string
  rate: number
  cess: number
  /** Rule id, `"line-override"`, or `"fallback"` - recorded on the invoice snapshot. */
  source: string
}

export interface CalcLine {
  id: string
  title: string
  hsn: string
  quantity: number
  /** Per-unit taxable value, exclusive of GST. */
  unitTaxableValue: number
  /** Line taxable value after discount, exclusive of GST. */
  taxableValue: number
  discount: number
  rate: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  total: number
  rateSource: string
  kind: 'GOODS' | 'SHIPPING'
}

export interface HsnSummaryRow {
  /** Empty for a line printed without a code (e.g. delivery with no SAC). */
  hsn: string
  /** Stands in for the code in the summary when `hsn` is empty. */
  label?: string
  taxableValue: number
  rate: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  total: number
}

export interface CalcTotals {
  taxableValue: number
  discount: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  taxTotal: number
  /** taxableValue + taxTotal, before rounding to the nearest rupee. */
  subTotal: number
  roundOff: number
  grandTotal: number
}

export interface CalculationInput {
  sellerStateCode: string
  placeOfSupplyStateCode: string
  pricesIncludeGst: boolean
  lines: TaxableLineInput[]
  rateTable: RateTable
  /** See `AppSettings.shippingTreatment`. Defaults to SEPARATE_SERVICE. */
  shippingTreatment?: 'APPORTION' | 'COMPOSITE_LINE' | 'SEPARATE_SERVICE'
}

export interface CalculationResult {
  taxKind: TaxKind
  lines: CalcLine[]
  hsnSummary: HsnSummaryRow[]
  totals: CalcTotals
}

/* -------------------------------------------------------------------------- */
/* Order + invoice shapes                                                      */
/* -------------------------------------------------------------------------- */

export type FinancialStatus =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'VOIDED'
  | 'EXPIRED'
  | 'UNKNOWN'

/** Shopify order flattened into plain data the engine can consume. */
export interface NormalizedOrder {
  /** Shopify GID, e.g. gid://shopify/Order/123. Stable identity. */
  id: string
  /** Human order name, e.g. "#1042". Printed only as a reference. */
  name: string
  orderNumber: number
  createdAt: string
  processedAt?: string | null
  currency: string
  financialStatus: FinancialStatus
  /**
   * Shopify marks orders placed through a test gateway as test orders. No supply actually
   * happened, so they must not consume a number in a statutory invoice series.
   */
  isTest: boolean
  cancelledAt?: string | null
  cancelReason?: string | null
  customerName?: string | null
  customerEmail?: string | null
  customerPhone?: string | null
  customerGstin?: string | null
  billingAddress?: PartyAddress | null
  shippingAddress?: PartyAddress | null
  customerDefaultAddress?: PartyAddress | null
  lines: TaxableLineInput[]
  shipping: { amount: number; discount: number; title: string } | null
  /** Order total as Shopify reports it, kept for reconciliation on the invoice. */
  orderTotal: number
}

export type InvoiceStatus = 'ISSUED' | 'CANCELLED'

export interface InvoiceSnapshot {
  /** Snapshot schema version, so later readers can migrate old files. */
  schemaVersion: number
  invoiceNumber: string
  financialYear: string
  sequence: number
  issuedAt: string
  invoiceDate: string
  status: InvoiceStatus
  cancelledAt?: string | null
  cancellationReason?: string | null

  seller: SellerProfile & {
    bank?: { bankName?: string; accountName?: string; accountNumber?: string; ifsc?: string }
    logoDataUri?: string | null
    invoiceTitle?: string
  }

  buyer: {
    name: string
    gstin?: string | null
    email?: string | null
    phone?: string | null
    billingAddress?: PartyAddress | null
    shippingAddress?: PartyAddress | null
  }

  order: {
    id: string
    name: string
    number: number
    placedAt: string
    financialStatus: FinancialStatus
    currency: string
    shopifyTotal: number
  }

  placeOfSupply: { stateCode: string; stateName: string; source: string }
  taxKind: TaxKind
  pricesIncludeGst: boolean
  reverseCharge: boolean

  lines: CalcLine[]
  hsnSummary: HsnSummaryRow[]
  totals: CalcTotals
  amountInWords: string

  terms?: string
  /** Rate table version the invoice was priced against - the audit trail for the freeze. */
  rateTableVersion: number
}
