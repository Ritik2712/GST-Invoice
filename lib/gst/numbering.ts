import { shortFinancialYear } from './fy'

/**
 * `<prefix><FY>/<seq>` - e.g. prefix "AD/", FY "2026-27", seq 106 -> "AD/26-27/106".
 * The sequence is per financial year and has nothing to do with the Shopify order
 * number, which appears on the invoice only as a reference field.
 */
export function formatInvoiceNumber(prefix: string, fyKey: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`Invoice sequence must be a positive integer, got ${sequence}`)
  }
  return `${prefix}${shortFinancialYear(fyKey)}/${sequence}`
}

/** Invoice numbers become file names, so reject anything path-unsafe in the prefix. */
export function validateInvoicePrefix(prefix: string): string | null {
  if (prefix.length > 16) return 'Prefix must be 16 characters or fewer'
  if (/[^A-Za-z0-9/\-_]/.test(prefix)) {
    return 'Prefix may only contain letters, digits, "/", "-" and "_"'
  }
  if (prefix.includes('..')) return 'Prefix may not contain ".."'
  return null
}

/** File-system safe key for an invoice number ("AD/26-27/106" -> "AD_26-27_106"). */
export function invoiceFileKey(invoiceNumber: string): string {
  return invoiceNumber.replace(/[^A-Za-z0-9\-_]/g, '_')
}
