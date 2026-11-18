import { useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { formatCompactMoney, formatDate, formatMoney, formatNumber, titleCase } from '../lib/format'
import Icon from '../components/Icon'
import NewSaleModal from '../components/NewSaleModal'
import PaymentModal from '../components/PaymentModal'
import SaleDetailModal from '../components/SaleDetailModal'
import {
  EmptyState,
  DataLoadFailure,
  ErrorNote,
  InlineNote,
  LoadingBlock,
  PageHeader,
  ProgressBar,
  SectionTitle,
  StatCard,
  StatusBadge
} from '../components/ui'

function greeting() {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      hour12: false
    }).format(new Date())
  )
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export default function Overview({ onNavigate }) {
  const app = useApp()
  const [saleOpen, setSaleOpen] = useState(false)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [detailId, setDetailId] = useState('')

  const state = useApiData(
    async () => {
      const [dashboard, credit] = await Promise.all([api.getDashboard(), api.getCreditStatus()])
      return { dashboard, credit }
    },
    [app.version]
  )

  const dashboard = state.data?.dashboard
  const credit = state.data?.credit
  const firstName = (app.profile?.full_name || '').split(' ')[0] || 'there'

  const pending = dashboard
    ? [
        app.isAdmin && {
          id: 'sales',
          label: 'Credit sales',
          value: dashboard.pending_credit_sales,
          icon: 'clock'
        },
        app.isAdmin && {
          id: 'payments',
          label: 'Payments',
          value: dashboard.pending_payments,
          icon: 'payments'
        },
        app.isAdmin && {
          id: 'returns',
          label: 'Returns',
          value: dashboard.pending_returns,
          icon: 'returns'
        },
        app.isAdmin && {
          id: 'expenses',
          label: 'Expenses',
          value: dashboard.pending_expenses,
          icon: 'expenses'
        },
        app.isAdmin && {
          id: 'shops',
          label: 'Shops',
          value: dashboard.pending_shops,
          icon: 'shop'
        },
        app.isAdmin && {
          id: 'team',
          label: 'People',
          value: dashboard.pending_employees,
          icon: 'team'
        }
      ].filter(Boolean)
    : []

  const waitingOnOthers = dashboard
    ? dashboard.pending_credit_sales +
      dashboard.pending_payments +
      dashboard.pending_returns +
      dashboard.pending_expenses
    : 0

  if (state.error && !state.data) {
    return (
      <DataLoadFailure
        title="Overview"
        description="Business metrics are unavailable until the database request succeeds."
        message={state.error}
        onRetry={state.reload}
      />
    )
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={formatDate(dashboard?.business_date || new Date())}
        title={`${greeting()}, ${firstName}`}
        description="A clear view of sales, collections and everything waiting on a decision."
        actions={
          <>
            <button type="button" className="button-secondary" onClick={() => setPaymentOpen(true)}>
              <Icon name="payments" size={16} /> Record payment
            </button>
            <button type="button" className="button-primary" onClick={() => setSaleOpen(true)}>
              <Icon name="plus" size={16} /> New sale
            </button>
          </>
        }
      />

      {app.mode === 'local' && (
        <InlineNote tone="info">
          <strong>Local demo workspace.</strong> Everything is stored in this browser, not in
          Supabase. Use the demo accounts to explore all roles. Manage or reset this workspace from
          Settings.
        </InlineNote>
      )}

      {credit?.blocked && (
        <div className="inline-note note-danger">
          <Icon name="lock" size={18} />
          <div>
            <strong>Credit sales are blocked.</strong> {credit.reason || 'No reason recorded.'}{' '}
            {app.isOwner && <button type="button" className="link-button" onClick={() => onNavigate('settings')}>Manage in settings</button>}
          </div>
        </div>
      )}

      <ErrorNote message={state.error} onRetry={state.reload} />
      {state.loading && !dashboard && <LoadingBlock label="Loading your dashboard…" />}

      {dashboard && (
        <>
          <div className="stats-grid">
            <StatCard
              label="Today's sales"
              value={formatMoney(dashboard.today_sales)}
              hint={`${formatNumber(dashboard.today_transactions)} confirmed sale${
                dashboard.today_transactions === 1 ? '' : 's'
              }`}
              icon="sales"
              tone="green"
            />
            <StatCard
              label="Collected today"
              value={formatMoney(dashboard.collected_today)}
              hint="Verified payments only"
              icon="payments"
              tone="blue"
            />
            <StatCard
              label="Outstanding"
              value={formatMoney(dashboard.outstanding)}
              hint="Across confirmed invoices"
              icon="clock"
              tone="orange"
            />
            <StatCard
              label="This month"
              value={formatMoney(dashboard.month_sales)}
              hint={`${formatMoney(dashboard.month_collected)} collected`}
              icon="reports"
              tone="violet"
            />
          </div>

          {app.isAdmin ? (
            <section className="card">
              <SectionTitle
                title="Approvals"
                description="Decisions that keep stock, cash and credit moving."
                action={
                  pending.some(item => item.value > 0) ? (
                    <span className="pill-count">
                      {pending.reduce((sum, item) => sum + item.value, 0)} waiting
                    </span>
                  ) : (
                    <span className="all-clear">
                      <Icon name="check" size={15} /> All clear
                    </span>
                  )
                }
              />
              <div className="approval-grid">
                {pending.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`approval-tile ${item.value > 0 ? 'has-work' : ''}`}
                    onClick={() => onNavigate(item.id)}
                  >
                    <span className="approval-icon">
                      <Icon name={item.icon} size={19} />
                    </span>
                    <span>
                      <strong>{item.value}</strong>
                      {item.label}
                    </span>
                    <Icon name="arrow" size={16} />
                  </button>
                ))}
              </div>
            </section>
          ) : (
            waitingOnOthers > 0 && (
              <section className="card">
                <SectionTitle
                  title="Waiting on review"
                  description="Your submissions that an owner or admin still needs to action."
                />
                <div className="pending-strip">
                  <div>
                    <strong>{dashboard.pending_credit_sales}</strong>
                    <span>Credit sales</span>
                  </div>
                  <div>
                    <strong>{dashboard.pending_payments}</strong>
                    <span>Payments</span>
                  </div>
                  <div>
                    <strong>{dashboard.pending_returns}</strong>
                    <span>Returns</span>
                  </div>
                  <div>
                    <strong>{dashboard.pending_expenses}</strong>
                    <span>Expenses</span>
                  </div>
                </div>
              </section>
            )
          )}

          <div className="overview-grid">
            <section className="card">
              <SectionTitle
                title="Stock on hand"
                description="Saleable and damaged cartons by pack size."
                action={
                  <button type="button" className="link-button" onClick={() => onNavigate('inventory')}>
                    Inventory <Icon name="arrow" size={14} />
                  </button>
                }
              />
              {dashboard.stock.length ? (
                <div className="stock-list">
                  {dashboard.stock.map(item => {
                    const bottles = item.saleable * item.bottles_per_carton
                    return (
                      <div className="stock-row" key={item.variant_id}>
                        <span className="stock-bottle">
                          <Icon name="bottle" size={26} />
                        </span>
                        <div className="stock-copy">
                          <strong>{item.product_name}</strong>
                          <span>{item.bottles_per_carton} bottles per carton</span>
                          <ProgressBar
                            value={item.saleable}
                            max={Math.max(1, item.saleable + 120)}
                            tone={item.saleable < 20 ? 'danger' : 'green'}
                          />
                        </div>
                        <div className="stock-numbers">
                          <strong>{formatNumber(item.saleable)}</strong>
                          <span>cartons</span>
                          <small>{formatCompactMoney(bottles)} bottles</small>
                        </div>
                        {item.damaged > 0 && (
                          <span className="stock-damaged">{item.damaged} damaged</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <EmptyState icon="inventory" title="No active products" />
              )}
            </section>

            <section className="card">
              <SectionTitle
                title="Today's focus"
                description="Small numbers that deserve attention."
              />
              <dl className="focus-list">
                <div>
                  <dt>Month expenses</dt>
                  <dd>{formatMoney(dashboard.month_expenses)}</dd>
                </div>
                <div>
                  <dt>Month net (sales − expenses)</dt>
                  <dd>{formatMoney(dashboard.month_sales - dashboard.month_expenses)}</dd>
                </div>
                <div>
                  <dt>Average confirmed sale</dt>
                  <dd>
                    {formatMoney(
                      dashboard.today_transactions
                        ? dashboard.today_sales / dashboard.today_transactions
                        : 0
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Outstanding per sale</dt>
                  <dd>
                    {formatMoney(
                      dashboard.today_transactions
                        ? dashboard.outstanding / dashboard.today_transactions
                        : dashboard.outstanding
                    )}
                  </dd>
                </div>
              </dl>
              <div className="quick-actions">
                <button type="button" className="quick-action" onClick={() => onNavigate('returns')}>
                  <Icon name="returns" size={18} />
                  <span>Returns</span>
                </button>
                <button type="button" className="quick-action" onClick={() => onNavigate('expenses')}>
                  <Icon name="expenses" size={18} />
                  <span>Expenses</span>
                </button>
                <button type="button" className="quick-action" onClick={() => onNavigate('reports')}>
                  <Icon name="reports" size={18} />
                  <span>Reports</span>
                </button>
              </div>
            </section>
          </div>

          <section className="card">
            <SectionTitle
              title="Recent sales"
              description="Latest activity, newest first."
              action={
                <button type="button" className="link-button" onClick={() => onNavigate('sales')}>
                  All sales <Icon name="arrow" size={14} />
                </button>
              }
            />
            {dashboard.recent_sales.length ? (
              <div className="table-wrap">
                <table className="data-table clickable">
                  <thead>
                    <tr>
                      <th>Sale</th>
                      <th>Shop</th>
                      <th>Recorded by</th>
                      <th>Status</th>
                      <th className="num">Total</th>
                      <th className="num">Balance</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.recent_sales.map(sale => (
                      <tr key={sale.id} onClick={() => setDetailId(sale.id)}>
                        <td>
                          <strong>#{sale.sale_number}</strong>
                          <small>{formatDate(sale.business_date)}</small>
                        </td>
                        <td>{sale.shop_name}</td>
                        <td>{sale.salesperson_name}</td>
                        <td>
                          <StatusBadge status={sale.status} />
                        </td>
                        <td className="num">{formatMoney(sale.grand_total)}</td>
                        <td className="num">{formatMoney(sale.balance)}</td>
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
                title="No sales yet"
                description="Record the first sale and it will appear here."
                action={
                  <button type="button" className="button-primary button-small" onClick={() => setSaleOpen(true)}>
                    New sale
                  </button>
                }
              />
            )}
          </section>

          <p className="page-foot">
            {titleCase(app.mode === 'local' ? 'local demo' : 'supabase cloud')} ·{' '}
            {app.profile?.full_name} · Ethereal Co. Business Manager
          </p>
        </>
      )}

      <NewSaleModal
        open={saleOpen}
        onClose={() => setSaleOpen(false)}
        onCreated={result => setDetailId(result.sale_id)}
      />
      <PaymentModal
        open={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        onCreated={() => onNavigate('payments')}
      />
      <SaleDetailModal
        open={Boolean(detailId)}
        saleId={detailId}
        onClose={() => setDetailId('')}
      />
    </div>
  )
}
