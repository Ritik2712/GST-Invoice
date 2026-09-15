import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The app asks for `read_orders` and `read_products` only. Requesting the `customer` field
 * needs `read_customers`, so these tests pin the behaviour when that scope is absent: the
 * query downgrades itself once and keeps working.
 */

const ORDER_NODE = {
  id: 'gid://shopify/Order/1',
  name: '#1001',
  createdAt: '2026-09-01T10:00:00Z',
  processedAt: '2026-09-01T10:00:00Z',
  cancelledAt: null,
  cancelReason: null,
  displayFinancialStatus: 'PAID',
  currencyCode: 'INR',
  email: 'buyer@example.com',
  phone: null,
  note: null,
  customAttributes: [],
  totalPriceSet: { shopMoney: { amount: '1180.00' } },
  billingAddress: null,
  shippingAddress: {
    name: 'Rhea Kapoor',
    address1: '4 Koregaon Park',
    address2: null,
    city: 'Pune',
    province: 'Maharashtra',
    provinceCode: 'MH',
    zip: '411001',
    countryCodeV2: 'IN',
    phone: null,
  },
  shippingLines: { nodes: [] },
  lineItems: {
    nodes: [
      {
        id: 'gid://shopify/LineItem/1',
        title: 'Linen shirt',
        variantTitle: null,
        sku: 'SHIRT',
        quantity: 1,
        vendor: 'Acme',
        originalUnitPriceSet: { shopMoney: { amount: '1180.00' } },
        discountedTotalSet: { shopMoney: { amount: '1180.00' } },
        originalTotalSet: { shopMoney: { amount: '1180.00' } },
        product: { productType: 'Apparel', tags: [], hsnMetafield: null },
      },
    ],
  },
}

const INVENTORY_SCOPE_ERROR = {
  errors: [
    {
      message: 'Access denied for inventoryItem field. Required access: `read_inventory` access scope.',
      extensions: { code: 'ACCESS_DENIED' },
    },
  ],
}

const CUSTOMER_SCOPE_ERROR = {
  errors: [
    {
      message: 'Access denied for customer field. Required access: `read_customers` access scope.',
      extensions: { code: 'ACCESS_DENIED' },
    },
  ],
}

/** Deep-cloned: tests mutate the line item, and a shared node would leak between them. */
function ordersPayload() {
  return {
    data: {
      orders: {
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        nodes: [structuredClone(ORDER_NODE)],
      },
    },
  }
}

/** Captures the GraphQL query text of every request so we can assert on the downgrade. */
function stubFetch(responses: unknown[]): string[] {
  const sent: string[] = []
  let call = 0
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body).query)
    const body = responses[Math.min(call++, responses.length - 1)]
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return sent
}

let orders: typeof import('./orders')

