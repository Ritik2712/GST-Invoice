import { getShopifyConfig } from '../env'
import { ShopifyApiError } from './errors'
import { getAccessToken, invalidateAccessToken } from './token'

export { ShopifyApiError, TokenError } from './errors'

interface GraphQLResponse<T> {
  data?: T
  errors?: Array<{ message: string; extensions?: { code?: string } }>
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number } } }
}

const MAX_ATTEMPTS = 3

/**
 * Admin GraphQL call. Retries on throttling and 5xx with a short backoff; everything else
 * surfaces immediately. The access token is only ever a request header.
 *
 * With client credentials, a 401 means the cached token is dead (revoked, or the app was
 * reinstalled): the token is dropped and the request retried once with a fresh one. A second
 * 401, or any 403, is a real permissions problem and is reported rather than retried.
 */
export async function adminGraphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const { shopDomain, apiVersion, auth } = getShopifyConfig()
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`

  let lastError: unknown
  let refreshedAfter401 = false

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const accessToken = await getAccessToken()
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
    })

    if (response.status === 401 && auth.mode === 'client_credentials' && !refreshedAfter401) {
      invalidateAccessToken()
      refreshedAfter401 = true
      attempt -= 1 // a token refresh is not a throttling retry; do not spend an attempt on it
      continue
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = new ShopifyApiError(`Shopify returned ${response.status}`, response.status)
      await delay(attempt * 700)
      continue
    }

    if (response.status === 401 || response.status === 403) {
      throw new ShopifyApiError(
        auth.mode === 'client_credentials'
          ? 'Shopify rejected the access token even after fetching a fresh one. Check that the app is installed on this store and has read_orders and read_products.'
          : 'Shopify rejected the Admin API token. Check SHOPIFY_ADMIN_ACCESS_TOKEN and that the custom app has read_orders and read_products.',
        response.status,
      )
    }

    if (!response.ok) {
      throw new ShopifyApiError(`Shopify returned ${response.status}`, response.status, await safeText(response))
    }

    const body = (await response.json()) as GraphQLResponse<T>

    if (body.errors?.length) {
      const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED')
      if (throttled && attempt < MAX_ATTEMPTS) {
        await delay(attempt * 1200)
        continue
      }
      throw new ShopifyApiError(body.errors.map((e) => e.message).join('; '), 200, body.errors)
    }

    if (!body.data) throw new ShopifyApiError('Shopify returned an empty response', 200)
    return body.data
  }

  throw lastError instanceof Error
    ? lastError
    : new ShopifyApiError('Shopify request failed after retries', 500)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500)
  } catch {
    return ''
  }
}
