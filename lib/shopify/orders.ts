import type {
  FinancialStatus,
  NormalizedOrder,
  PartyAddress,
  TaxableLineInput,
} from '../gst/types'
import { adminGraphql, ShopifyApiError } from './client'
import { normalizeHsCode } from './products'

/**
 * The `customer` block needs the `read_customers` scope, which this app does not require.
 * It is therefore requested only while we believe it is available: the first ACCESS_DENIED
 * response flips `customerFieldAvailable` off and every later query omits it.
 *
 * What is lost without it: the customer's default address, which is the third fallback for
 * place of supply. The shipping and billing addresses on the order still work, and the
 * buyer's name comes from those addresses instead.
 */
let customerFieldAvailable = true
/**
 * The variant's Harmonized System code lives on its inventory item, which some stores gate
 * behind `read_inventory`. Same treatment as the customer block: requested while we believe
 * it is available, dropped for good on the first ACCESS_DENIED.
 */
let inventoryFieldAvailable = true

export function isCustomerDataAvailable(): boolean {
  return customerFieldAvailable
}

export function isVariantHsCodeAvailable(): boolean {
  return inventoryFieldAvailable
}

export interface OptionalBlocks {
  customer: boolean
  inventory: boolean
}

function currentBlocks(): OptionalBlocks {
  return { customer: customerFieldAvailable, inventory: inventoryFieldAvailable }
}

const CUSTOMER_BLOCK = /* GraphQL */ `
  customer {
    firstName
    lastName
    email
    phone
    defaultAddress {
      ...Address
    }
  }
`

/** Everything the invoice engine needs, in one round trip. */
const INVENTORY_BLOCK = /* GraphQL */ `
  variant {
    inventoryItem {
      harmonizedSystemCode
    }
  }
`

const orderFields = ({ customer, inventory }: OptionalBlocks) => /* GraphQL */ `
  fragment Address on MailingAddress {
    name
    address1
    address2
    city
    province
    provinceCode
    zip
    countryCodeV2
    phone
  }

  fragment OrderFields on Order {
    id
    name
    createdAt
    processedAt
    cancelledAt
    cancelReason
    test
    displayFinancialStatus
    taxesIncluded
    currencyCode
    email
    phone
    note
    customAttributes {
      key
      value
    }
    totalPriceSet {
      shopMoney {
        amount
      }
    }
    currentTotalDiscountsSet {
      shopMoney {
        amount
      }
    }
    billingAddress {
      ...Address
    }
    shippingAddress {
      ...Address
    }
    ${customer ? CUSTOMER_BLOCK : ''}
    shippingLines(first: 5) {
      nodes {
        title
        originalPriceSet {
          shopMoney {
            amount
          }
        }
        discountedPriceSet {
          shopMoney {
            amount
          }
        }
        taxLines {
          rate
          priceSet {
            shopMoney {
              amount
            }
          }
        }
        discountAllocations {
          allocatedAmountSet {
            shopMoney {
              amount
            }
          }
        }
      }
    }
    lineItems(first: 100) {
      nodes {
        id
        title
        variantTitle
        sku
        quantity
        vendor
        originalUnitPriceSet {
          shopMoney {
            amount
          }
        }
        discountedTotalSet {
          shopMoney {
            amount
          }
        }
        originalTotalSet {
          shopMoney {
            amount
          }
        }
        taxLines {
          rate
          priceSet {
            shopMoney {
              amount
            }
          }
        }
        discountAllocations {
          allocatedAmountSet {
            shopMoney {
              amount
            }
          }
        }
        ${inventory ? INVENTORY_BLOCK : ''}
        product {
          productType
          tags
          hsnMetafield: metafield(namespace: "custom", key: "hsn") {
            value
          }
        }
      }
    }
  }
`

const ordersQuery = (blocks: OptionalBlocks) => /* GraphQL */ `
  ${orderFields(blocks)}
  query Orders($first: Int, $last: Int, $after: String, $before: String, $query: String) {
    orders(
      first: $first
      last: $last
      after: $after
      before: $before
      query: $query
      sortKey: CREATED_AT
      reverse: true
    ) {
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      nodes {
        ...OrderFields
      }
    }
  }
`

