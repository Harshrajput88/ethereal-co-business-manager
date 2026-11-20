import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { fetchCompleteList } from '../lib/fetchCompleteList'
import { formatDate, formatMoney, formatNumber, titleCase } from '../lib/format'
import Icon from '../components/Icon'
import NewSaleModal from '../components/NewSaleModal'
import SaleDetailModal from '../components/SaleDetailModal'
import {
  EmptyState,
  DataLoadFailure,
  ErrorNote,
  InlineNote,
  LoadingBlock,
  PageHeader,
  SearchField,
  StatCard,
  StatusBadge,
  Tabs
} from '../components/ui'

export default function Sales() {
  const app = useApp()
  const [tab, setTab] = useState('all')
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [detailId, setDetailId] = useState('')

  const state = useApiData(
    () => fetchCompleteList(limit => api.getSales({ from: from || null, to: to || null, limit }), 300),
    [app.version, from, to]
  )
  const sales = state.data || []

  const counts = useMemo(
    () => ({
      all: sales.length,
      confirmed: sales.filter(sale => sale.status === 'confirmed').length,
      pending_credit_approval: sales.filter(sale => sale.status === 'pending_credit_approval').length,
      rejected: sales.filter(sale => sale.status === 'rejected').length
    }),
    [sales]
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sales.filter(sale => {
      if (tab !== 'all' && sale.status !== tab) return false
      if (!needle) return true
      return [sale.sale_number, sale.shop_name, sale.salesperson_name, sale.invoice_number]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(needle))
    })
  }, [sales, tab, query])

  const totals = useMemo(() => {
    const confirmed = filtered.filter(sale => sale.status === 'confirmed')
    return {
      value: confirmed.reduce((sum, sale) => sum + Number(sale.grand_total), 0),
      balance: confirmed.reduce((sum, sale) => sum + Number(sale.balance), 0),
      cartons: null
    }
  }, [filtered])

  if (state.error && !state.data) {
    return <DataLoadFailure title="Sales" description="Sales and balances could not be loaded." message={state.error} onRetry={state.reload} />
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Order book"
        title="Sales"
        description="Record shop orders, follow credit approvals and open any sale for its invoice."
        actions={
          <button type="button" className="button-primary" onClick={() => setNewOpen(true)}>
            <Icon name="plus" size={16} /> New sale
          </button>
        }
      />

      {counts.pending_credit_approval > 0 && !app.isAdmin && (
        <InlineNote tone="warning">
          {counts.pending_credit_approval} credit sale
          {counts.pending_credit_approval === 1 ? ' is' : 's are'} waiting for an owner or admin.
          Stock and invoices are issued after approval.
        </InlineNote>
      )}

      {counts.pending_credit_approval > 0 && app.isAdmin && (
        <InlineNote tone="warning">
          <strong>{counts.pending_credit_approval} credit sale{counts.pending_credit_approval === 1 ? '' : 's'} need a decision.</strong>{' '}
          Open the sale to approve or reject it.
        </InlineNote>
      )}

      <div className="stats-grid compact-grid">
        <StatCard
          label="Sales in view"
          value={formatNumber(counts.confirmed)}
          hint={`${formatMoney(totals.value)} confirmed value`}
          icon="sales"
        />
        <StatCard
          label="Outstanding in view"
          value={formatMoney(totals.balance)}
          hint="After verified payments and returns"
          icon="clock"
          tone="orange"
        />
        <StatCard
          label="Awaiting credit approval"
          value={formatNumber(counts.pending_credit_approval)}
          hint={app.isAdmin ? 'Open a sale to decide' : 'Owner or admin action needed'}
          icon="alert"
          tone={counts.pending_credit_approval ? 'orange' : 'green'}
        />
      </div>

      <div className="toolbar wrap">
        <Tabs
          items={[
            { id: 'all', label: 'All', count: counts.all },
            { id: 'confirmed', label: 'Confirmed', count: counts.confirmed },
            {
              id: 'pending_credit_approval',
              label: 'Credit pending',
              count: counts.pending_credit_approval
            },
            { id: 'rejected', label: 'Rejected', count: counts.rejected }
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="toolbar-right">
          <label className="date-field">
            <span>From</span>
            <input type="date" value={from} onChange={event => setFrom(event.target.value)} />
          </label>
          <label className="date-field">
            <span>To</span>
            <input type="date" value={to} onChange={event => setTo(event.target.value)} />
          </label>
          {(from || to) && (
            <button
              type="button"
              className="button-ghost button-small"
              onClick={() => {
                setFrom('')
                setTo('')
              }}
            >
              Clear
            </button>
          )}
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search shop, invoice or #…"
            label="Search sales"
          />
        </div>
      </div>

      <ErrorNote message={state.error} onRetry={state.reload} />
      {state.loading && !sales.length && <LoadingBlock label="Loading sales…" />}

      <section className="card no-pad">
        {filtered.length ? (
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr>
                  <th>Sale</th>
                  <th>Date</th>
                  <th>Shop</th>
                  <th>Recorded by</th>
                  <th>Terms</th>
                  <th className="num">Total</th>
                  <th className="num">Balance</th>
                  <th>Status</th>
                  <th>Invoice</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map(sale => (
                  <tr key={sale.id} onClick={() => setDetailId(sale.id)}>
                    <td>
                      <strong>#{sale.sale_number}</strong>
                      <small>{sale.invoice_number || 'No invoice'}</small>
                    </td>
                    <td>{formatDate(sale.business_date)}</td>
                    <td>{sale.shop_name}</td>
                    <td>{sale.salesperson_name}</td>
                    <td>{titleCase(sale.payment_terms)}</td>
                    <td className="num">{formatMoney(sale.grand_total)}</td>
                    <td className="num">{formatMoney(sale.balance)}</td>
                    <td>
                      <StatusBadge status={sale.status} />
                    </td>
                    <td>
                      {sale.invoice_number ? (
                        <span className="invoice-chip">
                          <Icon name="invoices" size={13} />
                          {sale.invoice_number.replace('ETC-INV-', '')}
                        </span>
                      ) : (
                        <span className="muted-copy">—</span>
                      )}
                    </td>
                    <td className="row-arrow">
                      <Icon name="arrow" size={15} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon="sales"
            title={query || from || to ? 'No sales match these filters' : 'No sales yet'}
            description={
              query || from || to
                ? 'Adjust the date range or search text.'
                : 'Record a sale for an approved shop to get started.'
            }
            action={
              <button type="button" className="button-primary button-small" onClick={() => setNewOpen(true)}>
                <Icon name="plus" size={15} /> New sale
              </button>
            }
          />
        )}
      </section>

      <NewSaleModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={result => setDetailId(result.sale_id)}
      />
      <SaleDetailModal
        open={Boolean(detailId)}
        saleId={detailId}
        onClose={() => setDetailId('')}
      />
    </div>
  )
}
