import { describe, expect, it } from 'vitest'

import { normalizeHsCode } from './products'

describe('normalizeHsCode', () => {
  it('accepts a plain 8-digit HSN', () => {
    expect(normalizeHsCode('61091000')).toBe('61091000')
  })

  it('accepts the international 6-digit heading', () => {
    expect(normalizeHsCode('610910')).toBe('610910')
  })

  it('strips separators Shopify allows in an HS code', () => {
    expect(normalizeHsCode('6109.10')).toBe('610910')
    expect(normalizeHsCode('6205 20 00')).toBe('62052000')
  })

  it('trims anything longer than 8 digits', () => {
    // Indian 8-digit HSN is the 6-digit heading plus two national digits, so the leading
    // eight are the meaningful ones.
    expect(normalizeHsCode('6109.10.0090')).toBe('61091000')
  })

  it('rejects a value too short to be an HSN', () => {
    expect(normalizeHsCode('610')).toBeNull()
    expect(normalizeHsCode('')).toBeNull()
    expect(normalizeHsCode(null)).toBeNull()
    expect(normalizeHsCode('abc')).toBeNull()
  })
})
