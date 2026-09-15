import { adminGraphql } from './client'

/**
 * Product reads, used by the catalogue audit. Separate from orders because the audit cares
 * about variant prices (they decide which rate slab a garment falls in) rather than about
 * what was actually sold.
 */

const PRODUCTS_QUERY = /* GraphQL */ `
  query Products($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: TITLE) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        productType
        vendor
        tags
        status
        hsnMetafield: metafield(namespace: "custom", key: "hsn") {
          value
        }
        variants(first: 50) {
          nodes {
            id
            title
            sku
            price
            inventoryItem {
              harmonizedSystemCode
            }
          }
        }
      }
    }
  }
`

const PRODUCT_DETAIL_FIELDS = /* GraphQL */ `
  fragment ProductDetail on Product {
    id
    legacyResourceId
    title
    handle
    description
    productType
    vendor
    tags
    status
    totalInventory
    createdAt
    updatedAt
    onlineStoreUrl
    featuredImage {
      url
      altText
    }
    hsnMetafield: metafield(namespace: "custom", key: "hsn") {
      value
    }
    variants(first: 100) {
      nodes {
        id
        title
        sku
        barcode
        price
        compareAtPrice
        inventoryQuantity
        inventoryItem {
          harmonizedSystemCode
        }
        selectedOptions {
          name
          value
        }
      }
    }
  }
`

const PRODUCT_BY_ID_QUERY = /* GraphQL */ `
  ${PRODUCT_DETAIL_FIELDS}
  query Product($id: ID!) {
    product(id: $id) {
      ...ProductDetail
    }
  }
`

/** Handle lookup goes through search: `product(handle:)` is not available on every version. */
const PRODUCT_BY_HANDLE_QUERY = /* GraphQL */ `
  ${PRODUCT_DETAIL_FIELDS}
  query ProductByHandle($query: String!) {
    products(first: 1, query: $query) {
      nodes {
        ...ProductDetail
      }
    }
  }
`

export interface ShopifyVariant {
  id: string
  title: string
  sku: string | null
  price: number
  /**
   * Shopify's native per-variant HS code (Inventory -> Harmonized System code). The most
   * specific HSN source there is, and the one a merchant actually maintains.
   */
  harmonizedSystemCode?: string | null
  barcode?: string | null
  compareAtPrice?: number | null
  inventoryQuantity?: number | null
  options?: Array<{ name: string; value: string }>
}

export interface ShopifyProductDetail extends ShopifyProduct {
  legacyId: string
  description: string
  totalInventory: number | null
  createdAt: string
  updatedAt: string
  onlineStoreUrl: string | null
  featuredImage: { url: string; altText: string | null } | null
}

export interface ShopifyProduct {
  id: string
  title: string
  handle: string
  productType: string | null
  vendor: string | null
  tags: string[]
  status: string
  /** `custom.hsn` metafield, if the store defines one. */
  hsnMetafield: string | null
  variants: ShopifyVariant[]
}

