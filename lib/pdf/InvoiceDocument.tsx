import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";
import React from "react";

import { formatAddress } from "../gst/invoice";
import { formatInr, round2 } from "../gst/money";
import type { InvoiceSnapshot } from "../gst/types";

/**
 * Rendered from the stored snapshot only - this component never reads settings, the rate
 * table or Shopify, which is what makes a re-download byte-for-byte reproducible.
 *
 * Fonts are the PDF built-ins (Helvetica), so there is no network fetch at render time.
 * Those have no rupee glyph, hence "Rs." rather than the symbol.
 */

const styles = StyleSheet.create({
  page: {
    padding: 28,
    fontSize: 8.5,
    fontFamily: "Helvetica",
    color: "#111827",
  },
  row: { flexDirection: "row" },
  spaceBetween: { flexDirection: "row", justifyContent: "space-between" },
  title: {
    fontSize: 14,
    fontFamily: "Helvetica-Bold",
    textAlign: "center",
    marginBottom: 8,
    letterSpacing: 1,
  },
  sellerName: { fontSize: 12, fontFamily: "Helvetica-Bold" },
  muted: { color: "#6b7280" },
  bold: { fontFamily: "Helvetica-Bold" },
  box: { borderWidth: 0.7, borderColor: "#9ca3af", borderStyle: "solid" },
  headerBox: {
    padding: 8,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  logo: { width: 70, height: 46, objectFit: "contain" },
  metaCell: {
    flex: 1,
    padding: 6,
    borderRightWidth: 0.7,
    borderColor: "#9ca3af",
    borderStyle: "solid",
  },
  metaLabel: {
    fontSize: 7,
    color: "#6b7280",
    marginBottom: 1.5,
    textTransform: "uppercase",
  },
  partyCell: {
    flex: 1,
    padding: 8,
    borderRightWidth: 0.7,
    borderColor: "#9ca3af",
    borderStyle: "solid",
  },
  sectionLabel: {
    fontSize: 7,
    color: "#6b7280",
    marginBottom: 3,
    textTransform: "uppercase",
  },
  th: {
    fontFamily: "Helvetica-Bold",
    fontSize: 7.5,
    padding: 4,
    backgroundColor: "#f3f4f6",
  },
  td: { padding: 4, fontSize: 8 },
  hsnTotalRow: { borderTopWidth: 0.5, borderTopColor: "#d0d0d0", marginTop: 2, paddingTop: 2 },
  cellBorder: {
    borderRightWidth: 0.7,
    borderColor: "#9ca3af",
    borderStyle: "solid",
  },
  rowBorder: {
    borderBottomWidth: 0.7,
    borderColor: "#9ca3af",
    borderStyle: "solid",
  },
  right: { textAlign: "right" },
  center: { textAlign: "center" },
  totalsLabel: { flex: 1, padding: 3, textAlign: "right" },
  totalsValue: { width: 90, padding: 3, textAlign: "right" },
  watermark: {
    position: "absolute",
    top: 300,
    left: 90,
    fontSize: 62,
    fontFamily: "Helvetica-Bold",
    transform: "rotate(-24deg)",
  },
  footer: {
    position: "absolute",
    bottom: 18,
    left: 28,
    right: 28,
    fontSize: 7,
    color: "#6b7280",
    textAlign: "center",
  },
});

// Column widths for the line-item table, intra-state vs inter-state.
const COLS = {
  sn: 22,
  hsn: 46,
  qty: 30,
  rate: 46,
  discount: 50,
  taxable: 54,
  taxPair: 42,
  taxSingle: 62,
  total: 58,
};

/**
 * Widths for an order with nothing discounted. The Discount column is dropped rather than
 * printed full of dashes, and the space it held goes back to the figures and the description.
 */
const COLS_NO_DISCOUNT = {
  ...COLS,
  rate: 52,
  taxable: 58,
  taxPair: 46,
  total: 62,
};

export interface InvoiceDocumentProps {
  invoice: InvoiceSnapshot;
  /**
   * Diagonal stamp across the page. A cancelled invoice always gets "CANCELLED"; anything
   * else here (e.g. "SAMPLE" from the preview route) also appears in the heading, so a
   * preview can never be mistaken for a real tax invoice.
   */
  watermark?: string | null;
}

/**
 * The pre-tax rows of the totals column. Every figure is exclusive of GST so that
 * `itemSubtotal - itemDiscount + shipping` is the invoice's taxable value, and the column
 * as printed lands exactly on the grand total once the tax heads and round-off are added.
 *
 * Taxable value plus the line's own discount is the pre-tax gross whichever basis the line
 * was priced on, and it reads correctly off snapshots written before `grossValue` existed.
 */
/**
 * Whether the line table carries a Discount column. It earns its place only if some row
 * would put a figure in it: an order with nothing discounted gets a column of dashes
 * otherwise. Order-level discounts are allocated onto the lines, so this sees those too.
 */
export function showsDiscountColumn(lines: InvoiceSnapshot["lines"]): boolean {
  return lines.some((line) => line.discount > 0);
}

/** Widths for the HSN summary, sized to sit beside the 216pt totals block. */
const HSN_COLS = {
  hsn: { width: 60 },
  rate: { width: 28 },
  taxable: { width: 56 },
  tax: { width: 50 },
  taxWide: { width: 100 },
  cess: { width: 44 },
};

/** Column totals for the HSN summary, so the table can be checked against the totals block. */
export function hsnSummaryTotals(rows: InvoiceSnapshot["hsnSummary"]): {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
} {
  const add = (pick: (row: InvoiceSnapshot["hsnSummary"][number]) => number) =>
    round2(rows.reduce((total, row) => total + pick(row), 0));
  return {
    taxableValue: add((row) => row.taxableValue),
    cgst: add((row) => row.cgst),
    sgst: add((row) => row.sgst),
    igst: add((row) => row.igst),
    cess: add((row) => row.cess),
  };
}

export function totalsBreakdown(lines: InvoiceSnapshot["lines"]): {
  itemSubtotal: number;
  itemDiscount: number;
  shipping: number;
} {
  const goods = lines.filter((line) => line.kind === "GOODS");
  return {
    itemSubtotal: round2(
      goods.reduce((total, line) => total + line.taxableValue + line.discount, 0),
    ),
    itemDiscount: round2(goods.reduce((total, line) => total + line.discount, 0)),
    // Shipping is shown net of its own discount, which is why that discount is left out of
    // the Discount row - counting it in both would leave the column short by the freight waived.
    shipping: round2(
      lines
        .filter((line) => line.kind === "SHIPPING")
        .reduce((total, line) => total + line.taxableValue, 0),
    ),
  };
}

export function InvoiceDocument({
  invoice,
  watermark,
}: InvoiceDocumentProps): React.ReactElement {
  const intra = invoice.taxKind === "INTRA_STATE";
  const { seller, buyer, totals } = invoice;
  const {
    itemSubtotal,
    itemDiscount,
    shipping: shippingAmount,
  } = totalsBreakdown(invoice.lines);
  const hsnTotals = hsnSummaryTotals(invoice.hsnSummary);
  const showDiscount = showsDiscountColumn(invoice.lines);
  const cols = showDiscount ? COLS : COLS_NO_DISCOUNT;
  const anyCess = invoice.hsnSummary.some((row) => row.cess > 0);
  const cancelled = invoice.status === "CANCELLED";
  const stamp = cancelled ? "CANCELLED" : watermark?.trim() || null;
  const invoiceTitle = seller.invoiceTitle?.trim() || "INVOICE RECEIPT";
  const heading = cancelled
    ? `${invoiceTitle} (CANCELLED)`
    : stamp
      ? `${invoiceTitle} (${stamp})`
      : invoiceTitle;

  return (
    <Document
      title={`${invoiceTitle} ${invoice.invoiceNumber}`}
      author={seller.legalName}
      subject={`Invoice for order ${invoice.order.name}`}
    >
      <Page size="A4" style={styles.page}>
        {stamp ? (
          <Text
            style={[
              styles.watermark,
              // A cancellation has to be unmissable; a preview stamp only has to be
              // legible, so it stays faint enough to read the figures through it.
              cancelled
                ? { color: "#ef4444", opacity: 0.22 }
                : { color: "#64748b", opacity: 0.1 },
            ]}
          >
            {stamp}
          </Text>
        ) : null}

        <Text style={styles.title}>{heading}</Text>

        <View style={styles.box}>
          {/* Seller ------------------------------------------------------------- */}
          <View style={[styles.headerBox, styles.rowBorder]}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={styles.sellerName}>{seller.legalName}</Text>
              {seller.address
                .split("\n")
                .filter(Boolean)
                .map((line, i) => (
                  <Text key={i} style={{ marginTop: 1.5 }}>
                    {line}
                  </Text>
                ))}
              <Text style={{ marginTop: 3 }}>
                <Text style={styles.bold}>GSTIN: </Text>
                {seller.gstin}
                {seller.pan ? `   PAN: ${seller.pan}` : ""}
              </Text>
              <Text>
                <Text style={styles.bold}>State: </Text>
                {seller.stateName} ({seller.stateCode})
              </Text>
            </View>
            {seller.logoDataUri ? (
              <Image src={seller.logoDataUri} style={styles.logo} />
            ) : null}
          </View>

          {/* Invoice meta -------------------------------------------------------- */}
          <View style={[styles.row, styles.rowBorder]}>
            <Meta label="Invoice no." value={invoice.invoiceNumber} bold />
            <Meta label="Invoice date" value={invoice.invoiceDate} />
            <Meta label="Order ref." value={invoice.order.name} />
            <Meta
              label="Place of supply"
              value={`${invoice.placeOfSupply.stateName} (${invoice.placeOfSupply.stateCode})`}
              last
            />
          </View>

          {/* Parties ------------------------------------------------------------- */}
          <View style={[styles.row, styles.rowBorder]}>
            <Party
              label="Bill to"
              name={buyer.name}
              lines={formatAddress(
                buyer.billingAddress ?? buyer.shippingAddress,
              )}
              gstin={buyer.gstin}
              email={buyer.email}
            />
            <Party
              label="Ship to"
              name={buyer.shippingAddress?.name ?? buyer.name}
              lines={formatAddress(
                buyer.shippingAddress ?? buyer.billingAddress,
              )}
              last
            />
          </View>

          {/* Line items ---------------------------------------------------------- */}
          <View style={[styles.row, styles.rowBorder]}>
            <Text
              style={[
                styles.th,
                styles.cellBorder,
                { width: cols.sn },
                styles.center,
              ]}
            >
              #
            </Text>
            <Text style={[styles.th, styles.cellBorder, { flex: 1 }]}>
              Description
            </Text>
            <Text
              style={[
                styles.th,
                styles.cellBorder,
                { width: cols.hsn },
                styles.center,
              ]}
            >
              HSN
            </Text>
            <Text
              style={[
                styles.th,
                styles.cellBorder,
                { width: cols.qty },
                styles.right,
              ]}
            >
              Qty
            </Text>
            <Text
              style={[
                styles.th,
                styles.cellBorder,
                { width: cols.rate },
                styles.right,
              ]}
            >
              Unit
            </Text>
            {showDiscount && (
              <Text
                style={[
                  styles.th,
                  styles.cellBorder,
                  { width: cols.discount },
                  styles.right,
                ]}
              >
                Discount
              </Text>
            )}
            <Text
              style={[
                styles.th,
                styles.cellBorder,
                { width: cols.taxable },
                styles.right,
              ]}
            >
              Taxable
            </Text>
            {intra ? (
              <>
                <Text
                  style={[
                    styles.th,
                    styles.cellBorder,
                    { width: cols.taxPair },
                    styles.right,
                  ]}
                >
                  CGST
                </Text>
                <Text
                  style={[
                    styles.th,
                    styles.cellBorder,
                    { width: cols.taxPair },
                    styles.right,
                  ]}
                >
                  SGST
                </Text>
              </>
            ) : (
              <Text
                style={[
                  styles.th,
                  styles.cellBorder,
                  { width: cols.taxSingle },
                  styles.right,
                ]}
              >
                IGST
              </Text>
            )}
            <Text style={[styles.th, { width: cols.total }, styles.right]}>
              Total
            </Text>
          </View>

          {invoice.lines.map((line, index) => (
            <View
              key={line.id}
              style={[styles.row, styles.rowBorder]}
              wrap={false}
            >
              <Text
                style={[
                  styles.td,
                  styles.cellBorder,
                  { width: cols.sn },
                  styles.center,
                ]}
              >
                {index + 1}
              </Text>
              <View style={[styles.td, styles.cellBorder, { flex: 1 }]}>
                <Text>{line.title}</Text>
              </View>
              <Text
                style={[
                  styles.td,
                  styles.cellBorder,
                  { width: cols.hsn },
                  styles.center,
                ]}
              >
                {line.hsn || "-"}
              </Text>
              <Text
                style={[
                  styles.td,
                  styles.cellBorder,
                  { width: cols.qty },
                  styles.right,
                ]}
              >
                {line.quantity}
              </Text>
              <Text
                style={[
                  styles.td,
                  styles.cellBorder,
                  { width: cols.rate },
                  styles.right,
                ]}
              >
                {formatInr(line.unitTaxableValue)}
              </Text>
              {showDiscount && (
                <Text
                  style={[
                    styles.td,
                    styles.cellBorder,
                    { width: cols.discount },
                    styles.right,
                  ]}
                >
                  {line.discount > 0 ? `-${formatInr(line.discount)}` : "-"}
                </Text>
              )}
              <Text
                style={[
                  styles.td,
                  styles.cellBorder,
                  { width: cols.taxable },
                  styles.right,
                ]}
              >
                {formatInr(line.taxableValue)}
              </Text>
              {intra ? (
                <>
                  <Text
                    style={[
                      styles.td,
                      styles.cellBorder,
                      { width: cols.taxPair },
                      styles.right,
                    ]}
                  >
                    {formatInr(line.cgst)}
                    <Text
                      style={[styles.muted, { fontSize: 6 }]}
                    >{`\n${line.rate / 2}%`}</Text>
                  </Text>
                  <Text
                    style={[
                      styles.td,
                      styles.cellBorder,
                      { width: cols.taxPair },
                      styles.right,
                    ]}
                  >
                    {formatInr(line.sgst)}
                    <Text
                      style={[styles.muted, { fontSize: 6 }]}
                    >{`\n${line.rate / 2}%`}</Text>
                  </Text>
                </>
              ) : (
                <Text
                  style={[
                    styles.td,
                    styles.cellBorder,
                    { width: cols.taxSingle },
                    styles.right,
                  ]}
                >
                  {formatInr(line.igst)}
                  <Text
                    style={[styles.muted, { fontSize: 6 }]}
                  >{`\n${line.rate}%`}</Text>
                </Text>
              )}
              <Text style={[styles.td, { width: cols.total }, styles.right]}>
                {formatInr(line.total)}
              </Text>
            </View>
          ))}

          {/* Totals -------------------------------------------------------------- */}
          <View style={styles.row}>
            <View style={[{ flex: 1, padding: 8 }, styles.cellBorder]}>
              <Text style={styles.sectionLabel}>Amount in words</Text>
              <Text style={styles.bold}>{invoice.amountInWords}</Text>
              {totals.discount > 0 && (
                <Text style={[styles.muted, { fontSize: 7, marginTop: 2 }]}>
                  Includes a discount of Rs. {formatInr(totals.discount)},
                  already deducted from the taxable value.
                </Text>
              )}

              <View style={{ marginTop: 8 }}>
                <Text style={styles.sectionLabel}>HSN / rate summary</Text>
                <View style={[styles.row, { marginTop: 2 }]}>
                  <Text style={[styles.bold, HSN_COLS.hsn, { fontSize: 7 }]}>
                    HSN
                  </Text>
                  <Text style={[styles.bold, HSN_COLS.rate, { fontSize: 7 }]}>
                    Rate
                  </Text>
                  <Text
                    style={[styles.bold, HSN_COLS.taxable, { fontSize: 7 }, styles.right]}
                  >
                    Taxable
                  </Text>
                  {/* Split by head, as GSTR-1's HSN table wants it - a combined figure has
                      to be halved by hand, and only the seller knows if that is safe. */}
                  {intra ? (
                    <>
                      <Text style={[styles.bold, HSN_COLS.tax, { fontSize: 7 }, styles.right]}>
                        CGST
                      </Text>
                      <Text style={[styles.bold, HSN_COLS.tax, { fontSize: 7 }, styles.right]}>
                        SGST
                      </Text>
                    </>
                  ) : (
                    <Text style={[styles.bold, HSN_COLS.taxWide, { fontSize: 7 }, styles.right]}>
                      IGST
                    </Text>
                  )}
                  {anyCess && (
                    <Text style={[styles.bold, HSN_COLS.cess, { fontSize: 7 }, styles.right]}>
                      Cess
                    </Text>
                  )}
                </View>
                {invoice.hsnSummary.map((row) => (
                  <View key={`${row.hsn}-${row.rate}`} style={styles.row}>
                    <Text style={[HSN_COLS.hsn, { fontSize: 7.5 }]}>
                      {row.hsn || row.label || "-"}
                    </Text>
                    <Text style={[HSN_COLS.rate, { fontSize: 7.5 }]}>
                      {row.rate}%
                    </Text>
                    <Text style={[HSN_COLS.taxable, { fontSize: 7.5 }, styles.right]}>
                      {formatInr(row.taxableValue)}
                    </Text>
                    {intra ? (
                      <>
                        <Text style={[HSN_COLS.tax, { fontSize: 7.5 }, styles.right]}>
                          {formatInr(row.cgst)}
                        </Text>
                        <Text style={[HSN_COLS.tax, { fontSize: 7.5 }, styles.right]}>
                          {formatInr(row.sgst)}
                        </Text>
                      </>
                    ) : (
                      <Text style={[HSN_COLS.taxWide, { fontSize: 7.5 }, styles.right]}>
                        {formatInr(row.igst)}
                      </Text>
                    )}
                    {anyCess && (
                      <Text style={[HSN_COLS.cess, { fontSize: 7.5 }, styles.right]}>
                        {formatInr(row.cess)}
                      </Text>
                    )}
                  </View>
                ))}
                {/* The summary is only useful if it can be checked against the totals column. */}
                <View style={[styles.row, styles.hsnTotalRow]}>
                  <Text style={[styles.bold, HSN_COLS.hsn, { fontSize: 7.5 }]}>
                    Total
                  </Text>
                  <Text style={[HSN_COLS.rate, { fontSize: 7.5 }]} />
                  <Text style={[styles.bold, HSN_COLS.taxable, { fontSize: 7.5 }, styles.right]}>
                    {formatInr(hsnTotals.taxableValue)}
                  </Text>
                  {intra ? (
                    <>
                      <Text style={[styles.bold, HSN_COLS.tax, { fontSize: 7.5 }, styles.right]}>
                        {formatInr(hsnTotals.cgst)}
                      </Text>
                      <Text style={[styles.bold, HSN_COLS.tax, { fontSize: 7.5 }, styles.right]}>
                        {formatInr(hsnTotals.sgst)}
                      </Text>
                    </>
                  ) : (
                    <Text style={[styles.bold, HSN_COLS.taxWide, { fontSize: 7.5 }, styles.right]}>
                      {formatInr(hsnTotals.igst)}
                    </Text>
                  )}
                  {anyCess && (
                    <Text style={[styles.bold, HSN_COLS.cess, { fontSize: 7.5 }, styles.right]}>
                      {formatInr(hsnTotals.cess)}
                    </Text>
                  )}
                </View>
              </View>
            </View>

            <View style={{ width: 216 }}>
              {!invoice.pricesIncludeGst && (
                <>
                  <TotalRow label="Subtotal" value={itemSubtotal} />
                  {itemDiscount > 0 && (
                    <TotalRow label="Discount" value={-itemDiscount} />
                  )}
                  {shippingAmount > 0 && <TotalRow label="Shipping" value={shippingAmount} />}
                  {/* Where the commercial breakdown above meets the tax below, and the figure
                      the HSN summary adds up to. Without it the reader has to do the sum. */}
                  <TotalRow label="Taxable value" value={totals.taxableValue} />
                </>
              )}
              {invoice.pricesIncludeGst && (
                <>
                  {totals.discount > 0 && (
                    <TotalRow label="Discount" value={-totals.discount} />
                  )}
                  <TotalRow label="Taxable value" value={totals.taxableValue} />
                </>
              )}
              {intra ? (
                <>
                  <TotalRow label="CGST" value={totals.cgst} />
                  <TotalRow label="SGST" value={totals.sgst} />
                </>
              ) : (
                <TotalRow label="IGST" value={totals.igst} />
              )}
              {totals.cess > 0 && <TotalRow label="Cess" value={totals.cess} />}
              {totals.roundOff !== 0 && (
                <TotalRow label="Round off" value={totals.roundOff} />
              )}
              <View
                style={[
                  styles.row,
                  {
                    backgroundColor: "#f3f4f6",
                    borderTopWidth: 0.7,
                    borderColor: "#9ca3af",
                    borderStyle: "solid",
                  },
                ]}
              >
                <Text style={[styles.totalsLabel, styles.bold]}>
                  Grand total
                </Text>
                <Text style={[styles.totalsValue, styles.bold]}>
                  Rs. {formatInr(totals.grandTotal)}
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* Bank + terms + signature ---------------------------------------------- */}
        <View style={[styles.spaceBetween, { marginTop: 10 }]}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            {hasBank(seller.bank) && (
              <View style={{ marginBottom: 8 }}>
                <Text style={styles.sectionLabel}>Bank details</Text>
                {seller.bank?.bankName ? (
                  <Text>Bank: {seller.bank.bankName}</Text>
                ) : null}
                {seller.bank?.accountName ? (
                  <Text>A/C name: {seller.bank.accountName}</Text>
                ) : null}
                {seller.bank?.accountNumber ? (
                  <Text>A/C no.: {seller.bank.accountNumber}</Text>
                ) : null}
                {seller.bank?.ifsc ? (
                  <Text>IFSC: {seller.bank.ifsc}</Text>
                ) : null}
              </View>
            )}
            {invoice.terms ? (
              <View>
                <Text style={styles.sectionLabel}>Terms and conditions</Text>
                {invoice.terms
                  .split("\n")
                  .filter(Boolean)
                  .map((line, i) => (
                    <Text key={i} style={{ fontSize: 7.5 }}>
                      {line}
                    </Text>
                  ))}
              </View>
            ) : null}
          </View>

          <View
            style={{
              width: 180,
              alignItems: "center",
              justifyContent: "flex-end",
            }}
          >
            <Text style={{ marginTop: 40 }}>For {seller.legalName}</Text>
            <Text style={[styles.muted, { marginTop: 22, fontSize: 7 }]}>
              Authorised signatory
            </Text>
          </View>
        </View>

        <Text style={styles.footer}>
          {cancelled
            ? `This invoice was cancelled on ${invoice.cancelledAt?.slice(0, 10) ?? ""}${invoice.cancellationReason ? ` (${invoice.cancellationReason})` : ""}.`
            : stamp
              ? "Layout preview generated from your current settings. Not a valid tax invoice."
              : "This is a computer-generated invoice."}
        </Text>
      </Page>
    </Document>
  );
}