const orderQuery = (blocks: OptionalBlocks) => /* GraphQL */ `
  ${orderFields(blocks)}
  query Order($id: ID!) {
    order(id: $id) {
      ...OrderFields
    }
  }
`

/* -------------------------------------------------------------------------- */
/* Raw response shapes                                                         */
/* -------------------------------------------------------------------------- */

interface RawAddress {
  name?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  province?: string | null
  provinceCode?: string | null
  zip?: string | null
  countryCodeV2?: string | null
  phone?: string | null
}

interface RawTaxLine {
  rate?: number | null
  priceSet?: { shopMoney: { amount: string } } | null
}

interface RawDiscountAllocation {
  allocatedAmountSet?: { shopMoney: { amount: string } } | null
}

interface RawOrder {
  id: string
  name: string
  createdAt: string
  processedAt?: string | null
  cancelledAt?: string | null
  cancelReason?: string | null
  test?: boolean | null
  displayFinancialStatus?: string | null
  taxesIncluded?: boolean | null
  currencyCode: string
  email?: string | null
  phone?: string | null
  note?: string | null
  customAttributes: Array<{ key: string; value?: string | null }>
  totalPriceSet: { shopMoney: { amount: string } }
  currentTotalDiscountsSet?: { shopMoney: { amount: string } } | null
  billingAddress?: RawAddress | null
  shippingAddress?: RawAddress | null
  customer?: {
    firstName?: string | null
    lastName?: string | null
    email?: string | null
    phone?: string | null
    defaultAddress?: RawAddress | null
  } | null
  shippingLines: {
    nodes: Array<{
      title?: string | null
      originalPriceSet?: { shopMoney: { amount: string } } | null
      discountedPriceSet?: { shopMoney: { amount: string } } | null
      taxLines?: RawTaxLine[] | null
      discountAllocations?: RawDiscountAllocation[] | null
    }>
  }
  lineItems: {
    nodes: Array<{
      id: string
      title: string
      variantTitle?: string | null
      sku?: string | null
      quantity: number
      vendor?: string | null
      originalUnitPriceSet: { shopMoney: { amount: string } }
      discountedTotalSet: { shopMoney: { amount: string } }
      originalTotalSet: { shopMoney: { amount: string } }
      taxLines?: RawTaxLine[] | null
      discountAllocations?: RawDiscountAllocation[] | null
      variant?: { inventoryItem?: { harmonizedSystemCode?: string | null } | null } | null
      product?: {
        productType?: string | null
        tags?: string[] | null
        hsnMetafield?: { value?: string | null } | null
      } | null
    }>
  }
}

export interface OrdersPage {
  orders: NormalizedOrder[]
  pageInfo: {
    hasNextPage: boolean
    hasPreviousPage: boolean
    startCursor: string | null
    endCursor: string | null
  }
}

export interface FetchOrdersOptions {
  pageSize?: number
  after?: string | null
  before?: string | null
  /** Shopify search syntax, e.g. `financial_status:paid`. */
  query?: string | null
}

export async function fetchOrders(options: FetchOrdersOptions = {}): Promise<OrdersPage> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 25, 1), 100)
  const paginatingBackwards = Boolean(options.before)

  const data = await withScopeFallback<{
    orders: { pageInfo: OrdersPage['pageInfo']; nodes: RawOrder[] }
  }>(ordersQuery, {
    first: paginatingBackwards ? null : pageSize,
    last: paginatingBackwards ? pageSize : null,
    after: options.after ?? null,
    before: options.before ?? null,
    query: options.query || null,
  })

  return {
    orders: data.orders.nodes.map(normalizeOrder),
    pageInfo: data.orders.pageInfo,
  }
}

export async function fetchOrder(id: string): Promise<NormalizedOrder | null> {
  return (await fetchOrderWithRaw(id))?.order ?? null
}

/**
 * Same fetch, but keeps Shopify's untouched response alongside the normalised order. The
 * raw payload is what you want when a figure on an invoice looks wrong and the question is
 * whether the app misread the order or the order really says that.
 */
