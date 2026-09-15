/**
 * Money helpers. Every figure that reaches an invoice is rounded here, so rounding
 * behaviour is defined in exactly one place.
 */

/** Round half-up (away from zero) to `dp` decimals, immune to binary float drift. */
export function round(value: number, dp = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** dp
  const scaled = value * factor
  // 1e-9 absorbs representations like 0.145 * 100 === 14.499999999999998.
  const nudged = scaled >= 0 ? scaled + 1e-9 : scaled - 1e-9
  return Math.sign(nudged) * Math.round(Math.abs(nudged)) / factor
}

export const round2 = (value: number): number => round(value, 2)

/** Sum with rounding applied once at the end. */
export function sum(values: number[]): number {
  return round2(values.reduce((acc, v) => acc + v, 0))
}

export function formatInr(value: number): string {
  const negative = value < 0
  const [whole, fraction] = Math.abs(round2(value)).toFixed(2).split('.')
  // Indian digit grouping: last three digits, then pairs.
  const lastThree = whole.slice(-3)
  const rest = whole.slice(0, -3)
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree
  return `${negative ? '-' : ''}${grouped}.${fraction}`
}
