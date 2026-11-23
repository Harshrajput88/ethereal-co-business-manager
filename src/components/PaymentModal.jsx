import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { formatDate, formatMoney, titleCase } from '../lib/format'
import Icon from './Icon'
import { EmptyState, ErrorNote, Field, InlineNote, LoadingBlock, Modal } from './ui'

function newReference() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `payment-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function localDateTimeInput() {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

export default function PaymentModal({ open, onClose, onCreated, defaultShopId = '' }) {
  const app = useApp()
  const [shopId, setShopId] = useState(defaultShopId)
  const [method, setMethod] = useState('cash')
  const [amount, setAmount] = useState('')
  const [receivedAt, setReceivedAt] = useState(localDateTimeInput)
  const [externalReference, setExternalReference] = useState('')
  const [allocations, setAllocations] = useState({})
  const [autoAllocate, setAutoAllocate] = useState(true)
  const [reference, setReference] = useState(newReference)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const shops = useApiData(() => api.getShops(), [app.version], { enabled: open })
  const openSales = useApiData(() => api.getShopOpenSales(shopId), [shopId, app.version], {
    enabled: open && Boolean(shopId)
  })

  useEffect(() => {
    if (!open) return
    setShopId(defaultShopId)
    setMethod('cash')
    setAmount('')
    setReceivedAt(localDateTimeInput())
    setExternalReference('')
    setAllocations({})
    setAutoAllocate(true)
    setReference(newReference())
    setError('')
  }, [open, defaultShopId])

  const approvedShops = (shops.data || []).filter(shop => shop.status === 'approved')
  const invoices = openSales.data || []

  useEffect(() => {
    if (!autoAllocate) return
    let remaining = Number(amount) || 0
    const next = {}
    for (const sale of invoices) {
      if (remaining <= 0) break
      const take = Math.min(remaining, Number(sale.balance))
      if (take > 0) {
        next[sale.sale_id] = String(Math.round(take * 100) / 100)
        remaining = Math.round((remaining - take) * 100) / 100
      }
    }
    setAllocations(next)
  }, [amount, invoices, autoAllocate])

  const allocationRows = useMemo(
    () =>
      invoices.map(sale => ({
        ...sale,
        allocated: Number(allocations[sale.sale_id] || 0)
      })),
    [invoices, allocations]
  )

  const allocatedTotal = allocationRows.reduce((sum, row) => sum + row.allocated, 0)
  const unapplied = Math.max(0, Math.round(((Number(amount) || 0) - allocatedTotal) * 100) / 100)

  function closeAndReset() {
    setError('')
    onClose()
  }

  async function submit(event) {
    event.preventDefault()
    setError('')
    if (!shopId) {
      setError('Choose the shop that paid.')
      return
    }
    if (!Number(amount) || Number(amount) <= 0) {
      setError('Enter a payment amount greater than zero.')
      return
    }
    if (allocatedTotal > Number(amount)) {
      setError('Invoice allocations cannot exceed the payment amount.')
      return
    }

    setSaving(true)
    try {
      const result = await api.recordPayment({
        shopId,
        method,
        amount: Number(amount),
        receivedAt: receivedAt ? new Date(receivedAt).toISOString() : null,
        externalReference: externalReference.trim(),
        allocations: allocationRows
          .filter(row => row.allocated > 0)
          .map(row => ({ sale_id: row.sale_id, amount: row.allocated })),
        clientReference: reference
      })
      app.notify(
        `Payment of ${formatMoney(result.amount || Number(amount))} submitted for verification.`,
        'success'
      )
      app.refresh()
      onCreated?.(result)
      closeAndReset()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={closeAndReset}
      size="lg"
      title="Record a payment"
      subtitle="Payments stay pending until an owner or admin verifies them."
      footer={
        <>
          <div className="foot-total">
            <span>Recording</span>
            <strong>{formatMoney(Number(amount) || 0)}</strong>
          </div>
          <button type="button" className="button-ghost" onClick={closeAndReset}>
            Cancel
          </button>
          <button type="submit" form="payment-form" className="button-primary" disabled={saving}>
            {saving ? 'Submitting…' : 'Submit payment'}
          </button>
        </>
      }
    >
      <form id="payment-form" className="form-stack" onSubmit={submit}>
        <Field label="Shop" htmlFor="payment-shop">
          <select
            id="payment-shop"
            value={shopId}
            onChange={event => setShopId(event.target.value)}
            required
          >
            <option value="">Select an approved shop…</option>
            {approvedShops.map(shop => (
              <option key={shop.id} value={shop.id}>
                {shop.name}
                {shop.outstanding > 0 ? ` · ${formatMoney(shop.outstanding)} due` : ''}
              </option>
            ))}
          </select>
        </Field>
        <ErrorNote message={shops.error} onRetry={shops.reload} />

        <div className="two-col">
          <Field label="Amount received" htmlFor="payment-amount">
            <input
              id="payment-amount"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={event => setAmount(event.target.value)}
              placeholder="0.00"
              required
            />
          </Field>
          <Field label="Method" htmlFor="payment-method">
            <select
              id="payment-method"
              value={method}
              onChange={event => setMethod(event.target.value)}
            >
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="bank_transfer">Bank transfer</option>
            </select>
          </Field>
        </div>

        <div className="two-col">
          <Field label="Received on" htmlFor="payment-date">
            <input
              id="payment-date"
              type="datetime-local"
              value={receivedAt}
              onChange={event => setReceivedAt(event.target.value)}
            />
          </Field>
          <Field
            label="Reference"
            htmlFor="payment-reference"
            hint="UPI transaction ID, cheque number or bank narration."
          >
            <input
              id="payment-reference"
              type="text"
              value={externalReference}
              onChange={event => setExternalReference(event.target.value)}
              placeholder="Optional"
            />
          </Field>
        </div>

        {shopId && (
          <section>
            <div className="section-title compact">
              <div>
                <h2>Apply to open invoices</h2>
                <p>Oldest confirmed invoices are filled first. Leftover money stays unapplied.</p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={autoAllocate}
                  onChange={event => setAutoAllocate(event.target.checked)}
                />
                <span>Auto-allocate</span>
              </label>
            </div>

            {openSales.loading && <LoadingBlock label="Loading open invoices…" />}
            <ErrorNote message={openSales.error} onRetry={openSales.reload} />

            {!openSales.loading && !openSales.error && !invoices.length && (
              <EmptyState
                icon="check"
                title="No outstanding invoices"
                description="This shop is fully paid up. The payment will be verified as an unapplied credit."
              />
            )}

            {invoices.length > 0 && (
              <div className="allocation-list">
                {allocationRows.map(sale => (
                  <div className="allocation-row" key={sale.sale_id}>
                    <div>
                      <strong>#{sale.sale_number}</strong>
                      <span>
                        {formatDate(sale.business_date)} · balance {formatMoney(sale.balance)}
                      </span>
                    </div>
                    <label>
                      <span className="sr-only">Amount to apply to sale {sale.sale_number}</span>
                      <input
                        type="number"
                        min="0"
                        max={sale.balance}
                        step="0.01"
                        value={autoAllocate ? sale.allocated || '' : allocations[sale.sale_id] ?? ''}
                        disabled={autoAllocate}
                        onChange={event =>
                          setAllocations(previous => ({
                            ...previous,
                            [sale.sale_id]: event.target.value
                          }))
                        }
                        placeholder="0.00"
                      />
                    </label>
                  </div>
                ))}
                <div className="allocation-summary">
                  <span>
                    Applied <strong>{formatMoney(allocatedTotal)}</strong>
                  </span>
                  <span>
                    Unapplied <strong>{formatMoney(unapplied)}</strong>
                  </span>
                </div>
              </div>
            )}
          </section>
        )}

        <InlineNote tone="info">
          <Icon name="clock" size={16} /> A recorded payment does not reduce an invoice balance until
          it is verified. {method === 'cash' ? 'Keep the cash safe until verification.' : 'Reference: '}
          {method === 'cash' ? '' : titleCase(method)}
        </InlineNote>

        {error && (
          <div className="inline-note note-danger" role="alert">
            <Icon name="alert" size={17} />
            <div>{error}</div>
          </div>
        )}
      </form>
    </Modal>
  )
}