export async function fetchOrderWithRaw(
  id: string,
): Promise<{ order: NormalizedOrder; raw: unknown; blocks: OptionalBlocks } | null> {
  const data = await withScopeFallback<{ order: RawOrder | null }>(orderQuery, { id })
  if (!data.order) return null
  return { order: normalizeOrder(data.order), raw: data.order, blocks: currentBlocks() }
}

/** Which optional block a field-level ACCESS_DENIED is complaining about, if any. */
function deniedBlock(error: unknown): keyof OptionalBlocks | null {
  if (!(error instanceof ShopifyApiError)) return null
  if (/read_customers/i.test(error.message)) return 'customer'
  if (/read_inventory/i.test(error.message)) return 'inventory'
  return null
}

const DOWNGRADE_NOTES: Record<keyof OptionalBlocks, string> = {
  customer:
    'read_customers is not granted; continuing without customer details. Place of supply will use the order shipping and billing addresses only.',
  inventory:
    'read_inventory is not granted; continuing without variant HS codes. HSN will come from product tags, metafields or the rate table.',
}

/**
 * Runs a query with every optional block, and transparently re-runs it with a block dropped
 * whenever Shopify says the scope behind it is missing. Each downgrade is remembered, so the
 * cost is one wasted request per block per server start, not one per page of orders.
 */
