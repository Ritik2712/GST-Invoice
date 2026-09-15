import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Which backend the facade picks, and the refusal to use files where they cannot work. */

let store: typeof import('./store')

beforeEach(async () => {
  vi.resetModules()
  store = await import('./store')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('storage selection', () => {
  it('uses JSON files when no MongoDB URI is set', () => {
    vi.stubEnv('MONGODB_URI', '')
    expect(store.storageMode()).toBe('file')
  })

  it('uses MongoDB when a URI is set', () => {
    vi.stubEnv('MONGODB_URI', 'mongodb://127.0.0.1:27017')
    expect(store.storageMode()).toBe('mongodb')
  })

  it('refuses file storage on Vercel instead of failing on the first write', async () => {
    vi.stubEnv('MONGODB_URI', '')
    vi.stubEnv('VERCEL', '1')
    await expect(store.getSettings()).rejects.toThrow(/MONGODB_URI is not set/)
    await expect(store.checkStorage()).resolves.toMatchObject({ mode: 'file', ok: false })
  })
})
