import { financialYearKeyIst } from './gst/fy'
import { buildInvoice } from './gst/invoice'
import { formatInvoiceNumber } from './gst/numbering'
import { DEFAULT_SETTINGS, isSettingsComplete, type AppSettings } from './gst/settings'
import { INDIAN_STATES, stateByCode } from './gst/states'
import type { InvoiceSnapshot, NormalizedOrder, RateTable } from './gst/types'

/**
 * A fabricated order used to preview the invoice layout. Pure - no store, no Shopify, no
 * counter - so calling it can never allot an invoice number or write a file.
 *
 * The lines are deliberately varied so the preview exercises the parts of the template
 * that a single-product order would not: a value-slab category, a rate pinned by product
 * tag, a line that falls through to the default HSN, a line discount, and shipping.
 */

const SAMPLE_ORDER_ID = 'gid://shopify/Order/0'

/** Stand-in seller details so the preview renders before Settings has been filled in. */
const PLACEHOLDER: Pick<
  AppSettings,
  'legalBusinessName' | 'gstin' | 'sellerStateCode' | 'sellerStateName' | 'registeredAddress' | 'defaultHsn'
> = {
  legalBusinessName: 'Your Business Name (set this in Settings)',
  gstin: '27AAAAA0000A1Z5',
  sellerStateCode: '27',
  sellerStateName: 'Maharashtra',
  registeredAddress: 'Your registered address\nCity, State PIN',
  defaultHsn: '9999',
}

export interface SamplePreviewArgs {
  settings: AppSettings
  rateTable: RateTable
  /** Current counter value, so the preview shows the number the next real invoice gets. */
  lastIssued: number
  /** GST state code for the place of supply. Defaults to the seller state (CGST + SGST). */
  placeOfSupplyStateCode?: string | null
  issuedAt?: Date
}

export interface SamplePreview {
  invoice: InvoiceSnapshot
  /** True when placeholder seller details had to be substituted. */
  usedPlaceholders: boolean
}

export function buildSamplePreview(args: SamplePreviewArgs): SamplePreview {
  const usedPlaceholders = !isSettingsComplete(args.settings)
  const settings = usedPlaceholders ? withPlaceholders(args.settings) : args.settings

  const placeOfSupply =
    stateByCode(args.placeOfSupplyStateCode ?? '')?.code ?? settings.sellerStateCode

  const issuedAt = args.issuedAt ?? new Date()
  const financialYear = financialYearKeyIst(issuedAt)

  const invoice = buildInvoice({
    order: sampleOrder(placeOfSupply),
    settings,
    rateTable: {
      ...args.rateTable,
      fallback: { hsn: settings.defaultHsn || args.rateTable.fallback.hsn, rate: args.rateTable.fallback.rate },
    },
    series: 'REAL',
    invoiceNumber: formatInvoiceNumber(settings.invoicePrefix, financialYear, args.lastIssued + 1),
    financialYear,
    sequence: args.lastIssued + 1,
    issuedAt,
    placeOfSupplyOverride: placeOfSupply,
  })

  return { invoice, usedPlaceholders }
}

/** Only the fields the invoice header needs are substituted; the rest stay as configured. */
function withPlaceholders(settings: AppSettings): AppSettings {
  return {
    ...settings,
    legalBusinessName: settings.legalBusinessName.trim() || PLACEHOLDER.legalBusinessName,
    gstin: settings.gstin.trim() || PLACEHOLDER.gstin,
    sellerStateCode: stateByCode(settings.sellerStateCode)?.code ?? PLACEHOLDER.sellerStateCode,
    sellerStateName: stateByCode(settings.sellerStateCode)?.name ?? PLACEHOLDER.sellerStateName,
    registeredAddress: settings.registeredAddress.trim() || PLACEHOLDER.registeredAddress,
    defaultHsn: settings.defaultHsn.trim() || PLACEHOLDER.defaultHsn,
    invoicePrefix: settings.invoicePrefix.trim() || DEFAULT_SETTINGS.invoicePrefix,
  }
}

export function sampleOrder(placeOfSupplyStateCode: string): NormalizedOrder {
  const state = stateByCode(placeOfSupplyStateCode) ?? INDIAN_STATES[0]

  return {
    id: SAMPLE_ORDER_ID,
    name: '#1042 (sample)',
    orderNumber: 1042,
    createdAt: '2026-09-01T10:00:00Z',
    processedAt: '2026-09-01T10:00:00Z',
    currency: 'INR',
    financialStatus: 'PAID',
    isTest: false,
    cancelledAt: null,
    customerName: 'Sample Customer',
    customerEmail: 'customer@example.com',
    customerPhone: null,
    customerGstin: null,
    shippingAddress: {
      name: 'Sample Customer',
      line1: '4 Example Street',
      line2: 'Near the Landmark',
      city: 'Sample City',
      stateName: state.name,
      stateCode: state.shopifyProvinceCodes[0] ?? undefined,
      pincode: '400001',
      country: 'IN',
    },
    billingAddress: null,
    customerDefaultAddress: null,
    lines: [
      {
        id: 'sample-1',
        title: 'Linen shirt',
        variantTitle: 'M / Ivory',
        sku: 'SHIRT-M-IVY',
        // Matches the seeded apparel slab rule, so the preview shows a slab-priced line.
        productType: 'Apparel',
        vendor: 'Sample Vendor',
        tags: [],
        quantity: 2,
        unitPrice: 1180,
        discount: 100,
      },
      {
        id: 'sample-2',
        title: 'Cotton scarf',
        sku: 'SCARF-01',
        productType: 'Accessories',
        vendor: 'Sample Vendor',
        // Rate pinned by product tag.
        tags: ['gst:5'],
        quantity: 1,
        unitPrice: 590,
        discount: 0,
      },
      {
        id: 'sample-3',
        title: 'Gift box',
        sku: 'GIFT-BOX',
        productType: 'Packaging',
        vendor: 'Sample Vendor',
        // No rule matches, so this line falls through to the default HSN and rate.
        tags: [],
        quantity: 1,
        unitPrice: 250,
        discount: 0,
      },
    ],
    shipping: { amount: 118, discount: 0, title: 'Standard shipping' },
    orderTotal: 3208,
  }
}
