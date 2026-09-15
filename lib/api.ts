import { NextResponse } from 'next/server'

import { ConfigError } from './env'
import { InvoiceError } from './invoice-service'
import { ShopifyApiError } from './shopify/client'
import { StoreError } from './store'

export interface ApiErrorBody {
  error: string
  code: string
}

/**
 * Single place that turns an internal error into a response. Messages are deliberately
 * built from our own error types - a raw exception is never echoed back, so the Admin API
 * token can never leak into a response body through a stack trace.
 */
export function errorResponse(error: unknown): NextResponse<ApiErrorBody> {
  if (error instanceof ConfigError) {
    return NextResponse.json({ error: error.message, code: 'CONFIG' }, { status: 500 })
  }
  if (error instanceof InvoiceError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
  }
  if (error instanceof StoreError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 409 })
  }
  if (error instanceof ShopifyApiError) {
    return NextResponse.json({ error: error.message, code: 'SHOPIFY' }, { status: 502 })
  }

  console.error('[gst-invoice-app] unhandled error:', error)
  return NextResponse.json(
    { error: 'Something went wrong. Check the server logs.', code: 'INTERNAL' },
    { status: 500 },
  )
}

/** `gid://shopify/Order/123` from a numeric id in a route param. */
export function orderGid(id: string): string {
  return `gid://shopify/Order/${id.replace(/\D/g, '')}`
}
