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
import { formatInr } from "../gst/money";
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
  rate: 52,
  taxable: 58,
  taxPair: 46,
  taxSingle: 62,
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

export function InvoiceDocument({
  invoice,
  watermark,
}: InvoiceDocumentProps): React.ReactElement {
  const intra = invoice.taxKind === "INTRA_STATE";
  const { seller, buyer, totals } = invoice;
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
                { width: COLS.sn },
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
                { width: COLS.hsn },
                styles.center,
              ]}
            >
              HSN
            </Text>
            <Text
              style={[
                styles.th,
                styles.cellBorder,
                { width: COLS.qty },
                styles.right,
              ]}
            >
              Qty
            </Text>
            <Text
              style={[
                styles.th,
                styles.cellBorder,
                { width: COLS.rate },
                styles.right,
              ]}
            >
              Unit
            </Text>
            <Text
              style={[
                styles.th,
                styles.cellBorder,
                { width: COLS.taxable },
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
                    { width: COLS.taxPair },
                    styles.right,
                  ]}
                >
                  CGST
                </Text>
                <Text
                  style={[
                    styles.th,
                    styles.cellBorder,
                    { width: COLS.taxPair },
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
                  { width: COLS.taxSingle },
                  styles.right,
                ]}
              >
                IGST
              </Text>
            )}
            <Text style={[styles.th, { width: COLS.total }, styles.right]}>
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
                  { width: COLS.sn },
                  styles.center,
                ]}
              >
                {index + 1}
              </Text>
              <View style={[styles.td, styles.cellBorder, { flex: 1 }]}>
                <Text>{line.title}</Text>
                {line.discount > 0 && (
                  <Text style={[styles.muted, { fontSize: 7 }]}>
                    Discount: Rs. {formatInr(line.discount)}
                  </Text>
                )}
              </View>
              <Text
                style={[
                  styles.td,
                  styles.cellBorder,
                  { width: COLS.hsn },
                  styles.center,
                ]}
              >
                {line.hsn || "-"}
              </Text>
              <Text
                style={[
                  styles.td,
                  styles.cellBorder,
                  { width: COLS.qty },
                  styles.right,
                ]}
              >
                {line.quantity}
              </Text>
              <Text
                style={[
                  styles.td,
                  styles.cellBorder,
                  { width: COLS.rate },
                  styles.right,
                ]}
              >
                {formatInr(line.unitTaxableValue)}
              </Text>
              <Text
                style={[
                  styles.td,
                  styles.cellBorder,
                  { width: COLS.taxable },
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
                      { width: COLS.taxPair },
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
                      { width: COLS.taxPair },
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
                    { width: COLS.taxSingle },
                    styles.right,
                  ]}
                >
                  {formatInr(line.igst)}
                  <Text
                    style={[styles.muted, { fontSize: 6 }]}
                  >{`\n${line.rate}%`}</Text>
                </Text>
              )}
              <Text style={[styles.td, { width: COLS.total }, styles.right]}>
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
                  <Text style={[styles.bold, { width: 54, fontSize: 7 }]}>
                    HSN
                  </Text>
                  <Text style={[styles.bold, { width: 32, fontSize: 7 }]}>
                    Rate
                  </Text>
                  <Text
                    style={[
                      styles.bold,
                      { width: 64, fontSize: 7 },
                      styles.right,
                    ]}
                  >
                    Taxable
                  </Text>
                  <Text
                    style={[
                      styles.bold,
                      { width: 64, fontSize: 7 },
                      styles.right,
                    ]}
                  >
                    Tax
                  </Text>
                </View>
                {invoice.hsnSummary.map((row) => (
                  <View key={`${row.hsn}-${row.rate}`} style={styles.row}>
                    <Text style={{ width: 54, fontSize: 7.5 }}>
                      {row.hsn || row.label || "-"}
                    </Text>
                    <Text style={{ width: 32, fontSize: 7.5 }}>
                      {row.rate}%
                    </Text>
                    <Text style={[{ width: 64, fontSize: 7.5 }, styles.right]}>
                      {formatInr(row.taxableValue)}
                    </Text>
                    <Text style={[{ width: 64, fontSize: 7.5 }, styles.right]}>
                      {formatInr(row.cgst + row.sgst + row.igst + row.cess)}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            <View style={{ width: 216 }}>
              <TotalRow label="Taxable value" value={totals.taxableValue} />
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
