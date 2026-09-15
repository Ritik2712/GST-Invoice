'use client'

import { Page } from '@shopify/polaris'
import React from 'react'

import { Nav } from '@/components/Nav'
import { SettingsForm } from '@/components/SettingsForm'

export default function SettingsPage() {
  return (
    <Page title="Settings" subtitle="Seller details and invoice configuration" fullWidth>
      <Nav />
      <div style={{ marginTop: 16 }}>
        <SettingsForm />
      </div>
    </Page>
  )
}
