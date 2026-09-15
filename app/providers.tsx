'use client'

import '@shopify/polaris/build/esm/styles.css'
import './globals.css'

import { AppProvider } from '@shopify/polaris'
import en from '@shopify/polaris/locales/en.json'
import Link from 'next/link'
import React from 'react'

/**
 * Polaris renders anchors through this adapter so in-app navigation uses the Next router
 * instead of a full page load (which, inside the admin iframe, would flash the whole app).
 */
const PolarisLink = React.forwardRef<HTMLAnchorElement, Record<string, unknown>>(
  function PolarisLink({ children, url = '', external, ...rest }: any, ref) {
    if (external || /^https?:\/\//.test(url)) {
      return (
        <a href={url} target="_blank" rel="noopener noreferrer" ref={ref} {...rest}>
          {children}
        </a>
      )
    }
    return (
      <Link href={url} ref={ref} {...rest}>
        {children}
      </Link>
    )
  },
)

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider i18n={en} linkComponent={PolarisLink as never}>
      {/* Renders as the app's section nav when embedded; ignored otherwise. */}
      <ui-nav-menu>
        <a href="/orders" rel="home">
          Orders
        </a>
        <a href="/settings">Settings</a>
      </ui-nav-menu>
      {children}
    </AppProvider>
  )
}
