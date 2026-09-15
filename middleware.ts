import { NextResponse, type NextRequest } from 'next/server'

/**
 * Two jobs:
 *
 * 1. Content-Security-Policy. The Shopify admin embeds the app in an iframe, so
 *    `frame-ancestors` has to name the admin host and the shop. The shop is taken from the
 *    `shop` query parameter when the admin supplies it, falling back to the configured
 *    domain, so the header is correct on the first embedded load.
 *
 * 2. An optional shared-secret gate. `shopify app dev` exposes the app on a public tunnel
 *    URL; setting APP_SHARED_SECRET means a visitor has to present `?k=<secret>` once. The
 *    resulting cookie is Partitioned/SameSite=None so it survives inside the admin iframe
 *    under Chrome's storage partitioning.
 */

const COOKIE_NAME = '__Host-gst_app_key'

export function middleware(request: NextRequest) {
  const secret = process.env.APP_SHARED_SECRET?.trim()

  if (secret) {
    const provided = request.nextUrl.searchParams.get('k')
    const cookie = request.cookies.get(COOKIE_NAME)?.value

    if (provided !== secret && cookie !== secret) {
      return new NextResponse('Not authorised', { status: 401 })
    }

    if (provided === secret && cookie !== secret) {
      const response = withCsp(NextResponse.next(), request)
      response.cookies.set(COOKIE_NAME, secret, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
        // CHIPS: keeps the cookie usable in the third-party admin iframe.
        partitioned: true,
        maxAge: 60 * 60 * 24 * 30,
      })
      return response
    }
  }

  return withCsp(NextResponse.next(), request)
}

function withCsp(response: NextResponse, request: NextRequest): NextResponse {
  const shopParam = request.nextUrl.searchParams.get('shop')
  const configured = process.env.SHOPIFY_SHOP_DOMAIN?.trim()
  const shop = sanitizeShop(shopParam) ?? sanitizeShop(configured)

  // 'self' matters: the in-app invoice viewer frames our own PDF route, and without it the
  // browser would refuse to render the PDF inside the app's own page.
  const ancestors = ["'self'", 'https://admin.shopify.com', shop ? `https://${shop}` : null]
    .filter(Boolean)
    .join(' ')

  response.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors};`)
  return response
}

/** Only ever trust a well-formed *.myshopify.com host in a header. */
function sanitizeShop(value: string | null | undefined): string | null {
  if (!value) return null
  const host = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(host) ? host.toLowerCase() : null
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
