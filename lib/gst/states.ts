/**
 * All 36 Indian states / union territories with their GST state codes (the first two
 * digits of a GSTIN). `shopifyProvinceCodes` maps Shopify's ISO-3166-2 province codes
 * onto the same row so an order address can be resolved to a place of supply.
 */
export interface IndianState {
  /** Two-digit GST state code, e.g. "27" for Maharashtra. */
  code: string
  name: string
  /** ISO 3166-2:IN subdivision codes as Shopify reports them in `provinceCode`. */
  shopifyProvinceCodes: string[]
}

export const INDIAN_STATES: readonly IndianState[] = [
  { code: '01', name: 'Jammu and Kashmir', shopifyProvinceCodes: ['JK'] },
  { code: '02', name: 'Himachal Pradesh', shopifyProvinceCodes: ['HP'] },
  { code: '03', name: 'Punjab', shopifyProvinceCodes: ['PB'] },
  { code: '04', name: 'Chandigarh', shopifyProvinceCodes: ['CH'] },
  { code: '05', name: 'Uttarakhand', shopifyProvinceCodes: ['UT', 'UK'] },
  { code: '06', name: 'Haryana', shopifyProvinceCodes: ['HR'] },
  { code: '07', name: 'Delhi', shopifyProvinceCodes: ['DL'] },
  { code: '08', name: 'Rajasthan', shopifyProvinceCodes: ['RJ'] },
  { code: '09', name: 'Uttar Pradesh', shopifyProvinceCodes: ['UP'] },
  { code: '10', name: 'Bihar', shopifyProvinceCodes: ['BR'] },
  { code: '11', name: 'Sikkim', shopifyProvinceCodes: ['SK'] },
  { code: '12', name: 'Arunachal Pradesh', shopifyProvinceCodes: ['AR'] },
  { code: '13', name: 'Nagaland', shopifyProvinceCodes: ['NL'] },
  { code: '14', name: 'Manipur', shopifyProvinceCodes: ['MN'] },
  { code: '15', name: 'Mizoram', shopifyProvinceCodes: ['MZ'] },
  { code: '16', name: 'Tripura', shopifyProvinceCodes: ['TR'] },
  { code: '17', name: 'Meghalaya', shopifyProvinceCodes: ['ML'] },
  { code: '18', name: 'Assam', shopifyProvinceCodes: ['AS'] },
  { code: '19', name: 'West Bengal', shopifyProvinceCodes: ['WB'] },
  { code: '20', name: 'Jharkhand', shopifyProvinceCodes: ['JH'] },
  { code: '21', name: 'Odisha', shopifyProvinceCodes: ['OR', 'OD'] },
  { code: '22', name: 'Chhattisgarh', shopifyProvinceCodes: ['CT', 'CG'] },
  { code: '23', name: 'Madhya Pradesh', shopifyProvinceCodes: ['MP'] },
  { code: '24', name: 'Gujarat', shopifyProvinceCodes: ['GJ'] },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', shopifyProvinceCodes: ['DN', 'DD', 'DH'] },
  { code: '27', name: 'Maharashtra', shopifyProvinceCodes: ['MH'] },
  { code: '29', name: 'Karnataka', shopifyProvinceCodes: ['KA'] },
  { code: '30', name: 'Goa', shopifyProvinceCodes: ['GA'] },
  { code: '31', name: 'Lakshadweep', shopifyProvinceCodes: ['LD'] },
  { code: '32', name: 'Kerala', shopifyProvinceCodes: ['KL'] },
  { code: '33', name: 'Tamil Nadu', shopifyProvinceCodes: ['TN'] },
  { code: '34', name: 'Puducherry', shopifyProvinceCodes: ['PY'] },
  { code: '35', name: 'Andaman and Nicobar Islands', shopifyProvinceCodes: ['AN'] },
  { code: '36', name: 'Telangana', shopifyProvinceCodes: ['TG', 'TS'] },
  { code: '37', name: 'Andhra Pradesh', shopifyProvinceCodes: ['AP'] },
  { code: '38', name: 'Ladakh', shopifyProvinceCodes: ['LA'] },
  { code: '97', name: 'Other Territory', shopifyProvinceCodes: [] },
] as const

const BY_CODE = new Map(INDIAN_STATES.map((s) => [s.code, s]))
const BY_NAME = new Map(INDIAN_STATES.map((s) => [normalize(s.name), s]))
const BY_PROVINCE = new Map<string, IndianState>()
for (const state of INDIAN_STATES) {
  for (const pc of state.shopifyProvinceCodes) BY_PROVINCE.set(pc.toUpperCase(), state)
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '')
}

export function stateByCode(code: string | null | undefined): IndianState | null {
  if (!code) return null
  return BY_CODE.get(code.trim().padStart(2, '0')) ?? null
}

export function stateByName(name: string | null | undefined): IndianState | null {
  if (!name) return null
  return BY_NAME.get(normalize(name)) ?? null
}

/** Resolve a Shopify address (provinceCode preferred, province name as a fallback). */
export function stateFromShopifyAddress(address: {
  provinceCode?: string | null
  province?: string | null
  countryCode?: string | null
} | null | undefined): IndianState | null {
  if (!address) return null
  if (address.countryCode && address.countryCode.toUpperCase() !== 'IN') return null
  if (address.provinceCode) {
    const hit = BY_PROVINCE.get(address.provinceCode.toUpperCase())
    if (hit) return hit
  }
  return stateByName(address.province)
}

/** State code embedded in the first two characters of a GSTIN. */
export function stateFromGstin(gstin: string | null | undefined): IndianState | null {
  if (!gstin || gstin.length < 2) return null
  return stateByCode(gstin.slice(0, 2))
}
