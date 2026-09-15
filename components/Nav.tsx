'use client'

import { Tabs } from '@shopify/polaris'
import { usePathname, useRouter } from 'next/navigation'
import React from 'react'

const TABS = [
  { id: 'orders', content: 'Orders', href: '/orders' },
  { id: 'settings', content: 'Settings', href: '/settings' },
]

/** Two-screen app, so navigation is just two tabs. */
export function Nav() {
  const pathname = usePathname()
  const router = useRouter()
  const selected = Math.max(
    TABS.findIndex((tab) => pathname.startsWith(tab.href)),
    0,
  )

  return (
    <Tabs
      tabs={TABS.map(({ id, content }) => ({ id, content }))}
      selected={selected}
      onSelect={(index) => router.push(TABS[index].href)}
      fitted
    />
  )
}
