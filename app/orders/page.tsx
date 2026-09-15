'use client'

import { Page } from '@shopify/polaris'
import React from 'react'

import { Nav } from '@/components/Nav'
import { OrdersTable } from '@/components/OrdersTable'

export default function OrdersPage() {
  return (
    <Page title="Orders" subtitle="Generate GST tax invoices from paid Shopify orders" fullWidth>
      <Nav />
      <div style={{ marginTop: 16 }}>
        <OrdersTable />
      </div>
    </Page>
  )
}
