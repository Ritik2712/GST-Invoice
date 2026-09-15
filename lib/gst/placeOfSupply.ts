import { stateByCode, stateFromGstin, stateFromShopifyAddress, type IndianState } from './states'
import type { NormalizedOrder, PartyAddress } from './types'

export interface PlaceOfSupply {
  stateCode: string
  stateName: string
  /** Which input decided it - printed nowhere, stored for auditability. */
  source: string
}

function toShopifyish(address: PartyAddress | null | undefined) {
  if (!address) return null
  return {
    provinceCode: address.stateCode ?? null,
    province: address.stateName ?? null,
    countryCode: address.country ?? 'IN',
  }
}

/**
 * Place of supply for goods: the address where the goods are delivered. Shipping address
 * first, then billing, then the customer's default address. If the buyer supplied a GSTIN
 * its embedded state code is used as a last resort before giving up.
 *
 * `sellerState` is *not* used as a fallback: silently invoicing everything as intra-state
 * would under-collect IGST, so an unresolvable address is surfaced as an error instead.
 */
export function resolvePlaceOfSupply(order: NormalizedOrder): PlaceOfSupply | null {
  const candidates: Array<[string, IndianState | null]> = [
    ['shipping-address', stateFromShopifyAddress(toShopifyish(order.shippingAddress))],
    ['billing-address', stateFromShopifyAddress(toShopifyish(order.billingAddress))],
    ['customer-default-address', stateFromShopifyAddress(toShopifyish(order.customerDefaultAddress))],
    ['buyer-gstin', stateFromGstin(order.customerGstin)],
  ]

  for (const [source, state] of candidates) {
    if (state) return { stateCode: state.code, stateName: state.name, source }
  }
  return null
}

/** Manual override from the UI, validated against the state table. */
export function placeOfSupplyFromCode(code: string): PlaceOfSupply | null {
  const state = stateByCode(code)
  return state ? { stateCode: state.code, stateName: state.name, source: 'manual-override' } : null
}
