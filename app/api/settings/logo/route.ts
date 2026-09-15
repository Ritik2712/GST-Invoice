import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api'
import * as store from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 400 * 1024
// @react-pdf/renderer can only embed raster images; SVG logos are rejected up front.
const ALLOWED = new Set(['image/png', 'image/jpeg'])

/** Stores the logo inline as a data URI - no asset pipeline, no public file serving. */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData()
    const file = form.get('logo')

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file uploaded', code: 'NO_FILE' }, { status: 400 })
    }
    if (!ALLOWED.has(file.type)) {
      return NextResponse.json({ error: 'Logo must be a PNG or JPEG', code: 'BAD_TYPE' }, { status: 415 })
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'Logo must be smaller than 400 KB', code: 'TOO_LARGE' }, { status: 413 })
    }

    const base64 = Buffer.from(await file.arrayBuffer()).toString('base64')
    const logoDataUri = `data:${file.type};base64,${base64}`

    const settings = await store.getSettings()
    await store.saveSettings({ ...settings, logoDataUri })

    return NextResponse.json({ logoDataUri })
  } catch (error) {
    return errorResponse(error)
  }
}

/** Removes the logo. */
export async function DELETE() {
  try {
    const settings = await store.getSettings()
    await store.saveSettings({ ...settings, logoDataUri: null })
    return NextResponse.json({ logoDataUri: null })
  } catch (error) {
    return errorResponse(error)
  }
}
