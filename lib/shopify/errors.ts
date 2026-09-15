/**
 * Error types shared by the GraphQL client and the token manager. Kept in their own module
 * so the two can depend on each other's errors without an import cycle.
 */

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'ShopifyApiError'
  }
}

/** The client-credentials exchange failed. Messages never contain the secret or a token. */
export class TokenError extends ShopifyApiError {
  constructor(message: string, status: number) {
    super(message, status)
    this.name = 'TokenError'
  }
}
