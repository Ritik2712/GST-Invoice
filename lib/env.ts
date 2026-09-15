// Belt and braces: these values must never be bundled into client code. Next.js already
// strips non-NEXT_PUBLIC_ env vars from the browser bundle, and this throws loudly if the
// module is ever pulled into a client component by mistake.
if (typeof window !== 'undefined') {
  throw new Error('lib/env.ts is server-only and must not be imported from client code')
}

/**
 * Server-side configuration. Credentials live here and nowhere else: they are never returned
 * by an API route, never rendered into HTML and never written to a log line.
 *
 * Two ways to authenticate, in order of preference:
 *   1. SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET - exchanged for a short-lived access token at
 *      runtime (see lib/shopify/token.ts). Nothing that expires is stored.
 *   2. SHOPIFY_ADMIN_ACCESS_TOKEN - a static, non-expiring token from a legacy custom app.
 *      Used only when no client credentials are set.
 */

export type ShopifyAuth =
  | { mode: 'client_credentials'; clientId: string; clientSecret: string }
  | { mode: 'static'; accessToken: string }

export interface ShopifyConfig {
  shopDomain: string
  apiVersion: string
  auth: ShopifyAuth
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function env(name: string): string {
  return (process.env[name] ?? '').trim()
}

export function getShopifyConfig(): ShopifyConfig {
  const shopDomain = env('SHOPIFY_SHOP_DOMAIN').replace(/^https?:\/\//, '').replace(/\/$/, '')
  const apiVersion = env('SHOPIFY_API_VERSION') || '2025-07'
  const clientId = env('SHOPIFY_CLIENT_ID')
  const clientSecret = env('SHOPIFY_CLIENT_SECRET')
  const accessToken = env('SHOPIFY_ADMIN_ACCESS_TOKEN')

  if (!shopDomain) throw new ConfigError('SHOPIFY_SHOP_DOMAIN is not set in .env')

  // Half-configured client credentials are a mistake worth naming, not a reason to fall
  // back silently to an old static token.
  if (clientId && !clientSecret) throw new ConfigError('SHOPIFY_CLIENT_SECRET is not set in .env')
  if (clientSecret && !clientId) throw new ConfigError('SHOPIFY_CLIENT_ID is not set in .env')

  if (clientId && clientSecret) {
    return { shopDomain, apiVersion, auth: { mode: 'client_credentials', clientId, clientSecret } }
  }

  if (accessToken) {
    if (!/^shpat_|^shpca_|^shppa_/.test(accessToken)) {
      throw new ConfigError('SHOPIFY_ADMIN_ACCESS_TOKEN does not look like an Admin API access token')
    }
    return { shopDomain, apiVersion, auth: { mode: 'static', accessToken } }
  }

  throw new ConfigError('Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env')
}

/** Safe to send to the client - contains no secret. */
export function getPublicConfig() {
  return {
    shopDomain: (process.env.SHOPIFY_SHOP_DOMAIN ?? '').trim(),
    apiKey: (process.env.NEXT_PUBLIC_SHOPIFY_API_KEY ?? '').trim(),
  }
}
