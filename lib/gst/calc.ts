import { round2, sum } from './money'
import { highestGoodsRate, resolveRate } from './rates'
import type {
  CalcLine,
  CalculationInput,
  CalculationResult,
  CalcTotals,
  HsnSummaryRow,
  ResolvedRate,
  TaxKind,
  TaxableLineInput,
} from './types'

/**
 * The GST calculator. Pure: no Shopify types, no filesystem, no clock. Given a seller
 * state, a place of supply, a rate table and normalised lines, it produces the exact
 * numbers that get frozen into the invoice snapshot.
 */

export function determineTaxKind(sellerStateCode: string, placeOfSupplyStateCode: string): TaxKind {
  return sellerStateCode === placeOfSupplyStateCode ? 'INTRA_STATE' : 'INTER_STATE'
}

function taxableValueOf(grossAfterDiscount: number, rate: number, pricesIncludeGst: boolean): number {
  if (!pricesIncludeGst) return round2(grossAfterDiscount)
  return round2(grossAfterDiscount / (1 + rate / 100))
}

export function calculate(input: CalculationInput): CalculationResult {
  const { sellerStateCode, placeOfSupplyStateCode, pricesIncludeGst, rateTable } = input
  const taxKind = determineTaxKind(sellerStateCode, placeOfSupplyStateCode)
  const treatment = input.shippingTreatment ?? 'SEPARATE_SERVICE'

  // Rates are resolved on the lines as invoiced, before any freight is folded in, so
  // apportioned delivery can never push a garment across a price-slab boundary.
  const working = treatment === 'APPORTION' ? apportionShipping(input.lines) : input.lines

  const goodsLines = working.filter((l) => (l.kind ?? 'GOODS') === 'GOODS')
  const goodsRates = goodsLines.map((line) =>
    resolveRate(rateBasis(line), rateTable, pricesIncludeGst),
  )
  const principal = principalSupply(goodsLines, goodsRates)

  let goodsCursor = 0
  const lines: CalcLine[] = working.map((line) => {
    const kind = line.kind ?? 'GOODS'
    let resolved: ResolvedRate
    if (kind === 'GOODS') {
      resolved = goodsRates[goodsCursor++]
    } else {
      resolved = shippingRate(line, rateTable, pricesIncludeGst, treatment, principal)
    }
    return buildLine(line, resolved, pricesIncludeGst, taxKind)
  })

  const hsnSummary = summariseByHsn(lines)
  const totals = totalsOf(lines)

  return { taxKind, lines, hsnSummary, totals }
}

/**
 * The principal supply of a composite supply. The Act defines it as the *predominant*
 * element (s.2(90)), which is a question of value, so the largest line by value wins and
 * freight follows both its rate and its HSN - that way delivery rolls into a real goods row
 * in the HSN summary instead of inventing a courier-service row.
 *
 * Choosing by value rather than by "highest rate on the invoice" matters because a basket
 * of a T-shirt (6109) and a shirt (6205) has no highest rate - they are both 5% - and
 * picking the first line would make the delivery HSN depend on the order Shopify happened
 * to list the items in. Ties are therefore broken deterministically: higher rate first,
 * then the earlier line.
 *
 * A mixed-rate invoice has no single predominant supply worth the name, which is why
 * `mixedRates` is reported and `APPORTION` is the better treatment there.
 */
function principalSupply(
  goodsLines: TaxableLineInput[],
  goodsRates: ResolvedRate[],
): { rate: number; hsn: string; source: string; mixedRates: boolean } {
  if (goodsLines.length === 0) return { rate: 0, hsn: '', source: 'no-goods', mixedRates: false }

  const candidates = goodsLines.map((line, index) => ({
    index,
    value: round2(line.unitPrice * line.quantity - line.discount),
    rate: goodsRates[index].rate,
    hsn: goodsRates[index].hsn,
    ruleId: goodsRates[index].source,
  }))

  const winner = [...candidates].sort(
    (a, b) => b.value - a.value || b.rate - a.rate || a.index - b.index,
  )[0]

  return {
    rate: winner.rate,
    hsn: winner.hsn,
    // Names the classification that drove delivery, so the choice is auditable later.
    source: `principal-supply:${winner.ruleId}`,
    mixedRates: new Set(candidates.map((c) => c.rate)).size > 1,
  }
}

function shippingRate(
  line: TaxableLineInput,
  rateTable: CalculationInput['rateTable'],
  pricesIncludeGst: boolean,
  treatment: NonNullable<CalculationInput['shippingTreatment']>,
  principal: { rate: number; hsn: string; source: string },
): ResolvedRate {
  const fromTable = resolveRate(line, rateTable, pricesIncludeGst)
  if (treatment === 'SEPARATE_SERVICE') {
    // The rate comes from the table, but the printed code comes only from the delivery SAC
    // setting (carried as the line override). Falling through to the rule's code or to the
    // default goods HSN would print a code nobody chose - so a blank setting prints nothing.
    return { ...fromTable, hsn: line.hsnOverride?.trim() || '' }
  }

  // COMPOSITE_LINE: the rate AND the HSN come from the principal supply. Charging the
  // goods rate while printing SAC 996511 would describe two different supplies at once.
  return {
    hsn: principal.hsn || fromTable.hsn,
    rate: principal.rate,
    cess: 0,
    source: principal.source,
  }
}

