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

interface RawOrder {
  id: string
  name: string
  createdAt: string
  processedAt?: string | null
  cancelledAt?: string | null
  cancelReason?: string | null
  test?: boolean | null
  displayFinancialStatus?: string | null
  currencyCode: string
  email?: string | null
  phone?: string | null
  note?: string | null
  customAttributes: Array<{ key: string; value?: string | null }>
  totalPriceSet: { shopMoney: { amount: string } }
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
      // Shopify reports the post-discount total; the difference is the allocated discount.
      discount: Math.max(0, originalTotal - discountedTotal),
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
            discount: Math.max(0, shippingOriginal - shippingDiscounted),
            title: shippingNodes[0]?.title || 'Shipping',
          }
        : null,
    orderTotal: money(raw.totalPriceSet.shopMoney.amount),
  }
}
