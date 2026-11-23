import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { resolveSalePrice } from '../lib/business'
import { formatMoney, formatNumber } from '../lib/format'
import Icon from './Icon'
import { EmptyState, ErrorNote, Field, InlineNote, LoadingBlock, Modal } from './ui'

function newReference() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `sale-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function blankLine() {
  return { key: newReference(), variantId: '', cartons: '' }
}

export default function NewSaleModal({ open, onClose, onCreated }) {
  const app = useApp()
  const [shopId, setShopId] = useState('')
  const [terms, setTerms] = useState('cash')
  const [lines, setLines] = useState([blankLine()])
  const [reference, setReference] = useState(newReference)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const data = useApiData(
    async () => {
      const [catalog, shops, shopPrices, credit] = await Promise.all([
        api.getCatalog(),
        api.getShops(),
        api.getShopPrices(),
        api.getCreditStatus()
      ])
      return { catalog, shops, shopPrices, credit }
    },
    [app.version],
    { enabled: open }
  )

  useEffect(() => {
    if (!open) return
    setShopId('')
    setTerms('cash')
    setLines([blankLine()])
    setReference(newReference())
    setError('')
  }, [open])

  const approvedShops = (data.data?.shops || []).filter(shop => shop.status === 'approved')
  const catalog = data.data?.catalog || []
  const prices = data.data?.shopPrices || []
  const creditBlocked = Boolean(data.data?.credit?.blocked)

  const totals = useMemo(() => {
    const rows = lines.map(line => {
      const item = catalog.find(entry => entry.variant_id === line.variantId)
      const resolved = shopId ? resolveSalePrice(catalog, prices, shopId, line.variantId) : null
      const cartons = Number(line.cartons || 0)
      return {
        ...line,
        item,
        price: resolved?.amount ?? null,
        source: resolved?.source || null,
        total: resolved ? resolved.amount * cartons : 0,
        cartons
      }
    })
    return {
      rows,
      total: rows.reduce((sum, row) => sum + row.total, 0)
    }
  }, [lines, catalog, prices, shopId])

  function updateLine(key, patch) {
    setLines(current => current.map(line => (line.key === key ? { ...line, ...patch } : line)))
  }

  function addLine() {
    setLines(current => [...current, blankLine()])
  }

  function removeLine(key) {
    setLines(current => (current.length === 1 ? [blankLine()] : current.filter(line => line.key !== key)))
  }

  function closeAndReset() {
    setError('')
    onClose()
  }

  async function submit(event) {
    event.preventDefault()
    setError('')
    if (!shopId) {
      setError('Choose the shop receiving this sale.')
      return
    }
    const prepared = lines
      .filter(line => line.variantId)
      .map(line => ({ variant_id: line.variantId, cartons: Number(line.cartons) }))
    if (!prepared.length) {
      setError('Add at least one product line.')
      return
    }
    if (prepared.some(line => !Number.isInteger(line.cartons) || line.cartons <= 0)) {
      setError('Carton quantities must be positive whole numbers.')
      return
    }
    if (new Set(prepared.map(line => line.variant_id)).size !== prepared.length) {
      setError('Each product can only appear once. Combine the quantities into one line.')
      return
    }
    if (totals.total <= 0) {
      setError('This sale has no value. Check the shop pricing for the selected products.')
      return
    }

    setSaving(true)
    try {
      const result = await api.createSale({
        shopId,
        paymentTerms: terms,
        lines: prepared,
        clientReference: reference
      })
      app.notify(
        result.status === 'confirmed'
          ? `Sale #${result.sale_number} confirmed${result.invoice_number ? ` · invoice ${result.invoice_number}` : ''}.`
          : `Sale #${result.sale_number} sent for credit approval.`,
        result.status === 'confirmed' ? 'success' : 'info'
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
      title="New sale"
      subtitle="Prices come from the shop override first, then the default price list."
      footer={
        data.error && !data.data ? (
          <button type="button" className="button-ghost" onClick={closeAndReset}>
            Cancel
          </button>
        ) : (
          <>
          <div className="foot-total">
            <span>Sale total</span>
            <strong>{formatMoney(totals.total)}</strong>
          </div>
          <button type="button" className="button-ghost" onClick={closeAndReset}>
            Cancel
          </button>
          <button type="submit" form="new-sale-form" className="button-primary" disabled={saving}>
            {saving ? 'Recording…' : terms === 'credit' ? 'Send for approval' : 'Confirm sale'}
          </button>
          </>
        )
      }
    >
      <form id="new-sale-form" className="form-stack" onSubmit={submit}>
        {data.loading && <LoadingBlock label="Loading products and shops…" />}
        <ErrorNote message={data.error} onRetry={data.reload} />

        {!data.loading && !data.error && !approvedShops.length && (
          <EmptyState
            icon="shop"
            title="No approved shops available"
            description="Ask an owner or admin to approve a shop and assign you before recording a sale."
          />
        )}

        {approvedShops.length > 0 && (
          <>
            <div className="two-col">
              <Field label="Shop" htmlFor="sale-shop">
                <select
                  id="sale-shop"
                  value={shopId}
                  onChange={event => setShopId(event.target.value)}
                  required
                >
                  <option value="">Select an approved shop…</option>
                  {approvedShops.map(shop => (
                    <option key={shop.id} value={shop.id}>
                      {shop.name}
                      {shop.city ? ` · ${shop.city}` : ''}
                      {shop.outstanding > 0 ? ` · ${formatMoney(shop.outstanding)} due` : ''}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="field">
                <span className="field-label">Payment terms</span>
                <div className="term-options">
                  {[
                    { id: 'cash', label: 'Cash', icon: 'payments' },
                    { id: 'upi', label: 'UPI', icon: 'device' },
                    { id: 'credit', label: 'Credit', icon: 'clock' }
                  ].map(option => (
                    <button
                      key={option.id}
                      type="button"
                      className={`term-option ${terms === option.id ? 'active' : ''}`}
                      onClick={() => setTerms(option.id)}
                      disabled={option.id === 'credit' && creditBlocked}
                    >
                      <Icon name={option.icon} size={17} />
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {creditBlocked && (
              <InlineNote tone="danger">
                Credit sales are blocked by the owner
                {data.data?.credit?.reason ? `: ${data.data.credit.reason}` : '.'}
              </InlineNote>
            )}

            {terms === 'credit' && !creditBlocked && (
              <InlineNote tone="warning">
                A credit sale waits for owner or admin approval before stock leaves the godown or an
                invoice is issued.
              </InlineNote>
            )}

            {(terms === 'cash' || terms === 'upi') && (
              <InlineNote tone="info">
                The {terms === 'cash' ? 'cash' : 'UPI'} payment is recorded automatically and waits for
                owner or admin verification.
              </InlineNote>
            )}

            <section>
              <div className="line-editor-head">
                <span>Product</span>
                <span>Cartons</span>
                <span>Rate</span>
                <span>Amount</span>
                <span />
              </div>
              <div className="sale-line-list">
                {totals.rows.map((row, index) => {
                  const usedByOthers = lines
                    .filter(line => line.key !== row.key && line.variantId)
                    .map(line => line.variantId)
                  return (
                    <div className="sale-line" key={row.key}>
                      <div className="sale-line-product">
                        <select
                          value={row.variantId}
                          onChange={event =>
                            updateLine(row.key, { variantId: event.target.value })
                          }
                          aria-label={`Product for line ${index + 1}`}
                        >
                          <option value="">Choose product…</option>
                          {catalog.map(item => (
                            <option
                              key={item.variant_id}
                              value={item.variant_id}
                              disabled={usedByOthers.includes(item.variant_id)}
                            >
                              {item.product_name} · {item.bottles_per_carton}/carton
                            </option>
                          ))}
                        </select>
                        {row.item && (
                          <small>
                            Stock: {formatNumber(row.item.stock_saleable)} cartons ·{' '}
                            {formatNumber(
                              row.item.stock_saleable * row.item.bottles_per_carton
                            )}{' '}
                            bottles
                          </small>
                        )}
                      </div>
                      <input
                        className="qty-input"
                        type="number"
                        inputMode="numeric"
                        min="1"
                        step="1"
                        placeholder="0"
                        value={row.cartons || ''}
                        onChange={event => updateLine(row.key, { cartons: event.target.value })}
                        aria-label={`Cartons for line ${index + 1}`}
                      />
                      <div className="sale-line-price">
                        {row.price === null ? (
                          <span className="text-warning">No price</span>
                        ) : (
                          <>
                            <strong>{formatMoney(row.price)}</strong>
                            <small>{row.source === 'shop' ? 'Shop price' : 'Default price'}</small>
                          </>
                        )}
                      </div>
                      <div className="sale-line-total">
                        {row.price === null ? '—' : formatMoney(row.total)}
                      </div>
                      <button
                        type="button"
                        className="icon-button remove-line"
                        onClick={() => removeLine(row.key)}
                        aria-label={`Remove line ${index + 1}`}
                      >
                        <Icon name="close" size={17} />
                      </button>
                    </div>
                  )
                })}
              </div>
              <button type="button" className="button-ghost button-small add-line" onClick={addLine}>
                <Icon name="plus" size={15} /> Add product line
              </button>
            </section>

            {!shopId && (
              <InlineNote tone="warning">
                Select a shop to load its selling prices. Lines show “No price” until then.
              </InlineNote>
            )}
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
