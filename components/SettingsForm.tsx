'use client'

import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DropZone,
  FormLayout,
  InlineStack,
  Layout,
  Select,
  Spinner,
  Text,
  TextField,
  Thumbnail,
} from '@shopify/polaris'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { shortFinancialYear } from '@/lib/gst/fy'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsErrors } from '@/lib/gst/settings'
import { INDIAN_STATES } from '@/lib/gst/states'

interface SettingsPayload {
  settings: AppSettings
  financialYear: string
  rateTableVersion: number
  deliveryRate?: { rate: number; source: string }
}

export function SettingsForm() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [financialYear, setFinancialYear] = useState('')
  const [rateTableVersion, setRateTableVersion] = useState(0)
  const [deliveryRate, setDeliveryRate] = useState<SettingsPayload['deliveryRate']>()
  const [errors, setErrors] = useState<SettingsErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/settings', { cache: 'no-store' })
        const body = (await response.json()) as SettingsPayload
        if (!response.ok) throw new Error('Could not load settings')
        setSettings(body.settings)
        setFinancialYear(body.financialYear)
        setRateTableVersion(body.rateTableVersion)
        setDeliveryRate(body.deliveryRate)
      } catch {
        setError('Could not load settings')
        setSettings(DEFAULT_SETTINGS)
      }
    })()
  }, [])

  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSaved(false)
    setSettings((previous) => (previous ? { ...previous, [key]: value } : previous))
  }, [])

  const updateBank = useCallback((key: keyof AppSettings['bank'], value: string) => {
    setSaved(false)
    setSettings((previous) =>
      previous ? { ...previous, bank: { ...previous.bank, [key]: value } } : previous,
    )
  }, [])

  const handleSave = useCallback(async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    setErrors({})
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const body = await response.json()
      if (response.status === 422) {
        setErrors(body.errors ?? {})
        setError(body.error ?? 'Some fields need attention')
        return
      }
      if (!response.ok) throw new Error(body.error ?? 'Could not save settings')
      setSettings(body.settings)
      setSaved(true)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save settings')
    } finally {
      setSaving(false)
    }
  }, [settings])

  const handleLogo = useCallback(async (files: File[]) => {
    const file = files[0]
    if (!file) return
    setError(null)
    const form = new FormData()
    form.append('logo', file)
    const response = await fetch('/api/settings/logo', { method: 'POST', body: form })
    const body = await response.json()
    if (!response.ok) {
      setError(body.error ?? 'Could not upload the logo')
      return
    }
    setSettings((previous) => (previous ? { ...previous, logoDataUri: body.logoDataUri } : previous))
  }, [])

  const handleRemoveLogo = useCallback(async () => {
    await fetch('/api/settings/logo', { method: 'DELETE' })
    setSettings((previous) => (previous ? { ...previous, logoDataUri: null } : previous))
  }, [])

  const stateOptions = useMemo(
    () => [
      { label: 'Select a state', value: '' },
      ...INDIAN_STATES.map((state) => ({ label: `${state.name} (${state.code})`, value: state.code })),
    ],
    [],
  )

  /** Any state other than the seller's, so the preview shows the IGST layout. */
  const interStateCode = useMemo(
    () => INDIAN_STATES.find((state) => state.code !== settings?.sellerStateCode)?.code ?? '29',
    [settings?.sellerStateCode],
  )

  const openPreview = useCallback((placeOfSupply?: string) => {
    const query = placeOfSupply ? `?pos=${encodeURIComponent(placeOfSupply)}` : ''
    window.open(`/api/sample-invoice${query}`, '_blank', 'noopener')
  }, [])

  const nextInvoiceNumber = useMemo(() => {
    if (!settings || !financialYear) return ''
    return `${settings.invoicePrefix}${shortFinancialYear(financialYear)}/${settings.lastIssuedNumber + 1}`
  }, [settings, financialYear])

  if (!settings) {
    return (
      <Card>
        <Box padding="800">
          <InlineStack align="center" gap="300">
            <Spinner size="small" accessibilityLabel="Loading settings" />
            <Text as="span" tone="subdued">
              Loading settings…
            </Text>
          </InlineStack>
        </Box>
      </Card>
    )
  }

  return (
    <BlockStack gap="400">
      {error ? (
        <Banner tone="critical" title="Settings not saved" onDismiss={() => setError(null)}>
          <p>{error}</p>
        </Banner>
      ) : null}
      {saved ? (
        <Banner tone="success" onDismiss={() => setSaved(false)}>
          <p>Settings saved.</p>
        </Banner>
      ) : null}

      <Layout>
        <Layout.AnnotatedSection
          title="Seller details"
          description="Printed in the header of every invoice. These are captured into each invoice when it is issued, so later edits never change an invoice that already exists."
        >
          <Card>
            <FormLayout>
              <TextField
                label="Legal business name"
                autoComplete="organization"
                value={settings.legalBusinessName}
                onChange={(value) => update('legalBusinessName', value)}
                error={errors.legalBusinessName}
                requiredIndicator
              />
              <FormLayout.Group>
                <TextField
                  label="GSTIN"
                  autoComplete="off"
                  value={settings.gstin}
                  onChange={(value) => update('gstin', value.toUpperCase())}
                  error={errors.gstin}
                  helpText="15 characters, e.g. 27ABCDE1234F1Z5"
                  maxLength={15}
                  requiredIndicator
                />
                <TextField
                  label="PAN (optional)"
                  autoComplete="off"
                  value={settings.pan}
                  onChange={(value) => update('pan', value.toUpperCase())}
                  error={errors.pan}
                  maxLength={10}
                />
              </FormLayout.Group>
              <Select
                label="Seller state"
                options={stateOptions}
                value={settings.sellerStateCode}
                onChange={(value) => update('sellerStateCode', value)}
                error={errors.sellerStateCode}
                helpText="Decides whether an order is taxed as CGST + SGST or as IGST."
              />
              <TextField
                label="Registered address"
                autoComplete="street-address"
                value={settings.registeredAddress}
                onChange={(value) => update('registeredAddress', value)}
                error={errors.registeredAddress}
                multiline={4}
                requiredIndicator
              />
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Invoice numbering"
          description="The series is independent of Shopify order numbers, is gapless within a financial year, and resets to 1 on 1 April."
        >
          <Card>
            <FormLayout>
              <FormLayout.Group>
                <TextField
                  label="Invoice prefix"
                  autoComplete="off"
                  value={settings.invoicePrefix}
                  onChange={(value) => update('invoicePrefix', value)}
                  error={errors.invoicePrefix}
                  helpText="Letters, digits, / - _"
                />
                <TextField
                  label="Last issued invoice number"
                  type="number"
                  autoComplete="off"
                  value={String(settings.lastIssuedNumber)}
                  onChange={(value) => update('lastIssuedNumber', Number.parseInt(value || '0', 10))}
                  error={errors.lastIssuedNumber}
                  helpText="Edit to start the series mid-year or to correct it. It cannot be moved below a number already issued."
                  min={0}
                />
              </FormLayout.Group>
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" tone="subdued">
                  Financial year {financialYear}. Next invoice will be
                </Text>
                <Badge tone="info">{nextInvoiceNumber}</Badge>
              </InlineStack>
              <Checkbox
                label="Allow invoices for Shopify test orders"
                checked={settings.allowTestOrderInvoices}
                onChange={(value) => update('allowTestOrderInvoices', value)}
                helpText="Off: a test order gets no invoice, so the series is never left with a number against a supply that never happened. Turn it on while trying the app out, and off before you go live."
              />
              <Checkbox
                label="Download immediately after generating"
                checked={settings.autoDownloadAfterGenerate}
                onChange={(value) => update('autoDownloadAfterGenerate', value)}
                helpText="Off: generating only issues the invoice, and the order row's View and Download buttons take over. On: the PDF starts downloading as soon as it is issued."
              />
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Tax configuration"
          description={`Rates come from data/hsn-rates.json (version ${rateTableVersion}). The default HSN below is used when no rule matches.`}
        >
          <Card>
            <FormLayout>
              <Checkbox
                label="Prices in Shopify include GST"
                checked={settings.pricesIncludeGst}
                onChange={(value) => update('pricesIncludeGst', value)}
                helpText="When on, line prices are treated as tax-inclusive and the taxable value is back-calculated."
              />
              <FormLayout.Group>
                <TextField
                  label="Default HSN code"
                  autoComplete="off"
                  value={settings.defaultHsn}
                  onChange={(value) => update('defaultHsn', value)}
                  error={errors.defaultHsn}
                  helpText="4 to 8 digits. Fallback when a product has no HSN tag or metafield."
                  requiredIndicator
                />
                <TextField
                  label="Delivery SAC code (optional)"
                  autoComplete="off"
                  value={settings.shippingHsn}
                  onChange={(value) => update('shippingHsn', value)}
                  error={errors.shippingHsn}
                  helpText="Leave blank to print no HSN/SAC on the delivery line. The delivery rate is unaffected."
                />
              </FormLayout.Group>
              <Select
                label="Delivery charges"
                options={[
                  { label: 'Separate line at the delivery rate', value: 'SEPARATE_SERVICE' },
                  { label: 'Own line, taxed at the goods rate and HSN (composite supply)', value: 'COMPOSITE_LINE' },
                  { label: 'Fold into the goods lines pro rata (no separate line)', value: 'APPORTION' },
                ]}
                value={settings.shippingTreatment}
                onChange={(value) => update('shippingTreatment', value as AppSettings['shippingTreatment'])}
                helpText={
                  settings.shippingTreatment === 'SEPARATE_SERVICE'
                    ? `Delivery is taxed at ${deliveryRate ? `${deliveryRate.rate}%` : 'the delivery rate'}${deliveryRate ? ` (rule "${deliveryRate.source}" in data/hsn-rates.json)` : ''}, split CGST + SGST in-state and IGST out of state.`
                    : 'Delivery borrows the goods rate and HSN, so the SAC field is not used.'
                }
              />
              <TextField
                label="Delivery line label"
                autoComplete="off"
                value={settings.deliveryLineLabel}
                onChange={(value) => update('deliveryLineLabel', value)}
                helpText="Printed as the description of the delivery line. Shopify's shipping rate name is customer-facing copy, so a fixed label is used instead. Leave blank to use the Shopify rate name."
              />
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection title="Bank details" description="Printed at the bottom of the invoice.">
          <Card>
            <FormLayout>
              <FormLayout.Group>
                <TextField
                  label="Bank name"
                  autoComplete="off"
                  value={settings.bank.bankName}
                  onChange={(value) => updateBank('bankName', value)}
                />
                <TextField
                  label="Account name"
                  autoComplete="off"
                  value={settings.bank.accountName}
                  onChange={(value) => updateBank('accountName', value)}
                />
              </FormLayout.Group>
              <FormLayout.Group>
                <TextField
                  label="Account number"
                  autoComplete="off"
                  value={settings.bank.accountNumber}
                  onChange={(value) => updateBank('accountNumber', value)}
                />
                <TextField
                  label="IFSC"
                  autoComplete="off"
                  value={settings.bank.ifsc}
                  onChange={(value) => updateBank('ifsc', value.toUpperCase())}
                  error={errors.bank}
                />
              </FormLayout.Group>
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection title="Terms and logo" description="Optional. The logo is stored with the settings and embedded into the PDF.">
          <Card>
            <FormLayout>
              <TextField
                label="Terms and conditions"
                autoComplete="off"
                value={settings.terms}
                onChange={(value) => update('terms', value)}
                multiline={4}
              />
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Logo
                </Text>
                {settings.logoDataUri ? (
                  <InlineStack gap="300" blockAlign="center">
                    <Thumbnail source={settings.logoDataUri} alt="Invoice logo" size="large" />
                    <Button onClick={handleRemoveLogo} tone="critical" variant="tertiary">
                      Remove logo
                    </Button>
                  </InlineStack>
                ) : (
                  <DropZone accept="image/png,image/jpeg" type="image" allowMultiple={false} onDrop={handleLogo}>
                    <DropZone.FileUpload actionHint="PNG or JPEG, up to 400 KB" />
                  </DropZone>
                )}
              </BlockStack>
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>
        <Layout.AnnotatedSection
          title="Preview"
          description="Renders a made-up order through the real engine and the real invoice template, using your saved settings. No invoice number is allotted and nothing is stored, so you can open it as often as you like."
        >
          <Card>
            <BlockStack gap="300">
              <Text as="p" tone="subdued">
                The preview reads your <strong>saved</strong> settings, so save first to see edits you
                just made.
              </Text>
              <InlineStack gap="300" wrap>
                <Button onClick={() => openPreview()}>Preview in-state invoice (CGST + SGST)</Button>
                <Button onClick={() => openPreview(interStateCode)}>
                  Preview out-of-state invoice (IGST)
                </Button>
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">
                The sample order has a slab-priced apparel line, a line whose rate is pinned by a
                gst:5 product tag, a line that falls through to your default HSN, a discount and
                shipping - so every part of the template shows up.
              </Text>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>
      </Layout>

      <InlineStack align="end">
        <Button variant="primary" loading={saving} onClick={handleSave}>
          Save settings
        </Button>
      </InlineStack>
    </BlockStack>
  )
}
