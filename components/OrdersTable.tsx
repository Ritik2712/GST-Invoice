'use client'

import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Link as PolarisLink,
  Modal,
  Pagination,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from '@shopify/polaris'
import React, { useCallback, useEffect, useState } from 'react'

import { formatInr } from '@/lib/gst/money'
import type { OrderRow, OrdersResponse } from '@/lib/order-rows'

type Cursor = { after?: string | null; before?: string | null }

/** The invoice being previewed in the modal. */
type Viewing = { invoiceNumber: string; invoiceKey: string }
/** The invoice the cancellation dialog is about. */
type Cancelling = { invoiceNumber: string; invoiceKey: string; orderName: string }

const PAGE_SIZE = 25

/**
 * Both URLs hit the same route, which only ever replays a stored snapshot - the difference
 * is Content-Disposition. `inline` renders in a viewer, the default downloads.
 */
const inlineUrl = (key: string) => `/api/invoices/${key}/pdf?disposition=inline`
const downloadUrl = (key: string) => `/api/invoices/${key}/pdf`
/** Dry run for an order with no invoice yet - renders, but allots no number. */
const previewUrl = (legacyId: string) => `/api/orders/${legacyId}/invoice/preview`

export function OrdersTable() {
  const [data, setData] = useState<OrdersResponse | null>(null)
  const [cursor, setCursor] = useState<Cursor>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const [cancelling, setCancelling] = useState<Cancelling | null>(null)

  const load = useCallback(async (next: Cursor) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) })
      if (next.after) params.set('after', next.after)
      if (next.before) params.set('before', next.before)

      const response = await fetch(`/api/orders?${params}`, { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Could not load orders')
      setData(body as OrdersResponse)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load orders')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(cursor)
  }, [cursor, load])

  /** Downloads go through a new tab, which the admin iframe sandbox does not block. */
  const handleDownload = useCallback((row: OrderRow) => {
    if (row.invoiceKey) window.open(downloadUrl(row.invoiceKey), '_blank', 'noopener')
  }, [])

  const handleAskCancel = useCallback((row: OrderRow) => {
    if (row.invoiceNumber && row.invoiceKey) {
      setCancelling({
        invoiceNumber: row.invoiceNumber,
        invoiceKey: row.invoiceKey,
        orderName: row.name,
      })
    }
  }, [])

  const handleCancelled = useCallback(
    async (invoiceNumber: string) => {
      setCancelling(null)
      setNotice(
        `Invoice ${invoiceNumber} cancelled. Its number stays used; generating again will issue the next number.`,
      )
      await load(cursor)
    },
    [cursor, load],
  )

  const handlePreview = useCallback((row: OrderRow) => {
    window.open(previewUrl(row.legacyId), '_blank', 'noopener')
  }, [])

  const handleView = useCallback((row: OrderRow) => {
    if (row.invoiceNumber && row.invoiceKey) {
      setViewing({ invoiceNumber: row.invoiceNumber, invoiceKey: row.invoiceKey })
    }
  }, [])

  /**
   * Issuing and rendering are separate requests on purpose: the POST allots the number,
   * the GET only replays the stored snapshot.
   *
   * What happens after issuing is the user's choice (Settings -> "Download immediately
   * after generating"). Off by default: the row simply gains View and Download buttons, so
   * generating never dumps a file in the downloads folder on its own.
   */
  const handleGenerate = useCallback(
    async (row: OrderRow) => {
      setError(null)
      setNotice(null)
      setBusyOrderId(row.id)
      try {
        const response = await fetch(`/api/orders/${row.legacyId}/invoice`, { method: 'POST' })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error ?? 'Could not generate the invoice')

        if (data?.autoDownloadAfterGenerate) {
          window.open(downloadUrl(body.invoiceKey), '_blank', 'noopener')
        }
        setNotice(
          data?.autoDownloadAfterGenerate
            ? `Invoice ${body.invoiceNumber} issued for order ${row.name}. Downloading…`
            : `Invoice ${body.invoiceNumber} issued for order ${row.name}. Use View or Download on that row.`,
        )
        await load(cursor)
      } catch (issueError) {
        setError(issueError instanceof Error ? issueError.message : 'Could not generate the invoice')
      } finally {
        setBusyOrderId(null)
      }
    },
    [cursor, load, data?.autoDownloadAfterGenerate],
  )

  if (loading && !data) {
    return (
      <Card>
        <Box padding="800">
          <InlineStack align="center" gap="300">
            <Spinner size="small" accessibilityLabel="Loading orders" />
            <Text as="span" tone="subdued">
              Loading orders from Shopify…
            </Text>
          </InlineStack>
        </Box>
      </Card>
    )
  }

  return (
    <BlockStack gap="400">
      {error ? (
        <Banner tone="critical" title="Something went wrong" onDismiss={() => setError(null)}>
          <p>{error}</p>
        </Banner>
      ) : null}

      {notice ? (
        <Banner tone="success" onDismiss={() => setNotice(null)}>
          <p>{notice}</p>
        </Banner>
      ) : null}

      {data && !data.settingsComplete ? (
        <Banner tone="warning" title="Seller details are incomplete">
          <p>
            Invoices cannot be issued until the seller details are filled in.{' '}
            <PolarisLink url="/settings">Go to Settings</PolarisLink>.
          </p>
        </Banner>
      ) : null}

      {/* Only when the 60-day limit is real (or scopes are unknown), not on every visit. */}
      {data && data.notices.limitedTo60Days !== false ? (
        <Banner tone="info">
          <p>
            {data.notices.limitedTo60Days ? (
              <>
                Only orders from the last {data.dataWindowDays} days can be shown: the app does not have
                the <code>read_all_orders</code> scope. Add it to the app&rsquo;s scopes to see older orders.
              </>
            ) : (
              <>
                Orders older than {data.dataWindowDays} days are only visible if the app has the{' '}
                <code>read_all_orders</code> scope.
              </>
            )}
          </p>
        </Banner>
      ) : null}

      {/* Only when an order on this page actually has no address to invoice from. */}
      {data && !data.customerDataAvailable && data.notices.ordersWithoutAddress.length > 0 ? (
        <Banner tone="warning" title="Orders with no usable address">
          <p>
            {data.notices.ordersWithoutAddress.join(', ')}{' '}
            {data.notices.ordersWithoutAddress.length === 1 ? 'has' : 'have'} no Indian shipping or billing
            address, so no place of supply can be worked out and{' '}
            {data.notices.ordersWithoutAddress.length === 1 ? 'it cannot' : 'they cannot'} be invoiced. Adding
            the <code>read_customers</code> scope lets the app fall back to the customer&rsquo;s saved address.
          </p>
        </Banner>
      ) : null}

      {/* With no data at all (a failed load) the banner above is the whole story. */}
      {data ? (
      <Card padding="0">
        {data.rows.length === 0 ? (
          <EmptyState
            heading="No orders in the last 60 days"
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>Orders placed in your store will show up here once they are paid.</p>
          </EmptyState>
        ) : (
          <IndexTable
            resourceName={{ singular: 'order', plural: 'orders' }}
            itemCount={data?.rows.length ?? 0}
            selectable={false}
            loading={loading}
            headings={[
              { title: 'Order' },
              { title: 'Date' },
              { title: 'Customer' },
              { title: 'Place of supply' },
              { title: 'Total', alignment: 'end' },
              { title: 'Invoice' },
              { title: '' },
            ]}
          >
            {(data?.rows ?? []).map((row, index) => (
              <IndexTable.Row id={row.id} key={row.id} position={index}>
                <IndexTable.Cell>
                  <InlineStack gap="150" blockAlign="center">
                    <Text as="span" fontWeight="semibold">
                      {row.name}
                    </Text>
                    {row.isTest && <Badge tone="attention">Test</Badge>}
                  </InlineStack>
                </IndexTable.Cell>
                <IndexTable.Cell>{row.displayDate}</IndexTable.Cell>
                <IndexTable.Cell>{row.customerName}</IndexTable.Cell>
                <IndexTable.Cell>
                  {row.placeOfSupply ? (
                    `${row.placeOfSupply.name} (${row.placeOfSupply.code})`
                  ) : (
                    <Text as="span" tone="subdued">
                      Not in India
                    </Text>
                  )}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" alignment="end" numeric>
                    {formatInr(row.total)}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <InvoiceStatus row={row} />
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <RowActions
                    row={row}
                    busy={busyOrderId === row.id}
                    onView={handleView}
                    onDownload={handleDownload}
                    onGenerate={handleGenerate}
                    onPreview={handlePreview}
                    onAskCancel={handleAskCancel}
                  />
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
      </Card>
      ) : null}

      {data && (data.pageInfo.hasNextPage || data.pageInfo.hasPreviousPage) ? (
        <InlineStack align="center">
          <Pagination
            hasPrevious={data.pageInfo.hasPreviousPage}
            onPrevious={() => setCursor({ before: data.pageInfo.startCursor })}
            hasNext={data.pageInfo.hasNextPage}
            onNext={() => setCursor({ after: data.pageInfo.endCursor })}
          />
        </InlineStack>
      ) : null}

      {viewing ? <InvoiceViewer viewing={viewing} onClose={() => setViewing(null)} /> : null}

      {cancelling ? (
        <CancelInvoiceDialog
          cancelling={cancelling}
          onClose={() => setCancelling(null)}
          onCancelled={handleCancelled}
          onError={setError}
        />
      ) : null}
    </BlockStack>
  )
}

function InvoiceStatus({ row }: { row: OrderRow }) {
  switch (row.invoiceStatus) {
    case 'ISSUED':
      return (
        <BlockStack gap="050">
          <Badge tone="success">Issued</Badge>
          <Text as="span" tone="subdued" variant="bodySm">
            {row.invoiceNumber}
          </Text>
          {row.cancelledInvoices.length > 0 && (
            <Text as="span" tone="subdued" variant="bodySm">
              replaces {row.cancelledInvoices.map((i) => i.invoiceNumber).join(', ')}
            </Text>
          )}
        </BlockStack>
      )
    case 'CANCELLED':
      return (
        <BlockStack gap="050">
          <Badge tone="critical">Cancelled</Badge>
          <Text as="span" tone="subdued" variant="bodySm">
            {row.cancelledInvoices.map((i) => i.invoiceNumber).join(', ')}
          </Text>
        </BlockStack>
      )
    case 'NOT_INVOICED':
      return <Badge tone="attention">Not invoiced</Badge>
    case 'NOT_INVOICEABLE':
      return (
        <Tooltip content={row.blockedReason ?? ''}>
          <Badge>Not invoiceable</Badge>
        </Tooltip>
      )
  }
}

function RowActions({
  row,
  busy,
  onView,
  onDownload,
  onGenerate,
  onPreview,
  onAskCancel,
}: {
  row: OrderRow
  busy: boolean
  onView: (row: OrderRow) => void
  onDownload: (row: OrderRow) => void
  onGenerate: (row: OrderRow) => void
  onPreview: (row: OrderRow) => void
  onAskCancel: (row: OrderRow) => void
}) {
  // A live invoice: view, download, or cancel it and reissue.
  if (row.invoiceKey) {
    return (
      <ButtonGroup variant="segmented">
        <Button onClick={() => onView(row)}>View</Button>
        <Button onClick={() => onDownload(row)}>Download</Button>
        <Tooltip content="Cancel this invoice and issue a corrected one under the next number">
          <Button tone="critical" onClick={() => onAskCancel(row)}>
            Cancel
          </Button>
        </Tooltip>
      </ButtonGroup>
    )
  }

  if (!row.canDownload) {
    return (
      <Tooltip content={row.blockedReason ?? 'Not available'}>
        {/* A disabled button swallows pointer events, so the tooltip wraps a span. */}
        <span>
          <Button disabled>Generate invoice</Button>
        </span>
      </Tooltip>
    )
  }

  return (
    <ButtonGroup>
      {/* Check the rates and the tax split before burning a number that cannot be reused. */}
      <Tooltip content="See the invoice this order would get, without issuing it">
        <Button onClick={() => onPreview(row)}>Preview</Button>
      </Tooltip>
      <Button variant="primary" loading={busy} onClick={() => onGenerate(row)}>
        Generate invoice
      </Button>
    </ButtonGroup>
  )
}

/**
 * Cancellation asks for a reason and states plainly what it does to the numbering, because
 * it cannot be undone: the number stays consumed and the corrected invoice gets a new one.
 */
function CancelInvoiceDialog({
  cancelling,
  onClose,
  onCancelled,
  onError,
}: {
  cancelling: Cancelling
  onClose: () => void
  onCancelled: (invoiceNumber: string) => void
  onError: (message: string) => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      const response = await fetch(`/api/invoices/${cancelling.invoiceKey}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Could not cancel the invoice')
      onCancelled(body.invoiceNumber)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not cancel the invoice')
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Cancel invoice ${cancelling.invoiceNumber}?`}
      primaryAction={{
        content: 'Cancel invoice',
        destructive: true,
        loading: busy,
        disabled: reason.trim().length < 3,
        onAction: submit,
      }}
      secondaryActions={[{ content: 'Keep it', onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <Text as="p">
            Invoice <strong>{cancelling.invoiceNumber}</strong> for order{' '}
            <strong>{cancelling.orderName}</strong> will be marked cancelled. It stays in your
            register and stays downloadable - a cancelled tax invoice still has to be reportable -
            and its number is never reused.
          </Text>
          <Text as="p" tone="subdued">
            The order becomes invoiceable again, so generating afterwards issues a corrected invoice
            under the next number. This cannot be undone.
          </Text>
          <TextField
            label="Reason"
            value={reason}
            onChange={setReason}
            autoComplete="off"
            multiline={2}
            placeholder="e.g. wrong GST rate on the garment line"
            helpText="Stored on the invoice snapshot and printed on the cancelled PDF."
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  )
}

/**
 * In-app PDF viewer. The iframe points at the same snapshot-replay route with an inline
 * disposition; "Open in new tab" is there for browsers that will not render a PDF in a
 * frame at all.
 */
function InvoiceViewer({ viewing, onClose }: { viewing: Viewing; onClose: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title={`Invoice ${viewing.invoiceNumber}`}
      size="large"
      primaryAction={{
        content: 'Download',
        onAction: () => window.open(downloadUrl(viewing.invoiceKey), '_blank', 'noopener'),
      }}
      secondaryActions={[
        {
          content: 'Open in new tab',
          onAction: () => window.open(inlineUrl(viewing.invoiceKey), '_blank', 'noopener'),
        },
        { content: 'Close', onAction: onClose },
      ]}
    >
      <iframe
        src={inlineUrl(viewing.invoiceKey)}
        title={`Invoice ${viewing.invoiceNumber}`}
        style={{ width: '100%', height: '70vh', border: 0, display: 'block' }}
      />
    </Modal>
  )
}
