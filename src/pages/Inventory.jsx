import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { fetchCompleteList } from '../lib/fetchCompleteList'
import { downloadCsv, formatDateTime, formatMoney, formatNumber, titleCase } from '../lib/format'
import Icon from '../components/Icon'
import {
  Badge,
  DataLoadFailure,
  EmptyState,
  ErrorNote,
  Field,
  InlineNote,
  LoadingBlock,
  Modal,
  PageHeader,
  ProgressBar,
  SearchField,
  StatCard
} from '../components/ui'

export default function Inventory() {
  const app = useApp()
  const [query, setQuery] = useState('')
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [variantId, setVariantId] = useState('')
  const [cartons, setCartons] = useState('')
  const [bucket, setBucket] = useState('saleable')
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const state = useApiData(() => api.getInventory(), [app.version])
  const stock = state.data?.stock || []
  const movements = state.data?.movements || []

  const totals = useMemo(
    () => ({
      saleable: stock.reduce((sum, item) => sum + Number(item.saleable), 0),
      damaged: stock.reduce((sum, item) => sum + Number(item.damaged), 0),
      bottles: stock.reduce(
        (sum, item) => sum + Number(item.saleable) * Number(item.bottles_per_carton),
        0
      )
    }),
    [stock]
  )

  const filteredMovements = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return movements
    return movements.filter(move =>
      [move.product_name, move.movement_type, move.reason, move.actor_name, move.stock_bucket]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(needle))
    )
  }, [movements, query])

  const selected = stock.find(item => item.variant_id === variantId)
  const currentBucket = selected?.[bucket] ?? 0

  function openReceive() {
    setVariantId(stock[0]?.variant_id || '')
    setCartons('')
    setReason('Stock received from production')
    setError('')
    setReceiveOpen(true)
  }

  function openAdjust() {
    setVariantId(stock[0]?.variant_id || '')
    setBucket('saleable')
    setDelta('')
    setReason('')
    setError('')
    setAdjustOpen(true)
  }

  async function submitReceive(event) {
    event.preventDefault()
    setError('')
    if (!variantId) {
      setError('Choose a product.')
      return
    }
    if (!Number.isInteger(Number(cartons)) || Number(cartons) <= 0) {
      setError('Enter a positive whole number of cartons.')
      return
    }
    setSaving(true)
    try {
      await api.receiveStock({ variantId, cartons: Number(cartons), reason })
      app.notify(`${cartons} cartons received into saleable stock.`, 'success')
      app.refresh()
      setReceiveOpen(false)
      state.reload({ quiet: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function submitAdjust(event) {
    event.preventDefault()
    setError('')
    if (!variantId) {
      setError('Choose a product.')
      return
    }
    if (!Number.isInteger(Number(delta)) || Number(delta) === 0) {
      setError('Enter a non-zero whole number. Use a minus sign to reduce stock.')
      return
    }
    if (!reason.trim()) {
      setError('Explain why this adjustment is needed.')
      return
    }
    if (currentBucket + Number(delta) < 0) {
      setError(`This would make ${bucket} stock negative. Current: ${currentBucket} cartons.`)
      return
    }
    setSaving(true)
    try {
      await api.adjustStock({ variantId, bucket, delta: Number(delta), reason: reason.trim() })
      app.notify('Stock adjustment recorded.', 'success')
      app.refresh()
      setAdjustOpen(false)
      state.reload({ quiet: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function exportStock() {
    downloadCsv(
      'ethereal-stock.csv',
      stock.map(item => ({
        product: item.product_name,
        sku: item.sku,
        pack_ml: item.pack_size_ml,
        bottles_per_carton: item.bottles_per_carton,
        saleable_cartons: item.saleable,
        damaged_cartons: item.damaged,
        default_price: item.default_price
      }))
    )
  }

  if (state.error && !state.data) {
    return <DataLoadFailure title="Inventory" description="Stock balances and movement history could not be loaded." message={state.error} onRetry={state.reload} />
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Godown"
        title="Inventory"
        description="Track saleable and damaged cartons, receive production and correct counts with a reason."
        actions={
          <>
            <button type="button" className="button-ghost" onClick={exportStock} disabled={!stock.length}>
              <Icon name="download" size={16} /> Export
            </button>
            {app.isAdmin && (
              <>
                <button type="button" className="button-secondary" onClick={openAdjust}>
                  Adjust stock
                </button>
                <button type="button" className="button-primary" onClick={openReceive}>
                  <Icon name="plus" size={16} /> Receive stock
                </button>
              </>
            )}
          </>
        }
      />

      {!app.isAdmin && (
        <InlineNote tone="info">
          Stock is read-only for salespeople. Ask an owner or admin to receive or adjust stock.
        </InlineNote>
      )}

      <div className="stats-grid compact-grid">
        <StatCard
          label="Saleable cartons"
          value={formatNumber(totals.saleable)}
          hint={`${formatNumber(totals.bottles)} bottles available`}
          icon="inventory"
        />
        <StatCard
          label="Damaged cartons"
          value={formatNumber(totals.damaged)}
          hint="Held out of saleable stock"
          icon="alert"
          tone={totals.damaged ? 'danger' : 'muted'}
        />
        <StatCard
          label="Products tracked"
          value={formatNumber(stock.length)}
          hint="Active pack sizes"
          icon="bottle"
          tone="blue"
        />
      </div>

      <ErrorNote message={state.error} onRetry={state.reload} />
      {state.loading && !stock.length && <LoadingBlock label="Loading stock…" />}

      <section className="card">
        <div className="section-title">
          <div>
            <h2>Stock by product</h2>
            <p>One carton contains the bottles shown for each pack size.</p>
          </div>
        </div>
        {stock.length ? (
          <div className="stock-table">
            {stock.map(item => {
              const bottles = item.saleable * item.bottles_per_carton
              const damaged = item.damaged
              return (
                <article className="stock-product" key={item.variant_id}>
                  <span className="stock-bottle large">
                    <Icon name="bottle" size={30} />
                  </span>
                  <div className="stock-product-main">
                    <div>
                      <h3>{item.product_name}</h3>
                      <p>
                        {item.sku} · {item.bottles_per_carton} bottles / carton
                      </p>
                    </div>
                    <div className="stock-product-numbers">
                      <div>
                        <strong>{formatNumber(item.saleable)}</strong>
                        <span>saleable cartons</span>
                      </div>
                      <div>
                        <strong>{formatNumber(bottles)}</strong>
                        <span>bottles</span>
                      </div>
                      <div>
                        <strong>{formatMoney(item.default_price)}</strong>
                        <span>default price</span>
                      </div>
                      <div>
                        <strong className={damaged ? 'text-danger' : ''}>
                          {formatNumber(damaged)}
                        </strong>
                        <span>damaged</span>
                      </div>
                    </div>
                    <ProgressBar
                      value={item.saleable}
                      max={Math.max(1, item.saleable + 100)}
                      tone={item.saleable < 20 ? 'danger' : 'green'}
                    />
                  </div>
                  {item.saleable < 20 && (
                    <Badge tone="warning" className="stock-low">
                      Low stock
                    </Badge>
                  )}
                </article>
              )
            })}
          </div>
        ) : (
          <EmptyState icon="inventory" title="No active products" />
        )}
      </section>

      <section className="card no-pad">
        <div className="card-head">
          <div>
            <h2>Movement ledger</h2>
            <p>Every sale, receipt, return and adjustment is recorded.</p>
          </div>
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Product, type or note…"
            label="Search stock movements"
          />
        </div>
        {filteredMovements.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Product</th>
                  <th>Type</th>
                  <th>Bucket</th>
                  <th className="num">Change</th>
                  <th>Actor</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {filteredMovements.map(move => (
                  <tr key={move.id}>
                    <td>{formatDateTime(move.occurred_at)}</td>
                    <td>
                      <strong>{move.product_name}</strong>
                      <small>{formatNumber(move.cartons_delta * move.bottles_per_carton)} bottles</small>
                    </td>
                    <td>{titleCase(move.movement_type)}</td>
                    <td>
                      <Badge tone={move.stock_bucket === 'damaged' ? 'danger' : 'neutral'}>
                        {titleCase(move.stock_bucket)}
                      </Badge>
                    </td>
                    <td
                      className={`num ${
                        Number(move.cartons_delta) >= 0 ? 'text-success' : 'text-danger'
                      }`}
                    >
                      {Number(move.cartons_delta) > 0 ? '+' : ''}
                      {formatNumber(move.cartons_delta)}
                    </td>
                    <td>{move.actor_name}</td>
                    <td className="wrap-cell">{move.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon="inventory"
            title={query ? 'No movements match' : 'No stock movements yet'}
            description={query ? 'Try another search.' : 'Receipts, sales and returns will appear here.'}
          />
        )}
      </section>

      <Modal
        open={receiveOpen}
        onClose={() => setReceiveOpen(false)}
        title="Receive stock"
        subtitle="Adds cartons to saleable stock immediately."
        footer={
          <>
            <button type="button" className="button-ghost" onClick={() => setReceiveOpen(false)}>
              Cancel
            </button>
            <button type="submit" form="receive-form" className="button-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Receive stock'}
            </button>
          </>
        }
      >
        <form id="receive-form" className="form-stack" onSubmit={submitReceive}>
          <Field label="Product" htmlFor="receive-product">
            <select
              id="receive-product"
              value={variantId}
              onChange={event => setVariantId(event.target.value)}
              required
            >
              {stock.map(item => (
                <option key={item.variant_id} value={item.variant_id}>
                  {item.product_name} · current {item.saleable} cartons
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cartons received" htmlFor="receive-cartons">
            <input
              id="receive-cartons"
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={cartons}
              onChange={event => setCartons(event.target.value)}
              placeholder="0"
              required
            />
          </Field>
          <Field label="Note" htmlFor="receive-reason" hint="e.g. production batch, transfer from another godown.">
            <input
              id="receive-reason"
              value={reason}
              onChange={event => setReason(event.target.value)}
            />
          </Field>
          {selected && (
            <InlineNote tone="info">
              {selected.product_name} will go from {selected.saleable} to{' '}
              {selected.saleable + Number(cartons || 0)} saleable cartons.
            </InlineNote>
          )}
          {error && (
            <div className="inline-note note-danger" role="alert">
              <Icon name="alert" size={17} />
              <div>{error}</div>
            </div>
          )}
        </form>
      </Modal>

      <Modal
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        title="Adjust stock"
        subtitle="Use a negative number to reduce stock. A reason is always recorded."
        footer={
          <>
            <button type="button" className="button-ghost" onClick={() => setAdjustOpen(false)}>
              Cancel
            </button>
            <button type="submit" form="adjust-form" className="button-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save adjustment'}
            </button>
          </>
        }
      >
        <form id="adjust-form" className="form-stack" onSubmit={submitAdjust}>
          <Field label="Product" htmlFor="adjust-product">
            <select
              id="adjust-product"
              value={variantId}
              onChange={event => setVariantId(event.target.value)}
            >
              {stock.map(item => (
                <option key={item.variant_id} value={item.variant_id}>
                  {item.product_name}
                </option>
              ))}
            </select>
          </Field>
          <div className="two-col">
            <Field label="Bucket" htmlFor="adjust-bucket">
              <select id="adjust-bucket" value={bucket} onChange={event => setBucket(event.target.value)}>
                <option value="saleable">Saleable</option>
                <option value="damaged">Damaged</option>
              </select>
            </Field>
            <Field
              label="Change in cartons"
              htmlFor="adjust-delta"
              hint={selected ? `Current ${bucket}: ${currentBucket}` : undefined}
            >
              <input
                id="adjust-delta"
                type="number"
                inputMode="numeric"
                step="1"
                value={delta}
                onChange={event => setDelta(event.target.value)}
                placeholder="e.g. -2 or 5"
                required
              />
            </Field>
          </div>
          <Field label="Reason" htmlFor="adjust-reason">
            <textarea
              id="adjust-reason"
              rows="2"
              value={reason}
              onChange={event => setReason(event.target.value)}
              placeholder="e.g. Physical count correction"
              required
            />
          </Field>
          {selected && delta && (
            <InlineNote tone={currentBucket + Number(delta) < 0 ? 'danger' : 'info'}>
              New {bucket} stock: {currentBucket + Number(delta)} cartons.
            </InlineNote>
          )}
          {error && (
            <div className="inline-note note-danger" role="alert">
              <Icon name="alert" size={17} />
              <div>{error}</div>
            </div>
          )}
        </form>
      </Modal>
    </div>
  )
}
