import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { formatDate, formatMoney, formatNumber } from '../lib/format'
import Icon from './Icon'
import { EmptyState, ErrorNote, Field, InlineNote, LoadingBlock, Modal, StatusBadge } from './ui'

export default function ReturnModal({ open, onClose, saleId = null, onSubmitted }) {
  const app = useApp()
  const [selectedSaleId, setSelectedSaleId] = useState(saleId || '')
  const [reason, setReason] = useState('')
  const [quantities, setQuantities] = useState({})
  const [conditions, setConditions] = useState({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const sales = useApiData(() => api.getSales({ limit: 300 }), [app.version], {
    enabled: open && !saleId
  })
  const detail = useApiData(
    () => api.getSaleDetail(saleId || selectedSaleId),
    [saleId, selectedSaleId, app.version],
    { enabled: open && Boolean(saleId || selectedSaleId) }
  )

  useEffect(() => {
    if (!open) {
      setReason('')
      setQuantities({})
      setConditions({})
      setError('')
      setSelectedSaleId(saleId || '')
    }
  }, [open, saleId])

  useEffect(() => {
    if (!detail.data) return
    setQuantities({})
    setConditions(
      Object.fromEntries(detail.data.lines.map(line => [line.id, 'reusable']))
    )
  }, [detail.data])

  const sale = detail.data
  const confirmedSales = (sales.data || []).filter(item => item.status === 'confirmed')
  const selectedLines = sale
    ? sale.lines
        .map(line => ({
          line,
          cartons: Number(quantities[line.id] || 0),
          condition: conditions[line.id] || 'reusable'
        }))
        .filter(row => row.cartons > 0)
    : []
  const creditPreview = selectedLines.reduce(
    (total, row) => total + row.cartons * Number(row.line.unit_price),
    0
  )

  function updateQuantity(lineId, value) {
    setQuantities(previous => ({ ...previous, [lineId]: value }))
  }

  function closeAndReset() {
    setReason('')
    setQuantities({})
    setError('')
    onClose()
  }

  async function submit(event) {
    event.preventDefault()
    setError('')
    if (!sale) {
      setError('Choose the sale you want to return.')
      return
    }
    if (!reason.trim()) {
      setError('Explain why the stock is coming back.')
      return
    }
    if (!selectedLines.length) {
      setError('Enter a carton quantity for at least one product.')
      return
    }
    const invalid = selectedLines.find(row => row.cartons > Number(row.line.cartons))
    if (invalid) {
      setError(`Return cannot exceed the ${invalid.line.cartons} cartons sold of ${invalid.line.product_name}.`)
      return
    }

    setSaving(true)
    try {
      await api.submitReturn({
        saleId: sale.id,
        reason: reason.trim(),
        lines: selectedLines.map(row => ({
          sale_line_id: row.line.id,
          cartons: row.cartons,
          condition: row.condition
        }))
      })
      app.notify('Return request submitted for review.', 'success')
      app.refresh()
      onSubmitted?.()
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
      title="Request a return"
      subtitle={
        sale
          ? `Sale #${sale.sale_number} · ${sale.shop?.name}`
          : 'Choose a confirmed sale and the products coming back.'
      }
      footer={
        <>
          <button type="button" className="button-ghost" onClick={closeAndReset}>
            Cancel
          </button>
          <button
            type="submit"
            form="return-form"
            className="button-primary"
            disabled={saving || !sale}
          >
            {saving ? 'Submitting…' : 'Submit return'}
          </button>
        </>
      }
    >
      <form id="return-form" className="form-stack" onSubmit={submit}>
        {!saleId && (
          <Field
            label="Confirmed sale"
            htmlFor="return-sale"
            hint="Only confirmed sales can be returned."
          >
            <select
              id="return-sale"
              value={selectedSaleId}
              onChange={event => {
                setSelectedSaleId(event.target.value)
                setError('')
              }}
            >
              <option value="">Select a sale…</option>
              {confirmedSales.map(item => (
                <option key={item.id} value={item.id}>
                  #{item.sale_number} · {item.shop_name} · {formatDate(item.business_date)} ·{' '}
                  {formatMoney(item.grand_total)}
                </option>
              ))}
            </select>
          </Field>
        )}

        {sales.loading && !saleId && <LoadingBlock label="Loading sales…" />}
        <ErrorNote message={sales.error} onRetry={sales.reload} />

        {!saleId && !sales.loading && !sales.error && !confirmedSales.length && (
          <EmptyState
            icon="sales"
            title="No confirmed sales yet"
            description="A return can only be requested against a confirmed sale."
          />
        )}

        {detail.loading && <LoadingBlock label="Loading sale lines…" />}
        <ErrorNote message={detail.error} onRetry={detail.reload} />

        {sale && (
          <>
            <div className="return-sale-strip">
              <div>
                <strong>#{sale.sale_number}</strong>
                <span>
                  {sale.shop?.name} · {formatDate(sale.business_date)}
                </span>
              </div>
              <StatusBadge status={sale.status} />
            </div>

            {!sale.lines.length ? (
              <EmptyState icon="inventory" title="This sale has no lines" />
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num">Sold</th>
                      <th>Return cartons</th>
                      <th>Condition</th>
                      <th className="num">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sale.lines.map(line => {
                      const cartons = Number(quantities[line.id] || 0)
                      return (
                        <tr key={line.id}>
                          <td>
                            <strong>{line.product_name}</strong>
                            <small>{line.sku}</small>
                          </td>
                          <td className="num">{formatNumber(line.cartons)}</td>
                          <td>
                            <input
                              className="qty-input"
                              type="number"
                              inputMode="numeric"
                              min="0"
                              max={line.cartons}
                              step="1"
                              value={quantities[line.id] ?? ''}
                              placeholder="0"
                              onChange={event => updateQuantity(line.id, event.target.value)}
                              aria-label={`Cartons of ${line.product_name} to return`}
                            />
                          </td>
                          <td>
                            <select
                              value={conditions[line.id] || 'reusable'}
                              onChange={event =>
                                setConditions(previous => ({
                                  ...previous,
                                  [line.id]: event.target.value
                                }))
                              }
                              aria-label={`Return condition for ${line.product_name}`}
                            >
                              <option value="reusable">Reusable</option>
                              <option value="damaged">Damaged</option>
                            </select>
                          </td>
                          <td className="num">
                            {formatMoney(cartons * Number(line.unit_price))}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <InlineNote tone={selectedLines.length ? 'info' : 'warning'}>
              {selectedLines.length ? (
                <>
                  Estimated credit at sold rates: <strong>{formatMoney(creditPreview)}</strong>. The
                  owner or admin confirms the final approved quantity.
                </>
              ) : (
                'Enter carton quantities to build the return request.'
              )}
            </InlineNote>

            <Field
              label="Reason for return"
              htmlFor="return-reason"
              hint="Visible to the reviewer and recorded in the audit log."
            >
              <textarea
                id="return-reason"
                rows="3"
                value={reason}
                onChange={event => setReason(event.target.value)}
                placeholder="e.g. Three cartons were damaged in transit"
                required
              />
            </Field>

            <InlineNote tone="info">
              <Icon name="inventory" size={16} /> Reusable cartons return to saleable stock; damaged
              cartons go to the damaged bucket. Nothing changes until the request is approved.
            </InlineNote>
          </>
        )}

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
