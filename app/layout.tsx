import type { Metadata } from 'next'
import Script from 'next/script'
import React from 'react'

import { getPublicConfig } from '@/lib/env'
import { Providers } from './providers'

export const metadata: Metadata = {
  title: 'GST Invoices',
  description: 'GST-compliant tax invoices from Shopify orders',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const { apiKey } = getPublicConfig()

  return (
    <html lang="en">
      <head>
        {/*
          App Bridge is only needed when the app renders inside the Shopify admin iframe,
          which requires a client ID. Without one the app still works standalone in a tab.
        */}
        {apiKey ? (
          <Script
            src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
            data-api-key={apiKey}
            strategy="beforeInteractive"
          />
        ) : null}
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