function hasBank(bank: InvoiceSnapshot["seller"]["bank"]): boolean {
  return Boolean(
    bank &&
    (bank.bankName || bank.accountName || bank.accountNumber || bank.ifsc),
  );
}

function Meta({
  label,
  value,
  bold,
  last,
}: {
  label: string;
  value: string;
  bold?: boolean;
  last?: boolean;
}) {
  return (
    <View style={[styles.metaCell, last ? { borderRightWidth: 0 } : {}]}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={bold ? styles.bold : undefined}>{value}</Text>
    </View>
  );
}

function Party({
  label,
  name,
  lines,
  gstin,
  email,
  last,
}: {
  label: string;
  name: string;
  lines: string[];
  gstin?: string | null;
  email?: string | null;
  last?: boolean;
}) {
  // formatAddress already includes the name; drop it so it is not printed twice.
  const rest = lines.filter((line) => line !== name);
  return (
    <View style={[styles.partyCell, last ? { borderRightWidth: 0 } : {}]}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <Text style={styles.bold}>{name}</Text>
      {rest.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      {gstin ? <Text style={{ marginTop: 2 }}>GSTIN: {gstin}</Text> : null}
      {email ? <Text style={styles.muted}>{email}</Text> : null}
    </View>
  );
}

function TotalRow({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.row}>
      <Text style={styles.totalsLabel}>{label}</Text>
      <Text style={styles.totalsValue}>{formatInr(value)}</Text>
    </View>
  );
}