/** A line with no freight folded in - the basis on which its rate is resolved. */
function rateBasis(line: TaxableLineInput): TaxableLineInput {
  const freight = line.apportionedShipping ?? 0
  return freight === 0 ? line : { ...line, discount: line.discount + freight }
}

/**
 * Folds the shipping line into the goods lines pro rata by value, and drops it. The last
 * line absorbs the rounding remainder so the apportioned amounts sum to the freight
 * charged, to the paisa.
 */
export function apportionShipping(lines: TaxableLineInput[]): TaxableLineInput[] {
  const goods = lines.filter((l) => (l.kind ?? 'GOODS') === 'GOODS')
  const shipping = lines.filter((l) => (l.kind ?? 'GOODS') === 'SHIPPING')
  if (goods.length === 0 || shipping.length === 0) return lines

  const freight = round2(
    shipping.reduce((total, l) => total + l.unitPrice * l.quantity - l.discount, 0),
  )
  if (freight <= 0) return goods

  const values = goods.map((l) => round2(l.unitPrice * l.quantity - l.discount))
  const base = values.reduce((a, b) => a + b, 0)

  let allocated = 0
  return goods.map((line, index) => {
    const share =
      index === goods.length - 1
        ? round2(freight - allocated)
        : round2(base > 0 ? (freight * values[index]) / base : freight / goods.length)
    allocated = round2(allocated + share)
    return {
      ...line,
      // Negative discount raises the taxable base, which is exactly what s.15(2)(c) asks
      // for: freight becomes part of the value of the goods.
      discount: round2(line.discount - share),
      apportionedShipping: share,
    }
  })
}

function buildLine(
  line: TaxableLineInput,
  resolved: ResolvedRate,
  pricesIncludeGst: boolean,
  taxKind: TaxKind,
): CalcLine {
  const grossAfterDiscount = round2(line.unitPrice * line.quantity - line.discount)
  const taxableValue = taxableValueOf(grossAfterDiscount, resolved.rate, pricesIncludeGst)
  const taxAmount = round2((taxableValue * resolved.rate) / 100)
  const cess = round2((taxableValue * resolved.cess) / 100)

  // Splitting CGST/SGST as half each and taking the remainder on SGST keeps
  // cgst + sgst === taxAmount exactly, even for odd paise.
  const cgst = taxKind === 'INTRA_STATE' ? round2(taxAmount / 2) : 0
  const sgst = taxKind === 'INTRA_STATE' ? round2(taxAmount - cgst) : 0
  const igst = taxKind === 'INTER_STATE' ? taxAmount : 0

  return {
    id: line.id,
    title: [line.title, line.variantTitle].filter(Boolean).join(' - '),
    hsn: resolved.hsn,
    quantity: line.quantity,
    unitTaxableValue: line.quantity > 0 ? round2(taxableValue / line.quantity) : 0,
    taxableValue,
    discount: round2(line.discount),
    rate: resolved.rate,
    cgst,
    sgst,
    igst,
    cess,
    total: round2(taxableValue + cgst + sgst + igst + cess),
    rateSource: resolved.source,
    kind: line.kind ?? 'GOODS',
  }
}

/** GSTR-1 style HSN summary: one row per (HSN, rate) pair. */
export function summariseByHsn(lines: CalcLine[]): HsnSummaryRow[] {
  const buckets = new Map<string, HsnSummaryRow>()
  for (const line of lines) {
    // Lines with no code are grouped by description, so a code-less delivery row can never
    // be merged with some other code-less line at the same rate.
    const key = `${line.hsn}|${line.rate}|${line.hsn ? '' : line.title}`
    const row = buckets.get(key) ?? {
      hsn: line.hsn,
      ...(line.hsn ? {} : { label: line.title }),
      rate: line.rate,
      taxableValue: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      cess: 0,
      total: 0,
    }
    row.taxableValue = round2(row.taxableValue + line.taxableValue)
    row.cgst = round2(row.cgst + line.cgst)
    row.sgst = round2(row.sgst + line.sgst)
    row.igst = round2(row.igst + line.igst)
    row.cess = round2(row.cess + line.cess)
    row.total = round2(row.total + line.total)
    buckets.set(key, row)
  }
  return [...buckets.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
}

export function totalsOf(lines: CalcLine[]): CalcTotals {
  const taxableValue = sum(lines.map((l) => l.taxableValue))
  const cgst = sum(lines.map((l) => l.cgst))
  const sgst = sum(lines.map((l) => l.sgst))
  const igst = sum(lines.map((l) => l.igst))
  const cess = sum(lines.map((l) => l.cess))
  const taxTotal = round2(cgst + sgst + igst + cess)
  const subTotal = round2(taxableValue + taxTotal)
  const grandTotal = Math.round(subTotal)
  return {
    taxableValue,
    discount: sum(lines.map((l) => l.discount)),
    cgst,
    sgst,
    igst,
    cess,
    taxTotal,
    subTotal,
    roundOff: round2(grandTotal - subTotal),
    grandTotal,
  }
}
