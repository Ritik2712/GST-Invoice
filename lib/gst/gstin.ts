export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/

export function isValidGstin(value: string): boolean {
  return GSTIN_PATTERN.test(value)
}

/** PAN is characters 3-12 of a GSTIN. */
export function panFromGstin(gstin: string): string | null {
  return isValidGstin(gstin) ? gstin.slice(2, 12) : null
}

export const PAN_PATTERN = /^[A-Z]{5}\d{4}[A-Z]$/

export function isValidPan(value: string): boolean {
  return PAN_PATTERN.test(value)
}
