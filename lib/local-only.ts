/**
 * "View updated" rebuilds an issued invoice from live Shopify data and renders it under the
 * number it already has. That is useful while working on the calculation and a hazard
 * anywhere else: two PDFs carrying the same invoice number, with different figures, is
 * exactly what a tax invoice number is supposed to rule out.
 *
 * So it exists on this machine and nowhere else. Both the button and the route that serves
 * it ask the same question, because a hidden button is not a control - the query parameter
 * is still there for anyone who types it.
 *
 * Isomorphic on purpose: the client passes `window.location.hostname`, the route passes the
 * hostname of the request it received.
 */

/** True for the machine the app is running on, including an IPv6 or dotted-suffix spelling. */
export function isLocalHostname(hostname: string | null | undefined): boolean {
  if (!hostname) return false
  // A URL keeps an IPv6 host in brackets; the bare address is what we want to compare.
  const host = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost')
  )
}

/**
 * Whether the refresh preview is available at all.
 *
 * `next dev` counts even when it is reached through a tunnel, which is how the app gets
 * loaded inside the Shopify admin while developing. Every deployment is a production build,
 * so no deployed environment - dev, preview or live - can satisfy either arm of this.
 */
export function allowsRefreshPreview(hostname: string | null | undefined): boolean {
  return process.env.NODE_ENV === 'development' || isLocalHostname(hostname)
}
