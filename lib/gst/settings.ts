import { isValidGstin, isValidPan } from './gstin'
import { validateInvoicePrefix } from './numbering'
import { stateByCode } from './states'

export interface BankDetails {
  bankName: string
  accountName: string
  accountNumber: string
  ifsc: string
}

export interface AppSettings {
  legalBusinessName: string
  gstin: string
  sellerStateCode: string
  sellerStateName: string
  registeredAddress: string
  pan: string
  invoicePrefix: string
  /** Mirrors counter.json for display; edits here rewrite the counter for the current FY. */
  lastIssuedNumber: number
  pricesIncludeGst: boolean
  /**
   * When on, generating an invoice starts the download straight away. When off (the
   * default) generating only issues it, and the row's View / Download buttons take over -
   * so a mis-click never dumps a file in your downloads folder.
   */
  autoDownloadAfterGenerate: boolean
  /**
   * Off by default: a Shopify test order gets no invoice, because burning a number on a
   * supply that never happened leaves a hole in a series that has to be gapless. Turn it
   * on deliberately while trying the app out, and turn it off before going live.
   */
  allowTestOrderInvoices: boolean
  defaultHsn: string
  bank: BankDetails
  terms: string
  /** Data URI of the uploaded logo, or null. Stored inline so there is no asset pipeline. */
  logoDataUri: string | null
  /**
   * How delivery charges are taxed.
   *
   *  SEPARATE_SERVICE - (default) delivery is its own line, taxed at the rate of the
   *                     SHIPPING rule in the rate table (18%), printed with the code in
   *                     `shippingHsn` - or with no code when that is blank.
   *  COMPOSITE_LINE   - its own line, but taxed at the rate and under the HSN of the
   *                     predominant goods line (composite-supply reading).
   *  APPORTION        - no line: freight is folded into the goods lines pro rata, each
   *                     slice at its own line's rate.
   */
  shippingTreatment: 'APPORTION' | 'COMPOSITE_LINE' | 'SEPARATE_SERVICE'
  /**
   * Code printed on a separately-taxed delivery line. Blank (the default) prints none; the
   * rate still comes from the rate table.
   */
  shippingHsn: string
  /**
   * What the delivery line is called on the invoice. Shopify's shipping *rate* name is
   * customer-facing marketing copy ("Free over 999", or worse) and has no place on a tax
   * document, so a fixed label is used instead. Leave blank to fall back to whatever
   * Shopify called the rate.
   */
  deliveryLineLabel: string
  invoiceTitle: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  legalBusinessName: '',
  gstin: '',
  sellerStateCode: '',
  sellerStateName: '',
  registeredAddress: '',
  pan: '',
  invoicePrefix: 'INV/',
  lastIssuedNumber: 0,
  pricesIncludeGst: true,
  autoDownloadAfterGenerate: false,
  allowTestOrderInvoices: false,
  defaultHsn: '',
  bank: { bankName: '', accountName: '', accountNumber: '', ifsc: '' },
  terms: '',
  logoDataUri: null,
  shippingTreatment: 'SEPARATE_SERVICE',
  shippingHsn: '',
  deliveryLineLabel: 'Delivery charges',
  invoiceTitle: 'INVOICE RECEIPT',
}

export type SettingsErrors = Partial<Record<keyof AppSettings, string>>

/** Field-level validation shared by the API route and the Settings form. */
export function validateSettings(settings: AppSettings): SettingsErrors {
  const errors: SettingsErrors = {}

  if (!settings.legalBusinessName.trim()) errors.legalBusinessName = 'Legal business name is required'
  if (!isValidGstin(settings.gstin.trim().toUpperCase())) {
    errors.gstin = 'Enter a valid 15-character GSTIN, e.g. 27ABCDE1234F1Z5'
  }
  if (!stateByCode(settings.sellerStateCode)) errors.sellerStateCode = 'Select the seller state'
  if (!settings.registeredAddress.trim()) errors.registeredAddress = 'Registered address is required'
  if (settings.pan.trim() && !isValidPan(settings.pan.trim().toUpperCase())) {
    errors.pan = 'PAN must look like ABCDE1234F'
  }

  const prefixError = validateInvoicePrefix(settings.invoicePrefix)
  if (prefixError) errors.invoicePrefix = prefixError

  if (!Number.isInteger(settings.lastIssuedNumber) || settings.lastIssuedNumber < 0) {
    errors.lastIssuedNumber = 'Last issued number must be zero or a positive whole number'
  }
  if (!/^\d{4,8}$/.test(settings.defaultHsn.trim())) {
    errors.defaultHsn = 'Default HSN must be 4 to 8 digits'
  }
  // Optional: blank prints no code on the delivery line. If given, it must look like a code.
  if (settings.shippingHsn.trim() && !/^\d{4,8}$/.test(settings.shippingHsn.trim())) {
    errors.shippingHsn = 'Leave blank for no code, or enter 4 to 8 digits'
  }
  if (settings.bank.ifsc.trim() && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(settings.bank.ifsc.trim().toUpperCase())) {
    errors.bank = 'IFSC must look like HDFC0001234'
  }

  // A GSTIN encodes its own state; a mismatch would produce wrong CGST/SGST vs IGST splits.
  if (!errors.gstin && !errors.sellerStateCode) {
    if (settings.gstin.slice(0, 2) !== settings.sellerStateCode) {
      errors.sellerStateCode = `GSTIN starts with ${settings.gstin.slice(0, 2)}, which is a different state`
    }
  }

  return errors
}

export function hasErrors(errors: SettingsErrors): boolean {
  return Object.keys(errors).length > 0
}

/** Settings complete enough to issue an invoice from. */
export function isSettingsComplete(settings: AppSettings): boolean {
  return !hasErrors(validateSettings(settings))
}
