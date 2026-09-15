import { NextResponse, type NextRequest } from 'next/server'

import { ConfigError, getShopifyConfig } from '@/lib/env'
import { adminGraphql, ShopifyApiError } from '@/lib/shopify/client'
import { getAccessToken, getTokenStatus } from '@/lib/shopify/token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Diagnostic endpoint. Reports whether the server is configured, whether an access token can
 * be obtained, and whether it actually works - without ever revealing the token or secret.
 *
 *   GET /api/health            full check: token exchange + two live Admin API calls
 *   GET /api/health?quick=1    configuration only, no network
 *
 * Status codes are chosen so the code alone tells you where the problem is:
 *   200 OK               everything works
 *   503 NOT_CONFIGURED   .env is missing or incomplete - nothing is wrong with the app
 *   502 TOKEN_ERROR      Shopify refused the client id / secret
 *   502 SHOPIFY_ERROR    a token was issued, but a scope is missing or the call failed
 */

const REQUIRED_SCOPES = ['read_orders', 'read_products']

const ORDERS_PROBE = /* GraphQL */ `
  query HealthOrders {
    orders(first: 1) {
      nodes {
        id
      }
    }
  }
`

const PRODUCTS_PROBE = /* GraphQL */ `
  query HealthProducts {
    products(first: 1) {
      nodes {
        id
      }
    }
  }
`

interface Check {
  ok: boolean
  detail: string
}

export async function GET(request: NextRequest) {
  let shopDomain: string
  let apiVersion: string
  let mode: 'client_credentials' | 'static'

  try {
    const config = getShopifyConfig()
    shopDomain = config.shopDomain
    apiVersion = config.apiVersion
    mode = config.auth.mode
  } catch (error) {
    // 503, not 500: the app is fine, it just has no credentials yet.
    return NextResponse.json(
      {
        ok: false,
        status: 'NOT_CONFIGURED',
        code: 'CONFIG',
        error: error instanceof ConfigError ? error.message : 'Not configured',
        hint: 'Set SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env, then restart the dev server - Next.js only reads .env at startup.',
      },
      { status: 503 },
    )
  }

  if (request.nextUrl.searchParams.get('quick') === '1') {
    return NextResponse.json({ ok: true, status: 'CONFIGURED', shopDomain, apiVersion, auth: { mode }, checks: {} })
  }

  try {
    await getAccessToken()
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        status: 'TOKEN_ERROR',
        shopDomain,
        apiVersion,
        auth: { mode },
        error: error instanceof Error ? error.message : 'Could not obtain an access token',
        hint: 'The POST to /admin/oauth/access_token failed. Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, and that the app is installed on this store.',
      },
      { status: 502 },
    )
  }

  const auth = getTokenStatus()
  // Scopes come back with the token, so a missing one is visible before any API call fails.
  const missingScopes =
    auth.mode === 'client_credentials' && auth.cached
      ? REQUIRED_SCOPES.filter((scope) => !auth.scopes.includes(scope))
      : []

  const [orders, products] = await Promise.all([
    probe(ORDERS_PROBE, 'read_orders'),
    probe(PRODUCTS_PROBE, 'read_products'),
  ])

  const ok = orders.ok && products.ok && missingScopes.length === 0
  return NextResponse.json(
    {
      ok,
      status: ok ? 'OK' : 'SHOPIFY_ERROR',
      shopDomain,
      apiVersion,
      auth,
      missingScopes,
      checks: { read_orders: orders, read_products: products },
      ...(ok
        ? {}
        : {
            hint: 'Grant read_orders and read_products in the app\'s configuration and reinstall it on the store. With client credentials the next token picks the new scopes up automatically.',
          }),
    },
    { status: ok ? 200 : 502 },
  )
}

async function probe(query: string, scope: string): Promise<Check> {
  try {
    await adminGraphql(query)
    return { ok: true, detail: `${scope} granted` }
  } catch (error) {
    if (error instanceof ShopifyApiError) return { ok: false, detail: error.message }
    return { ok: false, detail: error instanceof Error ? error.message : 'Unknown error' }
  }
}
