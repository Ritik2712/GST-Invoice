/**
 * Indian financial year helpers. The FY runs 1 April - 31 March and is keyed as
 * "2026-27"; the invoice number renders the short form "26-27".
 */

/** Key for the FY containing `date`, e.g. 2026-04-01 -> "2026-27". */
export function financialYearKey(date: Date): string {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() // 0-based; March === 2
  const startYear = month >= 3 ? year : year - 1
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

/** Short form used inside the invoice number: "2026-27" -> "26-27". */
export function shortFinancialYear(fyKey: string): string {
  const [start, end] = fyKey.split('-')
  return `${start.slice(2)}-${end}`
}

/** Inclusive UTC bounds of a financial year key. */
export function financialYearRange(fyKey: string): { start: Date; end: Date } {
  const startYear = Number(fyKey.split('-')[0])
  return {
    start: new Date(Date.UTC(startYear, 3, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(startYear + 1, 2, 31, 23, 59, 59, 999)),
  }
}

/**
 * Invoice dates are stamped in IST regardless of server timezone, so an order paid at
 * 03:00 IST on 1 April lands in the new FY rather than the previous one.
 */
export const IST_OFFSET_MINUTES = 330

export function toIst(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MINUTES * 60_000)
}

/** FY key for an instant, evaluated in IST. */
export function financialYearKeyIst(date: Date): string {
  return financialYearKey(toIst(date))
}

/** "12-09-2026" - the format printed on the invoice. */
export function formatIstDate(date: Date): string {
  const ist = toIst(date)
  const dd = String(ist.getUTCDate()).padStart(2, '0')
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${ist.getUTCFullYear()}`
}
