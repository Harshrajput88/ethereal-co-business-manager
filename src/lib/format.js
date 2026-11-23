const moneyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

const compactMoneyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1
})

export function formatMoney(value) {
  return moneyFormatter.format(Number(value) || 0)
}

export function formatCompactMoney(value) {
  return compactMoneyFormatter.format(Number(value) || 0)
}

export function formatNumber(value, options = {}) {
  return new Intl.NumberFormat('en-IN', options).format(Number(value) || 0)
}

export function businessDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(value)
}

export function today() {
  return businessDate()
}

export function monthStart(value = new Date()) {
  return `${businessDate(value).slice(0, 7)}-01`
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function formatDate(value) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(date)
}

export function formatDateTime(value) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

export function formatTime(value) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

export function relativeDate(value) {
  const d = formatDate(value)
  if (d === formatDate(new Date())) return 'Today'
  if (d === formatDate(new Date(Date.now() - 86400000))) return 'Yesterday'
  return d
}

export function titleCase(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

export function statusTone(status) {
  switch (status) {
    case 'confirmed':
    case 'approved':
    case 'verified':
    case 'paid':
    case 'issued':
      return 'success'
    case 'pending':
    case 'pending_credit_approval':
    case 'submitted':
    case 'draft':
      return 'warning'
    case 'rejected':
    case 'disabled':
    case 'cancelled':
    case 'reversed':
      return 'danger'
    case 'inactive':
      return 'muted'
    default:
      return 'neutral'
  }
}

export function downloadCsv(filename, rows) {
  if (!rows.length) return
  const headers = Object.keys(rows[0])
  const escape = value => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const csv = [
    headers.join(','),
    ...rows.map(row => headers.map(h => escape(row[h])).join(','))
  ].join('\n')

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