async function withScopeFallback<T>(
  build: (blocks: OptionalBlocks) => string,
  variables: Record<string, unknown>,
): Promise<T> {
  for (;;) {
    try {
      return await adminGraphql<T>(build(currentBlocks()), variables)
    } catch (error) {
      const block = deniedBlock(error)
      // Only retry for a block that is still switched on, or this would loop for ever.
      if (!block || !currentBlocks()[block]) throw error

      if (block === 'customer') customerFieldAvailable = false
      else inventoryFieldAvailable = false
      console.info(`[gst-invoice-app] ${DOWNGRADE_NOTES[block]}`)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

function money(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value ?? '0')
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Shopify splits an Indian rate across one tax line per head (CGST 2.5% + SGST 2.5%), so the
 * line's rate is their sum. An empty list means Shopify charged no tax at all, which is not
 * the same as a 0% rate - the rate table has to decide that one, so it returns undefined.
 */
function taxRate(taxLines: Array<{ rate?: number | null }> | null | undefined): number | undefined {
  if (!taxLines || taxLines.length === 0) return undefined
  return Math.round(taxLines.reduce((total, line) => total + Number(line.rate ?? 0), 0) * 10_000) / 100
}

/** The rate charged on freight. Shipping lines carry the same rate, so summing them would double it. */
/**
 * What Shopify actually charged on a line, its tax lines summed. The invoice records this
 * rather than re-deriving it: Shopify taxes the order and then allocates that tax across
 * lines, so a per-line recalculation can land a paisa either side of it - and the invoice has
 * to add up to what the customer paid.
 */
function taxAmount(taxLines: RawTaxLine[] | null | undefined): number | undefined {
  if (!taxLines || taxLines.length === 0) return undefined
  return round2(taxLines.reduce((total, line) => total + money(line.priceSet?.shopMoney.amount), 0))
}

function shippingTaxAmount(nodes: Array<{ taxLines?: RawTaxLine[] | null }>): number | undefined {
  const amounts = nodes.map((node) => taxAmount(node.taxLines)).filter((a): a is number => a !== undefined)
  return amounts.length ? round2(amounts.reduce((total, amount) => total + amount, 0)) : undefined
}

function shippingTaxRate(nodes: Array<{ taxLines?: Array<{ rate?: number | null }> | null }>): number | undefined {
  const rates = nodes.map((node) => taxRate(node.taxLines)).filter((rate): rate is number => rate !== undefined)
  return rates.length === 0 ? undefined : Math.max(...rates)
}

/** Shopify's own allocation of order-level and code-based discounts onto a line. */
function allocatedDiscount(allocations: RawDiscountAllocation[] | null | undefined): number {
  if (!allocations) return 0
  return round2(
    allocations.reduce((total, one) => total + money(one.allocatedAmountSet?.shopMoney.amount), 0),
  )
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function address(raw: RawAddress | null | undefined): PartyAddress | null {
  if (!raw) return null
  return {
    name: raw.name ?? undefined,
    line1: raw.address1 ?? undefined,
    line2: raw.address2 ?? undefined,
    city: raw.city ?? undefined,
    stateName: raw.province ?? undefined,
    stateCode: raw.provinceCode ?? undefined,
    pincode: raw.zip ?? undefined,
    country: raw.countryCodeV2 ?? undefined,
    phone: raw.phone ?? undefined,
  }
}

const FINANCIAL_STATUSES: FinancialStatus[] = [
  'PENDING', 'AUTHORIZED', 'PARTIALLY_PAID', 'PAID',
  'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED', 'EXPIRED',
]

function financialStatus(value: string | null | undefined): FinancialStatus {
  const upper = (value ?? '').toUpperCase() as FinancialStatus
  return FINANCIAL_STATUSES.includes(upper) ? upper : 'UNKNOWN'
}

/** A buyer GSTIN can arrive as an order attribute, a checkout note or a customer note. */
function buyerGstin(order: RawOrder): string | null {
  const attribute = order.customAttributes.find((a) => /gst(in)?|gst[_ ]?number/i.test(a.key))
  const candidates = [attribute?.value, order.note]
  for (const candidate of candidates) {
    if (!candidate) continue
    const match = candidate.toUpperCase().match(/\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]/)
    if (match) return match[0]
  }
  return null
}

/**
 * HSN for a line, most specific source first:
 *   1. the variant's own Harmonized System code in Shopify
 *   2. an `hsn:61091000` product tag
 *   3. a `custom.hsn` product metafield
 * Nothing here decides the *rate* - that always comes from the rate table, so every rate on
 * an issued invoice stays traceable to a rule.
 */
function hsnOverride(
  hsCode: string | null | undefined,
  tags: string[],
  metafieldValue: string | null | undefined,
): string | null {
  const fromVariant = normalizeHsCode(hsCode)
  if (fromVariant) return fromVariant

  const tag = tags.find((t) => /^hsn[:=]/i.test(t.trim()))
  const fromTag = normalizeHsCode(tag?.split(/[:=]/)[1])
  if (fromTag) return fromTag

  return normalizeHsCode(metafieldValue)
}

function orderNumberFrom(name: string): number {
  const digits = name.replace(/\D/g, '')
  return digits ? Number.parseInt(digits, 10) : 0
}

export function normalizeOrder(raw: RawOrder): NormalizedOrder {
  // With taxesIncluded false Shopify added tax on top of the listed prices. A line it then
  // charged no tax on was still paid in full, so its amount has to be read as tax-inclusive.
  const taxesIncluded = raw.taxesIncluded ?? undefined
  const chargedTaxFree = (taxLines: Array<{ rate?: number | null }> | null | undefined) =>
    taxesIncluded === false && taxRate(taxLines) === undefined ? true : undefined

  const lines: TaxableLineInput[] = raw.lineItems.nodes.map((item) => {
    const tags = item.product?.tags ?? []
    const originalTotal = money(item.originalTotalSet.shopMoney.amount)
    const discountedTotal = money(item.discountedTotalSet.shopMoney.amount)
    return {
      id: item.id,
      title: item.title,
      variantTitle: item.variantTitle,
      sku: item.sku,
      productType: item.product?.productType ?? null,
      vendor: item.vendor ?? null,
      tags,
      hsnOverride: hsnOverride(
        item.variant?.inventoryItem?.harmonizedSystemCode,
        tags,
        item.product?.hsnMetafield?.value,
      ),
      quantity: item.quantity,
      unitPrice: money(item.originalUnitPriceSet.shopMoney.amount),
      // Two sources, deliberately not added. discountAllocations is every discount allocated
      // to the line, line-level and order-level alike, so it is the whole answer when present.
      // discountedTotalSet sees line-level discounts only. Taking the larger uses Shopify's
      // full allocation where it has one, keeps working on a response that carries none, and
      // can never count a line-level discount twice.
      discount: round2(
        Math.max(
          Math.max(0, originalTotal - discountedTotal),
          allocatedDiscount(item.discountAllocations),
        ),
      ),
      taxRateOverride: taxRate(item.taxLines),
      taxAmountCharged: taxAmount(item.taxLines),
      priceIncludesTax: chargedTaxFree(item.taxLines),
      kind: 'GOODS',
    }
  })

  const shippingNodes = raw.shippingLines.nodes
  const shippingOriginal = shippingNodes.reduce(
    (total, node) => total + money(node.originalPriceSet?.shopMoney.amount),
    0,
  )
  const shippingDiscounted = shippingNodes.reduce(
    (total, node) => total + money(node.discountedPriceSet?.shopMoney.amount ?? node.originalPriceSet?.shopMoney.amount),
    0,
  )
  // Same two sources, same reason for taking the larger rather than the sum.
  const shippingDiscount = round2(
    Math.max(
      Math.max(0, shippingOriginal - shippingDiscounted),
      shippingNodes.reduce((total, node) => total + allocatedDiscount(node.discountAllocations), 0),
    ),
  )

  // Last resort only. discountAllocations is Shopify's own answer and covers order-level and
  // code-based discounts, so this runs when the order total still disagrees with it - an older
  // API shape, say. Spreading by line value is a guess, and a guess is wrong for a discount
  // that only applied to some products, so it never overrides an allocation Shopify gave us.
  const reportedDiscount = money(raw.currentTotalDiscountsSet?.shopMoney.amount)
  const lineAndShippingDiscount =
    lines.reduce((total, line) => total + line.discount, 0) + shippingDiscount
  const missingDiscount = round2(Math.max(0, reportedDiscount - lineAndShippingDiscount))
  if (missingDiscount > 0 && lines.length > 0) {
    // Cap each share at what is left on the line so a discount can never drive a line negative.
    const headroom = lines.map((line) => Math.max(0, round2(line.unitPrice * line.quantity - line.discount)))
    const totalHeadroom = headroom.reduce((total, value) => total + value, 0)
    if (totalHeadroom > 0) {
      let allocated = 0
      lines.forEach((line, index) => {
        const proportional =
          index === lines.length - 1
            ? round2(missingDiscount - allocated)
            : round2((missingDiscount * headroom[index]) / totalHeadroom)
        const share = Math.min(Math.max(0, proportional), headroom[index])
        allocated = round2(allocated + share)
        line.discount = round2(line.discount + share)
      })
    }
  }

  const customerName = [raw.customer?.firstName, raw.customer?.lastName].filter(Boolean).join(' ').trim()

  return {
    id: raw.id,
    name: raw.name,
    orderNumber: orderNumberFrom(raw.name),
    createdAt: raw.createdAt,
    processedAt: raw.processedAt ?? null,
    currency: raw.currencyCode,
    financialStatus: financialStatus(raw.displayFinancialStatus),
    isTest: raw.test === true,
    cancelledAt: raw.cancelledAt ?? null,
    cancelReason: raw.cancelReason ?? null,
    customerName:
      customerName || raw.shippingAddress?.name || raw.billingAddress?.name || null,
    customerEmail: raw.customer?.email ?? raw.email ?? null,
    customerPhone: raw.customer?.phone ?? raw.phone ?? null,
    customerGstin: buyerGstin(raw),
    billingAddress: address(raw.billingAddress),
    shippingAddress: address(raw.shippingAddress),
    customerDefaultAddress: address(raw.customer?.defaultAddress),
    lines,
    shipping:
      shippingOriginal > 0
        ? {
            amount: shippingOriginal,
            discount: shippingDiscount,
            title: shippingNodes[0]?.title || 'Shipping',
            taxRate: shippingTaxRate(shippingNodes),
            taxAmountCharged: shippingTaxAmount(shippingNodes),
            priceIncludesTax: chargedTaxFree(shippingNodes.flatMap((node) => node.taxLines ?? [])),
          }
        : null,
    orderTotal: money(raw.totalPriceSet.shopMoney.amount),
    pricesIncludeGst: taxesIncluded,
  }
}