export interface ProductsPage {
  products: ShopifyProduct[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

/**
 * HS codes arrive as anything from "6109" to "6109.10.00". GST wants 4 to 8 digits, so
 * separators are stripped and anything longer than 8 is cut to 8 - the Indian 8-digit HSN
 * is the international 6-digit heading plus two national digits, so the leading 8 are the
 * meaningful ones.
 */
export function normalizeHsCode(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '')
  if (digits.length < 4) return null
  return digits.slice(0, 8)
}

interface RawProduct {
  id: string
  title: string
  handle: string
  productType?: string | null
  vendor?: string | null
  tags?: string[] | null
  status?: string | null
  hsnMetafield?: { value?: string | null } | null
  variants: {
    nodes: Array<{
      id: string
      title?: string | null
      sku?: string | null
      price: string
      inventoryItem?: { harmonizedSystemCode?: string | null } | null
    }>
  }
}

export async function fetchProducts(options: {
  first?: number
  after?: string | null
  query?: string | null
} = {}): Promise<ProductsPage> {
  const first = Math.min(Math.max(options.first ?? 50, 1), 250)

  const data = await adminGraphql<{
    products: { pageInfo: ProductsPage['pageInfo']; nodes: RawProduct[] }
  }>(PRODUCTS_QUERY, { first, after: options.after ?? null, query: options.query || null })

  return {
    pageInfo: data.products.pageInfo,
    products: data.products.nodes.map((raw) => ({
      id: raw.id,
      title: raw.title,
      handle: raw.handle,
      productType: raw.productType || null,
      vendor: raw.vendor || null,
      tags: raw.tags ?? [],
      status: raw.status ?? 'UNKNOWN',
      hsnMetafield: raw.hsnMetafield?.value?.trim() || null,
      variants: raw.variants.nodes.map((v) => ({
        id: v.id,
        title: v.title || 'Default',
        sku: v.sku || null,
        price: Number.parseFloat(v.price) || 0,
        harmonizedSystemCode: normalizeHsCode(v.inventoryItem?.harmonizedSystemCode),
      })),
    })),
  }
}

interface RawProductDetail extends RawProduct {
  legacyResourceId: string
  description?: string | null
  totalInventory?: number | null
  createdAt: string
  updatedAt: string
  onlineStoreUrl?: string | null
  featuredImage?: { url: string; altText?: string | null } | null
  variants: {
    nodes: Array<{
      id: string
      title?: string | null
      sku?: string | null
      barcode?: string | null
      price: string
      compareAtPrice?: string | null
      inventoryQuantity?: number | null
      inventoryItem?: { harmonizedSystemCode?: string | null } | null
      selectedOptions?: Array<{ name: string; value: string }> | null
    }>
  }
}

function money(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toDetail(raw: RawProductDetail): ShopifyProductDetail {
  return {
    id: raw.id,
    legacyId: raw.legacyResourceId,
    title: raw.title,
    handle: raw.handle,
    description: (raw.description ?? '').trim(),
    productType: raw.productType || null,
    vendor: raw.vendor || null,
    tags: raw.tags ?? [],
    status: raw.status ?? 'UNKNOWN',
    totalInventory: raw.totalInventory ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    onlineStoreUrl: raw.onlineStoreUrl ?? null,
    featuredImage: raw.featuredImage
      ? { url: raw.featuredImage.url, altText: raw.featuredImage.altText ?? null }
      : null,
    hsnMetafield: raw.hsnMetafield?.value?.trim() || null,
    variants: raw.variants.nodes.map((v) => ({
      id: v.id,
      title: v.title || 'Default',
      sku: v.sku || null,
      barcode: v.barcode || null,
      price: money(v.price) ?? 0,
      compareAtPrice: money(v.compareAtPrice),
      inventoryQuantity: v.inventoryQuantity ?? null,
      harmonizedSystemCode: normalizeHsCode(v.inventoryItem?.harmonizedSystemCode),
      options: v.selectedOptions ?? [],
    })),
  }
}

/**
 * One product, by numeric id, GID or handle. Handles are accepted because they are what a
 * product URL exposes, and they are easier to type than a 13-digit id.
 */
export async function fetchProduct(idOrHandle: string): Promise<ShopifyProductDetail | null> {
  const trimmed = idOrHandle.trim()
  const numeric = trimmed.replace(/\D/g, '')
  const looksLikeId = /^gid:\/\/shopify\/Product\/\d+$/.test(trimmed) || /^\d+$/.test(trimmed)

  if (looksLikeId && numeric) {
    const data = await adminGraphql<{ product: RawProductDetail | null }>(PRODUCT_BY_ID_QUERY, {
      id: `gid://shopify/Product/${numeric}`,
    })
    
    return data.product ? toDetail(data.product) : null
  }

  const data = await adminGraphql<{ products: { nodes: RawProductDetail[] } }>(
    PRODUCT_BY_HANDLE_QUERY,
    { query: `handle:${JSON.stringify(trimmed)}` },
  )
  return data.products.nodes[0] ? toDetail(data.products.nodes[0]) : null
}
