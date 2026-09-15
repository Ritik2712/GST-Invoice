import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pins the client-credentials behaviour: one token request, cached until close to expiry,
 * shared by concurrent callers, refreshed after a 401, and never leaking the secret.
 */

const SHOP = 'test-store.myshopify.com'
const TOKEN_URL = `https://${SHOP}/admin/oauth/access_token`
const SECRET = 'super-secret-value'

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []

function stubFetch(handler: Handler): void {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : null,
      headers: (init.headers ?? {}) as Record<string, string>,
    })
    return handler(url, init)
  })
}

const tokenCalls = () => calls.filter((c) => c.url === TOKEN_URL)

let token: typeof import('./token')
let client: typeof import('./client')

beforeEach(async () => {
  vi.stubEnv('SHOPIFY_SHOP_DOMAIN', SHOP)
  vi.stubEnv('SHOPIFY_CLIENT_ID', 'client-id-123')
  vi.stubEnv('SHOPIFY_CLIENT_SECRET', SECRET)
  vi.stubEnv('SHOPIFY_ADMIN_ACCESS_TOKEN', '')
  vi.resetModules()
  token = await import('./token')
  client = await import('./client')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('client-credentials token', () => {
  it('exchanges the client id and secret for a token', async () => {
    stubFetch(() => json({ access_token: 'shpat_one', scope: 'read_orders,read_products', expires_in: 86399 }))

    expect(await token.getAccessToken()).toBe('shpat_one')
    expect(tokenCalls()).toHaveLength(1)
    expect(tokenCalls()[0].body).toEqual({
      client_id: 'client-id-123',
      client_secret: SECRET,
      grant_type: 'client_credentials',
    })
  })

  it('reuses the token until shortly before it expires, then fetches a new one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'))
    let issued = 0
    stubFetch(() => json({ access_token: `shpat_${++issued}`, expires_in: 86399 }))

    expect(await token.getAccessToken()).toBe('shpat_1')

    // ~10 minutes left: still comfortably valid.
    vi.setSystemTime(new Date('2026-09-14T23:50:00Z'))
    expect(await token.getAccessToken()).toBe('shpat_1')

    // Under the 5-minute margin: refresh before it can die mid-request.
    vi.setSystemTime(new Date('2026-09-14T23:56:00Z'))
    expect(await token.getAccessToken()).toBe('shpat_2')
    expect(tokenCalls()).toHaveLength(2)
  })

  it('gives concurrent callers one shared token request', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    stubFetch(async () => {
      await gate
      return json({ access_token: 'shpat_once', expires_in: 3600 })
    })

    const all = Promise.all([token.getAccessToken(), token.getAccessToken(), token.getAccessToken()])
    release()

    expect(await all).toEqual(['shpat_once', 'shpat_once', 'shpat_once'])
    expect(tokenCalls()).toHaveLength(1)
  })

  it('does not cache a failure, and never puts the secret in the error', async () => {
    let attempt = 0
    stubFetch(() =>
      ++attempt === 1
        ? json({ error: 'invalid_client', error_description: 'Client authentication failed' }, 401)
        : json({ access_token: 'shpat_ok', expires_in: 3600 }),
    )

    const error = await token.getAccessToken().catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('TokenError')
    expect((error as Error).message).toMatch(/invalid_client/)
    expect((error as Error).message).toMatch(/SHOPIFY_CLIENT_ID/)
    expect((error as Error).message).not.toContain(SECRET)

    expect(await token.getAccessToken()).toBe('shpat_ok')
  })

  it('rejects a response without an access_token', async () => {
    stubFetch(() => json({ scope: 'read_orders' }))
    await expect(token.getAccessToken()).rejects.toThrow(/without an access_token/)
  })

  it('reports expiry and scopes without exposing the token', async () => {
    stubFetch(() => json({ access_token: 'shpat_hidden', scope: 'read_orders,read_products', expires_in: 86399 }))
    await token.getAccessToken()

    const status = token.getTokenStatus()
    expect(status).toMatchObject({ mode: 'client_credentials', cached: true, scopes: ['read_orders', 'read_products'] })
    expect(JSON.stringify(status)).not.toContain('shpat_hidden')
  })
})

describe('configuration', () => {
  it('uses the static token, with no token request, when no client credentials are set', async () => {
    vi.stubEnv('SHOPIFY_CLIENT_ID', '')
    vi.stubEnv('SHOPIFY_CLIENT_SECRET', '')
    vi.stubEnv('SHOPIFY_ADMIN_ACCESS_TOKEN', 'shpat_static_test_token')
    stubFetch(() => json({}))

    expect(await token.getAccessToken()).toBe('shpat_static_test_token')
    expect(calls).toHaveLength(0)
  })

  it('prefers client credentials when both are set', async () => {
    vi.stubEnv('SHOPIFY_ADMIN_ACCESS_TOKEN', 'shpat_static_test_token')
    stubFetch(() => json({ access_token: 'shpat_fresh', expires_in: 3600 }))

    expect(await token.getAccessToken()).toBe('shpat_fresh')
  })

  it('names the missing half of a half-configured pair', async () => {
    vi.stubEnv('SHOPIFY_CLIENT_SECRET', '')
    await expect(token.getAccessToken()).rejects.toThrow(/SHOPIFY_CLIENT_SECRET is not set/)
  })
})

describe('adminGraphql with client credentials', () => {
  it('refreshes the token once after a 401 and retries', async () => {
    let issued = 0
    let graphql = 0
    stubFetch((url, init) => {
      if (url === TOKEN_URL) return json({ access_token: `shpat_${++issued}`, expires_in: 86399 })
      graphql += 1
      const sent = (init.headers as Record<string, string>)['X-Shopify-Access-Token']
      return sent === 'shpat_1' ? new Response('Unauthorized', { status: 401 }) : json({ data: { shop: { name: 'ok' } } })
    })

    expect(await client.adminGraphql('{ shop { name } }')).toEqual({ shop: { name: 'ok' } })
    expect(issued).toBe(2)
    expect(graphql).toBe(2)
  })

  it('gives up after one refresh instead of looping on a persistent 401', async () => {
    let issued = 0
    stubFetch((url) =>
      url === TOKEN_URL
        ? json({ access_token: `shpat_${++issued}`, expires_in: 86399 })
        : new Response('Unauthorized', { status: 401 }),
    )

    await expect(client.adminGraphql('{ shop { name } }')).rejects.toThrow(/even after fetching a fresh one/)
    expect(issued).toBe(2)
  })

  it('does not refresh on a 403 - that is a missing scope, not a dead token', async () => {
    let issued = 0
    stubFetch((url) =>
      url === TOKEN_URL
        ? json({ access_token: `shpat_${++issued}`, expires_in: 86399 })
        : new Response('Forbidden', { status: 403 }),
    )

    await expect(client.adminGraphql('{ shop { name } }')).rejects.toThrow()
    expect(issued).toBe(1)
  })
})
