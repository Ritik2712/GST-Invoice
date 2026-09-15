import { getShopifyConfig, type ShopifyAuth } from '../env'
import { TokenError } from './errors'

/**
 * Admin API access tokens obtained with the client-credentials grant.
 *
 * The app holds a client id and secret, not a token. On first use it POSTs them to
 * `https://<shop>/admin/oauth/access_token` and keeps the token it gets back in memory until
 * shortly before it expires (tokens last about 24 hours), then fetches a new one. The token
 * is never written to disk or to .env, and neither it nor the secret is ever logged or
 * returned by an API route.
 *
 * Single process only - which is what this app is. A restart simply fetches a fresh token.
 */

interface CachedToken {
  /** Shop + client id the token belongs to, so changed credentials never reuse it. */
  key: string
  token: string
  obtainedAt: number
  expiresAt: number
  scopes: string[]
}

let cached: CachedToken | null = null
let inflight: { key: string; promise: Promise<CachedToken> } | null = null

/** Used only if Shopify omits `expires_in`: assume a short life rather than a long one. */
const DEFAULT_LIFETIME_SECONDS = 3600
const MIN_REFRESH_MARGIN_MS = 60_000
const MAX_REFRESH_MARGIN_MS = 5 * 60_000

type ClientCredentials = Extract<ShopifyAuth, { mode: 'client_credentials' }>

function cacheKey(shopDomain: string, auth: ClientCredentials): string {
  return `${shopDomain}|${auth.clientId}`
}

/**
 * Refresh a little before expiry - 10% of the token's life, clamped to 1-5 minutes - so a
 * request never goes out with a token that dies in flight.
 */
function isFresh(entry: CachedToken, now = Date.now()): boolean {
  const lifetime = entry.expiresAt - entry.obtainedAt
  const margin = Math.min(MAX_REFRESH_MARGIN_MS, Math.max(MIN_REFRESH_MARGIN_MS, lifetime * 0.1))
  return now < entry.expiresAt - margin
}

/** A valid Admin API access token, fetching or refreshing one if needed. */
export async function getAccessToken(): Promise<string> {
  const { shopDomain, auth } = getShopifyConfig()
  if (auth.mode === 'static') return auth.accessToken

  const key = cacheKey(shopDomain, auth)
  if (cached && cached.key === key && isFresh(cached)) return cached.token

  // Concurrent callers share one in-flight request instead of each minting a token.
  if (!inflight || inflight.key !== key) {
    const promise: Promise<CachedToken> = requestToken(shopDomain, auth, key)
      .then((entry) => {
        cached = entry
        return entry
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null
      })
    inflight = { key, promise }
  }
  return (await inflight.promise).token
}

/**
 * Drops the cached token. Called when Shopify answers 401 - the token was revoked or the app
 * reinstalled - so the next call fetches a new one instead of retrying a dead token.
 */
export function invalidateAccessToken(): void {
  cached = null
}

export type TokenStatus =
  | { mode: 'static' }
  | { mode: 'client_credentials'; cached: false }
  | {
      mode: 'client_credentials'
      cached: true
      obtainedAt: string
      expiresAt: string
      secondsLeft: number
      scopes: string[]
    }

/** What the health check reports. Never includes the token itself. */
export function getTokenStatus(): TokenStatus {
  const { shopDomain, auth } = getShopifyConfig()
  if (auth.mode === 'static') return { mode: 'static' }
  if (!cached || cached.key !== cacheKey(shopDomain, auth)) {
    return { mode: 'client_credentials', cached: false }
  }
  return {
    mode: 'client_credentials',
    cached: true,
    obtainedAt: new Date(cached.obtainedAt).toISOString(),
    expiresAt: new Date(cached.expiresAt).toISOString(),
    secondsLeft: Math.max(0, Math.round((cached.expiresAt - Date.now()) / 1000)),
    scopes: cached.scopes,
  }
}

async function requestToken(
  shopDomain: string,
  auth: ClientCredentials,
  key: string,
): Promise<CachedToken> {
  let response: Response
  try {
    response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        grant_type: 'client_credentials',
      }),
      cache: 'no-store',
    })
  } catch {
    throw new TokenError(`Could not reach ${shopDomain} to get an access token.`, 0)
  }

  const body = await readJson(response)

  if (!response.ok) {
    const code = typeof body?.error === 'string' ? body.error : null
    const rawDescription = typeof body?.error_description === 'string' ? body.error_description : null
    // Belt and braces: never let anything that echoes the secret reach a message.
    const description = rawDescription && !rawDescription.includes(auth.clientSecret) ? rawDescription : null
    throw new TokenError(failureMessage(response.status, code, description), response.status)
  }

  const token = body?.access_token
  if (typeof token !== 'string' || token.length === 0) {
    throw new TokenError('Shopify answered the token request without an access_token.', response.status)
  }

  const expiresIn = Number(body?.expires_in)
  const lifetimeSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_LIFETIME_SECONDS
  const now = Date.now()

  return {
    key,
    token,
    obtainedAt: now,
    expiresAt: now + lifetimeSeconds * 1000,
    scopes: typeof body?.scope === 'string' ? body.scope.split(/[,\s]+/).filter(Boolean) : [],
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

function failureMessage(status: number, code: string | null, description: string | null): string {
  const detail = [code, description].filter(Boolean).join(': ')
  if (status === 400 || status === 401 || status === 403) {
    return `Shopify refused the client credentials${detail ? ` (${detail})` : ''}. Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, and that the app is installed on this store.`
  }
  if (status === 404) {
    return 'Shopify returned 404 for the token endpoint. Check that SHOPIFY_SHOP_DOMAIN is the store\'s myshopify.com domain.'
  }
  return `Shopify returned ${status} when asked for an access token${detail ? ` (${detail})` : ''}.`
}
