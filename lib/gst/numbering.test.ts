import { describe, expect, it } from 'vitest'

import { formatInvoiceNumber, invoiceFileKey, validateInvoicePrefix } from './numbering'
import { isValidGstin, panFromGstin } from './gstin'

describe('invoice numbering', () => {
  it('formats <prefix><FY>/<seq>', () => {
    expect(formatInvoiceNumber('AD/', '2026-27', 106)).toBe('AD/26-27/106')
    expect(formatInvoiceNumber('', '2026-27', 1)).toBe('26-27/1')
  })

  it('rejects a non-positive sequence', () => {
    expect(() => formatInvoiceNumber('AD/', '2026-27', 0)).toThrow()
  })

  it('rejects a path-unsafe prefix', () => {
    expect(validateInvoicePrefix('AD/')).toBeNull()
    expect(validateInvoicePrefix('../')).not.toBeNull()
    expect(validateInvoicePrefix('AD$')).not.toBeNull()
  })

  it('produces a file-safe key that is stable when applied twice', () => {
    const key = invoiceFileKey('AD/26-27/106')
    expect(key).toBe('AD_26-27_106')
    expect(invoiceFileKey(key)).toBe(key)
  })
})

describe('GSTIN', () => {
  it('accepts a well-formed GSTIN', () => {
    expect(isValidGstin('27ABCDE1234F1Z5')).toBe(true)
  })

  it('rejects malformed values', () => {
    expect(isValidGstin('27ABCDE1234F1X5')).toBe(false) // 14th char must be Z
    expect(isValidGstin('27ABCDE1234F1Z')).toBe(false) // too short
    expect(isValidGstin('27abcde1234f1z5')).toBe(false) // must be upper case
  })

  it('extracts the PAN', () => {
    expect(panFromGstin('27ABCDE1234F1Z5')).toBe('ABCDE1234F')
  })
})