beforeEach(async () => {
  vi.stubEnv('SHOPIFY_SHOP_DOMAIN', 'test-store.myshopify.com')
  // Deliberately not token-shaped (shpat_ + 32 hex): secret scanners flag realistic fakes.
  vi.stubEnv('SHOPIFY_ADMIN_ACCESS_TOKEN', 'shpat_test_token_not_real')
  // Pin the static-token path so a developer's shell env cannot switch these tests over to
  // client credentials (which would add token requests to the fetch stub).
  vi.stubEnv('SHOPIFY_CLIENT_ID', '')
  vi.stubEnv('SHOPIFY_CLIENT_SECRET', '')
  vi.resetModules()
  orders = await import('./orders')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('missing read_customers scope', () => {
  it('retries without the customer block and still returns the order', async () => {
    const sent = stubFetch([CUSTOMER_SCOPE_ERROR, ordersPayload()])

    const page = await orders.fetchOrders()

    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('customer {')
    expect(sent[1]).not.toContain('customer {')
    expect(page.orders[0].name).toBe('#1001')
  })

  it('remembers the downgrade instead of paying for it on every page', async () => {
    const sent = stubFetch([CUSTOMER_SCOPE_ERROR, ordersPayload()])

    await orders.fetchOrders()
    expect(orders.isCustomerDataAvailable()).toBe(false)

    await orders.fetchOrders()
    // Third request only - no second probe of the denied field.
    expect(sent).toHaveLength(3)
    expect(sent[2]).not.toContain('customer {')
  })

  it('falls back to the address for the buyer name and keeps the place of supply', async () => {
    stubFetch([CUSTOMER_SCOPE_ERROR, ordersPayload()])
    const page = await orders.fetchOrders()

    const order = page.orders[0]
    expect(order.customerName).toBe('Rhea Kapoor')
    expect(order.customerEmail).toBe('buyer@example.com')
    expect(order.customerDefaultAddress).toBeNull()
    expect(order.shippingAddress?.stateCode).toBe('MH')
  })

  it('uses the customer block when the scope IS granted', async () => {
    const withCustomer = ordersPayload()
    ;(withCustomer.data.orders.nodes[0] as Record<string, unknown>).customer = {
      firstName: 'Rhea',
      lastName: 'Kapoor',
      email: 'rhea@example.com',
      phone: '+919000000000',
      defaultAddress: { provinceCode: 'KA', province: 'Karnataka', countryCodeV2: 'IN' },
    }
    const sent = stubFetch([withCustomer])

    const page = await orders.fetchOrders()

    expect(sent).toHaveLength(1)
    expect(orders.isCustomerDataAvailable()).toBe(true)
    expect(page.orders[0].customerDefaultAddress?.stateCode).toBe('KA')
    expect(page.orders[0].customerPhone).toBe('+919000000000')
  })

  it('does not swallow an unrelated GraphQL error', async () => {
    stubFetch([{ errors: [{ message: 'Field "nope" does not exist' }] }])
    await expect(orders.fetchOrders()).rejects.toThrow(/does not exist/)
  })
})


describe('HSN from the variant HS code', () => {
  const lineItem = (overrides: Record<string, unknown>) => {
    const payload = ordersPayload()
    Object.assign(payload.data.orders.nodes[0].lineItems.nodes[0] as Record<string, unknown>, overrides)
    return payload
  }

  it('prefers the variant Harmonized System code over a product tag', async () => {
    stubFetch([
      lineItem({
        variant: { inventoryItem: { harmonizedSystemCode: '61091000' } },
        product: { productType: 'T-Shirts', tags: ['hsn:99999999'], hsnMetafield: { value: '88888888' } },
      }),
    ])
    const page = await orders.fetchOrders()
    expect(page.orders[0].lines[0].hsnOverride).toBe('61091000')
  })

  it('falls back to the product tag, then the metafield', async () => {
    stubFetch([lineItem({ product: { tags: ['hsn:62052000'], hsnMetafield: { value: '88888888' } } })])
    expect((await orders.fetchOrders()).orders[0].lines[0].hsnOverride).toBe('62052000')

    stubFetch([lineItem({ product: { tags: [], hsnMetafield: { value: '61051000' } } })])
    expect((await orders.fetchOrders()).orders[0].lines[0].hsnOverride).toBe('61051000')
  })

  it('accepts a dotted HS code and trims it to 8 digits', async () => {
    stubFetch([lineItem({ variant: { inventoryItem: { harmonizedSystemCode: '6109.10.0090' } } })])
    expect((await orders.fetchOrders()).orders[0].lines[0].hsnOverride).toBe('61091000')
  })

  it('ignores an HS code too short to be an HSN', async () => {
    stubFetch([lineItem({ variant: { inventoryItem: { harmonizedSystemCode: '61' } }, product: null })])
    expect((await orders.fetchOrders()).orders[0].lines[0].hsnOverride).toBeNull()
  })

  it('drops the inventory block when read_inventory is missing', async () => {
    const sent = stubFetch([INVENTORY_SCOPE_ERROR, ordersPayload()])

    const page = await orders.fetchOrders()

    expect(sent[0]).toContain('inventoryItem')
    expect(sent[1]).not.toContain('inventoryItem')
    expect(orders.isVariantHsCodeAvailable()).toBe(false)
    // The customer block is untouched by an inventory denial.
    expect(orders.isCustomerDataAvailable()).toBe(true)
    expect(page.orders[0].name).toBe('#1001')
  })

  it('drops both blocks when both scopes are missing', async () => {
    const sent = stubFetch([CUSTOMER_SCOPE_ERROR, INVENTORY_SCOPE_ERROR, ordersPayload()])

    await orders.fetchOrders()

    expect(sent).toHaveLength(3)
    expect(sent[2]).not.toContain('customer {')
    expect(sent[2]).not.toContain('inventoryItem')
  })
})


describe('fetchOrderWithRaw', () => {
  function orderPayload() {
    return { data: { order: structuredClone(ORDER_NODE) } }
  }

  it('returns Shopify\'s payload untouched alongside the normalised order', async () => {
    stubFetch([orderPayload()])
    const result = await orders.fetchOrderWithRaw('gid://shopify/Order/1')

    // The normalised view flattens money into numbers...
    expect(result!.order.orderTotal).toBe(1180)
    expect(result!.order.lines[0].unitPrice).toBe(1180)
    // ...while the raw payload keeps Shopify's own shape and strings.
    expect((result!.raw as typeof ORDER_NODE).totalPriceSet.shopMoney.amount).toBe('1180.00')
    expect((result!.raw as typeof ORDER_NODE).displayFinancialStatus).toBe('PAID')
  })

  it('reports which optional blocks were available', async () => {
    stubFetch([orderPayload()])
    expect((await orders.fetchOrderWithRaw('gid://shopify/Order/1'))!.blocks).toEqual({
      customer: true,
      inventory: true,
    })

    stubFetch([CUSTOMER_SCOPE_ERROR, orderPayload()])
    expect((await orders.fetchOrderWithRaw('gid://shopify/Order/1'))!.blocks).toEqual({
      customer: false,
      inventory: true,
    })
  })

  it('returns null for an order that does not exist', async () => {
    stubFetch([{ data: { order: null } }])
    expect(await orders.fetchOrderWithRaw('gid://shopify/Order/999')).toBeNull()
  })
})
