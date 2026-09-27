import { afterEach, describe, expect, it, vi } from 'vitest'

import { allowsRefreshPreview, isLocalHostname } from './local-only'

describe('isLocalHostname', () => {
  it('recognises this machine however it is spelled', () => {
    for (const host of ['localhost', 'LOCALHOST', ' localhost ', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'app.localhost']) {
      expect(isLocalHostname(host), host).toBe(true)
    }
  })

  it('is false for anything reachable from outside', () => {
    for (const host of [
      'gst-invoice-app.vercel.app',
      'gst-invoice-app-git-dev.vercel.app',
      'k1gra1-db.myshopify.com',
      'notlocalhost.com',
      // A domain that merely ends in the word, without the dot, is somebody else's.
      'mylocalhost',
      '192.168.1.14',
      '',
      null,
      undefined,
    ]) {
      expect(isLocalHostname(host), String(host)).toBe(false)
    }
  })
})

describe('allowsRefreshPreview', () => {
  const nodeEnv = process.env.NODE_ENV
  afterEach(() => vi.stubEnv('NODE_ENV', nodeEnv as string))

  it('allows it on a dev server even behind a tunnel, which is how Shopify loads the app', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(allowsRefreshPreview('some-tunnel.trycloudflare.com')).toBe(true)
  })

  it('allows it for a production build served on this machine', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(allowsRefreshPreview('localhost')).toBe(true)
  })

  it('refuses it on a deployment, which is always a production build', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(allowsRefreshPreview('gst-invoice-app-git-dev.vercel.app')).toBe(false)
    expect(allowsRefreshPreview('gst-invoice-app.vercel.app')).toBe(false)
  })
})
