import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { formatDate, formatMoney, formatNumber } from '../lib/format'
import Icon from '../components/Icon'
import SaleDetailModal from '../components/SaleDetailModal'
import {
  EmptyState,
  DataLoadFailure,
  ErrorNote,
  LoadingBlock,
  PageHeader,
  SearchField,
  StatCard,
  StatusBadge
} from '../components/ui'

export default function Invoices() {
  const app = useApp()
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [saleId, setSaleId] = useState('')

  const state = useApiData(
    () => api.getSales({ from: from || null, to: to || null, limit: 500 }),
    [app.version, from, to]
  )
  const invoices = useMemo(
    () => (state.data || []).filter(sale => sale.status === 'confirmed' && sale.invoice_number),
    [state.data]
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return invoices
    return invoices.filter(sale =>
      [sale.invoice_number, sale.shop_name, sale.salesperson_name, sale.sale_number]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(needle))
    )
  }, [invoices, query])

  const totals = useMemo(
    () => ({
      value: filtered.reduce((sum, sale) => sum + Number(sale.grand_total), 0),
      balance: filtered.reduce((sum, sale) => sum + Number(sale.balance), 0)
    }),
    [filtered]
  )

  if (state.error && !state.data) {
    return <DataLoadFailure title="Invoices" description="Invoice records and balances could not be loaded." message={state.error} onRetry={state.reload} />
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Documents"
        title="Invoices"
        description="Open any confirmed sale’s invoice and print it or save it as a PDF."
      />

      <div className="stats-grid compact-grid">
        <StatCard
          label="Invoices in view"
          value={formatNumber(filtered.length)}
          hint={`${formatNumber(invoices.length)} total`}
          icon="invoices"
        />
        <StatCard
          label="Invoice value"
          value={formatMoney(totals.value)}
          hint="Confirmed sales"
          icon="sales"
          tone="blue"
        />
        <StatCard
          label="Unpaid on invoices"
          value={formatMoney(totals.balance)}
          hint="After verified payments and returns"
          icon="clock"
          tone="orange"
        />
      </div>

      <div className="toolbar wrap">
        <div className="toolbar-right">
          <label className="date-field">
            <span>From</span>
            <input type="date" value={from} onChange={event => setFrom(event.target.value)} />
          </label>
          <label className="date-field">
            <span>To</span>
            <input type="date" value={to} onChange={event => setTo(event.target.value)} />
          </label>
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Invoice, shop or sale #…"
            label="Search invoices"
          />
        </div>
      </div>

      <ErrorNote message={state.error} onRetry={state.reload} />
      {state.loading && !invoices.length && <LoadingBlock label="Loading invoices…" />}

      <section className="card no-pad">
        {filtered.length ? (
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Issued</th>
                  <th>Shop</th>
                  <th>Sale</th>
                  <th>Recorded by</th>
                  <th className="num">Total</th>
                  <th className="num">Balance</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map(sale => (
                  <tr key={sale.id} onClick={() => setSaleId(sale.id)}>
                    <td>
                      <strong>{sale.invoice_number}</strong>
                    </td>
                    <td>{formatDate(sale.business_date)}</td>
                    <td>{sale.shop_name}</td>
                    <td>#{sale.sale_number}</td>
                    <td>{sale.salesperson_name}</td>
                    <td className="num">{formatMoney(sale.grand_total)}</td>
                    <td className="num">{formatMoney(sale.balance)}</td>
                    <td>
                      <StatusBadge status={sale.status} />
                    </td>
                    <td className="row-arrow">
                      <Icon name="print" size={15} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon="invoices"
            title={query || from || to ? 'No invoices match' : 'No invoices yet'}
            description={
              query || from || to
                ? 'Try another search or widen the date range.'
                : 'Confirm a sale and its invoice number will appear here.'
            }
          />
        )}
      </section>

      <p className="page-foot">
        Tip: open an invoice and use Print → Save as PDF to share it on WhatsApp or email.
      </p>

      <SaleDetailModal
        open={Boolean(saleId)}
        saleId={saleId}
        focusInvoice
        onClose={() => setSaleId('')}
      />
    </div>
  )
}
