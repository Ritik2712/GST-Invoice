import { describe, expect, it } from 'vitest'

import { financialYearKey, financialYearKeyIst, formatIstDate, shortFinancialYear } from './fy'

describe('financial year', () => {
  it('starts on 1 April', () => {
    expect(financialYearKey(new Date('2026-04-01T00:00:00Z'))).toBe('2026-27')
    expect(financialYearKey(new Date('2027-03-31T23:59:59Z'))).toBe('2026-27')
    expect(financialYearKey(new Date('2027-04-01T00:00:00Z'))).toBe('2027-28')
  })

  it('puts a March date in the previous FY', () => {
    expect(financialYearKey(new Date('2026-03-15T00:00:00Z'))).toBe('2025-26')
  })

  it('renders the short form used in invoice numbers', () => {
    expect(shortFinancialYear('2026-27')).toBe('26-27')
    expect(shortFinancialYear('2009-10')).toBe('09-10')
  })

  it('evaluates the FY in IST, not UTC', () => {
    // 31 March 2027, 20:00 UTC is already 1 April 01:30 IST.
    expect(financialYearKey(new Date('2027-03-31T20:00:00Z'))).toBe('2026-27')
    expect(financialYearKeyIst(new Date('2027-03-31T20:00:00Z'))).toBe('2027-28')
  })

  it('formats invoice dates in IST', () => {
    expect(formatIstDate(new Date('2026-09-12T19:00:00Z'))).toBe('13-09-2026')
  })
})
