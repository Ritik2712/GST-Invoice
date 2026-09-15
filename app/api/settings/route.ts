import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api'
import { financialYearKeyIst } from '@/lib/gst/fy'
import { DEFAULT_SETTINGS, hasErrors, validateSettings, type AppSettings } from '@/lib/gst/settings'
import { resolveRate } from '@/lib/gst/rates'
import { stateByCode } from '@/lib/gst/states'
import * as store from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const settings = await store.getSettings()
    const financialYear = financialYearKeyIst(new Date())
    const table = await store.getRateTable()
    // The delivery rate lives in the rate table, not in Settings; resolve it the same way an
    // invoice would so the screen can show the real figure instead of a hard-coded one.
    const delivery = resolveRate(
      { id: 'delivery', title: settings.deliveryLineLabel, quantity: 1, unitPrice: 100, discount: 0, kind: 'SHIPPING' },
      table,
      settings.pricesIncludeGst,
    )
    return NextResponse.json({
      settings: { ...settings, lastIssuedNumber: await store.getLastIssued(financialYear) },
      financialYear,
      rateTableVersion: table.version,
      deliveryRate: { rate: delivery.rate, source: delivery.source },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PUT(request: NextRequest) {
  try {
    const incoming = normalize((await request.json()) as Partial<AppSettings>)
    const errors = validateSettings(incoming)
    if (hasErrors(errors)) {
      return NextResponse.json({ error: 'Some fields need attention', code: 'VALIDATION', errors }, { status: 422 })
    }

    // The counter file is authoritative; Settings just exposes an editable view of it.
    const financialYear = financialYearKeyIst(new Date())
    const current = await store.getLastIssued(financialYear)
    if (incoming.lastIssuedNumber !== current) {
      await store.setLastIssued(financialYear, incoming.lastIssuedNumber)
    }

    const saved = await store.saveSettings(incoming)
    return NextResponse.json({ settings: saved, financialYear })
  } catch (error) {
    return errorResponse(error)
  }
}

/** Coerce whatever the form sent into a complete, canonicalised settings object. */
function normalize(input: Partial<AppSettings>): AppSettings {
  const stateCode = (input.sellerStateCode ?? '').trim()
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...input,
    bank: { ...DEFAULT_SETTINGS.bank, ...(input.bank ?? {}) },
  }

  return {
    ...merged,
    legalBusinessName: merged.legalBusinessName.trim(),
    gstin: merged.gstin.trim().toUpperCase(),
    pan: merged.pan.trim().toUpperCase(),
    sellerStateCode: stateCode,
    sellerStateName: stateByCode(stateCode)?.name ?? '',
    invoicePrefix: merged.invoicePrefix.trim(),
    defaultHsn: merged.defaultHsn.trim(),
    shippingHsn: merged.shippingHsn.trim(),
    lastIssuedNumber: Number(merged.lastIssuedNumber) || 0,
    bank: {
      bankName: merged.bank.bankName.trim(),
      accountName: merged.bank.accountName.trim(),
      accountNumber: merged.bank.accountNumber.trim(),
      ifsc: merged.bank.ifsc.trim().toUpperCase(),
    },
  }
}
