/** Rupees in words, Indian numbering system - required on a tax invoice. */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function twoDigits(n: number): string {
  if (n < 20) return ONES[n]
  const tens = TENS[Math.floor(n / 10)]
  const ones = ONES[n % 10]
  return ones ? `${tens} ${ones}` : tens
}

function threeDigits(n: number): string {
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  const parts: string[] = []
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`)
  if (rest) parts.push(twoDigits(rest))
  return parts.join(' ')
}

/** 12345678 -> "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight". */
export function numberToIndianWords(value: number): string {
  const n = Math.floor(Math.abs(value))
  if (n === 0) return 'Zero'

  const crore = Math.floor(n / 10_000_000)
  const lakh = Math.floor((n % 10_000_000) / 100_000)
  const thousand = Math.floor((n % 100_000) / 1000)
  const hundred = n % 1000

  const parts: string[] = []
  if (crore) parts.push(`${numberToIndianWords(crore)} Crore`)
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`)
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`)
  if (hundred) parts.push(threeDigits(hundred))
  return parts.join(' ')
}

export function amountInWords(amount: number, currency = 'INR'): string {
  const unit = currency === 'INR' ? 'Rupees' : currency
  const negative = amount < 0
  const absolute = Math.abs(amount)
  const rupees = Math.floor(absolute)
  const paise = Math.round((absolute - rupees) * 100)

  const head = `${unit} ${numberToIndianWords(rupees)}`
  const tail = paise ? ` and ${numberToIndianWords(paise)} Paise` : ''
  return `${negative ? 'Minus ' : ''}${head}${tail} Only`
}
