import type {
  RateRule,
  RateRuleMatch,
  RateSlab,
  RateTable,
  ResolvedRate,
  TaxableLineInput,
} from './types'

/**
 * Rate resolution is entirely table-driven: nothing in this file knows about a specific
 * product, HSN code or percentage. Rules are matched in ascending `priority` (ties break
 * on array order) and the first match wins; if nothing matches, the table's fallback is
 * used. A line may carry `hsnOverride` (e.g. an HSN metafield on the product), which
 * always wins for the printed HSN but never changes the rate - the rate still comes from
 * the table so that historical behaviour stays explainable.
 */

function candidateValues(line: TaxableLineInput, field: RateRuleMatch['field']): string[] {
  switch (field) {
    case 'sku':
      return line.sku ? [line.sku] : []
    case 'tag':
      return line.tags ?? []
    case 'productType':
      return line.productType ? [line.productType] : []
    case 'vendor':
      return line.vendor ? [line.vendor] : []
    case 'title':
      return [line.title, line.variantTitle ?? ''].filter(Boolean)
    case 'any':
      return [
        line.sku ?? '',
        line.productType ?? '',
        line.vendor ?? '',
        line.title,
        line.variantTitle ?? '',
        ...(line.tags ?? []),
      ].filter(Boolean)
  }
}

function matchesCondition(line: TaxableLineInput, condition: RateRuleMatch): boolean {
  const caseSensitive = condition.caseSensitive ?? false
  const needle = caseSensitive ? condition.value : condition.value.toLowerCase()
  return candidateValues(line, condition.field).some((raw) => {
    const haystack = caseSensitive ? raw : raw.toLowerCase()
    switch (condition.operator) {
      case 'equals':
        return haystack === needle
      case 'startsWith':
        return haystack.startsWith(needle)
      case 'contains':
        return haystack.includes(needle)
      case 'regex':
        try {
          return new RegExp(condition.value, caseSensitive ? '' : 'i').test(raw)
        } catch {
          // A malformed rule must never take down invoice generation.
          return false
        }
    }
  })
}

function ruleApplies(rule: RateRule, line: TaxableLineInput): boolean {
  const lineKind = line.kind ?? 'GOODS'
  const appliesTo = rule.appliesTo ?? 'GOODS'
  if (appliesTo !== 'ANY' && appliesTo !== lineKind) return false
  if (rule.match.length === 0) return false
  return rule.match.every((condition) => matchesCondition(line, condition))
}

/**
 * Slab rates (apparel, footwear, …) are defined on the per-unit *taxable* value, but with
 * tax-inclusive pricing the taxable value depends on the rate we are trying to pick. Each
 * slab is therefore tested for self-consistency: apply the slab's own rate, strip the tax
 * and check the result still falls inside that slab's bound. When no slab is consistent -
 * the narrow band where 5% pushes the net above the threshold and 12% pulls it back below
 * - the gross value decides, which is the conservative (higher-rate) reading.
 */
export function resolveSlabRate(
  slabs: RateSlab[],
  unitGrossValue: number,
  pricesIncludeGst: boolean,
): number {
  if (slabs.length === 0) throw new Error('Rate rule has an empty slab list')

  for (const slab of slabs) {
    const net = pricesIncludeGst ? unitGrossValue / (1 + slab.rate / 100) : unitGrossValue
    if (slab.maxUnitTaxableValue === undefined || net < slab.maxUnitTaxableValue) {
      return slab.rate
    }
  }

  const byGross = slabs.find(
    (slab) => slab.maxUnitTaxableValue === undefined || unitGrossValue < slab.maxUnitTaxableValue,
  )
  return (byGross ?? slabs[slabs.length - 1]).rate
}

/** Per-unit value after discount allocation - the basis for slab selection. */
export function unitGrossValue(line: TaxableLineInput): number {
  if (line.quantity <= 0) return 0
  return (line.unitPrice * line.quantity - line.discount) / line.quantity
}

/** Ascending priority, ties broken by position in the file. */
function orderedRules(table: RateTable): Array<{ rule: RateRule; index: number }> {
  return [...table.rules]
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => a.rule.priority - b.rule.priority || a.index - b.index)
}

export function resolveRate(
  line: TaxableLineInput,
  table: RateTable,
  pricesIncludeGst: boolean,
): ResolvedRate {
  for (const { rule } of orderedRules(table)) {
    if (!ruleApplies(rule, line)) continue
    const rate =
      rule.rate ?? resolveSlabRate(rule.slabs ?? [], unitGrossValue(line), pricesIncludeGst)
    return {
      // An empty `hsn` on a rule means "rate only" - the HSN still comes from the line
      // override or the table fallback (which the app seeds from the default HSN setting).
      hsn: line.hsnOverride || rule.hsn || table.fallback.hsn,
      rate,
      cess: rule.cess ?? 0,
      source: rule.id,
    }
  }

  return {
    hsn: line.hsnOverride || table.fallback.hsn,
    rate: table.fallback.rate,
    cess: 0,
    source: 'fallback',
  }
}

export interface RuleEvaluation {
  id: string
  priority: number
  description?: string
  appliesTo: 'GOODS' | 'SHIPPING' | 'ANY'
  matched: boolean
  /** The first condition that failed, rendered for humans. */
  failedOn?: string
  /** True for the rule that actually decided the outcome. */
  winner: boolean
  hsn?: string
  rate?: number
}

/**
 * Walks the table in the same order `resolveRate` does and reports what each rule did.
 * Purely diagnostic - it never changes an outcome - but it is the only way to tell a
 * deliberate classification from a coincidence, which matters because a wrong HSN on an
 * issued invoice cannot be edited afterwards.
 */
export function explainRules(
  line: TaxableLineInput,
  table: RateTable,
  pricesIncludeGst: boolean,
): { evaluations: RuleEvaluation[]; resolved: ResolvedRate } {
  const lineKind = line.kind ?? 'GOODS'
  let decided = false

  const evaluations = orderedRules(table).map(({ rule }): RuleEvaluation => {
    const appliesTo = rule.appliesTo ?? 'GOODS'
    const base = { id: rule.id, priority: rule.priority, description: rule.description, appliesTo }

    if (appliesTo !== 'ANY' && appliesTo !== lineKind) {
      return { ...base, matched: false, winner: false, failedOn: `applies to ${appliesTo} lines only` }
    }
    if (rule.match.length === 0) {
      return { ...base, matched: false, winner: false, failedOn: 'rule has no conditions' }
    }

    const failed = rule.match.find((condition) => !matchesCondition(line, condition))
    if (failed) {
      return {
        ...base,
        matched: false,
        winner: false,
        failedOn: `${failed.field} ${failed.operator} "${failed.value}"`,
      }
    }

    const rate = rule.rate ?? resolveSlabRate(rule.slabs ?? [], unitGrossValue(line), pricesIncludeGst)
    const winner = !decided
    decided = true
    return { ...base, matched: true, winner, hsn: line.hsnOverride || rule.hsn || table.fallback.hsn, rate }
  })

  return { evaluations, resolved: resolveRate(line, table, pricesIncludeGst) }
}

/** Highest goods rate on the invoice - used when shipping follows the principal supply. */
export function highestGoodsRate(rates: ResolvedRate[]): number {
  return rates.reduce((max, r) => Math.max(max, r.rate), 0)
}
