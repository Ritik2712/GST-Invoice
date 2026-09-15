import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer'
import React from 'react'

import type { InvoiceSnapshot } from '../gst/types'
import { InvoiceDocument } from './InvoiceDocument'

export interface RenderOptions {
  /** Diagonal stamp, e.g. "SAMPLE" for the preview route. */
  watermark?: string | null
}

/** Renders a stored snapshot to PDF bytes. Pure with respect to the snapshot. */
export async function renderInvoicePdf(
  invoice: InvoiceSnapshot,
  options: RenderOptions = {},
): Promise<Buffer> {
  // InvoiceDocument returns a <Document>, but its own props type is the invoice, so the
  // element has to be re-typed for renderToBuffer's DocumentProps signature.
  const element = React.createElement(InvoiceDocument, {
    invoice,
    watermark: options.watermark,
  }) as React.ReactElement<DocumentProps>
  return renderToBuffer(element)
}

/** `AD_26-27_106.pdf` - safe as a Content-Disposition filename. */
export function pdfFileName(invoice: InvoiceSnapshot): string {
  return `${invoice.invoiceNumber.replace(/[^A-Za-z0-9\-_]/g, '_')}.pdf`
}
