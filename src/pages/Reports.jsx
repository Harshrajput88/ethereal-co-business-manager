import { useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import {
  addDays,
  downloadCsv,
  formatDate,
  formatMoney,
  formatNumber,
  monthStart,
  titleCase,
  today
} from '../lib/format'
import Icon from '../components/Icon'
import {
  EmptyState,
  DataLoadFailure,
  ErrorNote,
  LoadingBlock,
  PageHeader,
  SectionTitle,
  StatCard
} from '../components/ui'

function yearStart() {
  return `${today().slice(0, 4)}-01-01`
}

export default function Reports() {
  const app = useApp()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [preset, setPreset] = useState('month')

  const state = useApiData(
    async () => {
      const [report, settings] = await Promise.all([
        api.getFinancialReport({ from, to }),
        api.getBusinessSettings()
      ])
      return { report, settings }
    },
    [app.version, from, to]
  )

  const data = state.data
  const report = data?.report || null

  function applyPreset(id) {
    setPreset(id)
    const current = today()
    if (id === 'month') {
      setFrom(monthStart())
      setTo(current)
    } else if (id === '30') {
      setFrom(addDays(current, -29))
      setTo(current)
    } else if (id === 'year') {
      setFrom(yearStart())
      setTo(current)
    }
  }

  function exportSummary() {
    if (!report) return
    downloadCsv('ethereal-report-summary.csv', [
      { metric: 'Revenue (confirmed)', value: report.revenue },
      { metric: 'Returns', value: report.returns },
      { metric: 'Net revenue', value: report.netRevenue },
      { metric: 'Verified collections', value: report.collections },
      { metric: 'Outstanding', value: report.outstanding },
      { metric: 'Approved / paid expenses', value: report.expenses },
      { metric: 'Net after expenses', value: report.net },
      { metric: 'Confirmed transactions', value: report.transactions },
      { metric: 'From', value: from },
      { metric: 'To', value: to }
    ])
  }

  function exportShops() {
    if (!report) return
    downloadCsv('ethereal-shop-performance.csv', report.byShop)
  }

  const maxDaily = report
    ? Math.max(1, ...report.daily.map(day => Math.max(day.revenue, day.collections)))
    : 1
  const daily = report?.daily.slice(-30) || []

  if (state.error && !state.data) {
    return <DataLoadFailure title="Reports" description="The report could not be built from database data." message={state.error} onRetry={state.reload} />
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Numbers"
        title="Reports"
        description="Sales, collections, returns and expenses for the selected period."
        actions={
          <>
            <button type="button" className="button-ghost" onClick={exportSummary} disabled={!report}>
              <Icon name="download" size={16} /> Summary CSV
            </button>
            <button type="button" className="button-secondary" onClick={() => window.print()} disabled={!report}>
              <Icon name="print" size={16} /> Print
            </button>
          </>
        }
      />

      <div className="toolbar wrap">
        <div className="segmented">
          <button type="button" className={preset === 'month' ? 'active' : ''} onClick={() => applyPreset('month')}>
            This month
          </button>
          <button type="button" className={preset === '30' ? 'active' : ''} onClick={() => applyPreset('30')}>
            Last 30 days
          </button>
          <button type="button" className={preset === 'year' ? 'active' : ''} onClick={() => applyPreset('year')}>
            This year
          </button>
        </div>
        <div className="toolbar-right">
          <label className="date-field">
            <span>From</span>
            <input
              type="date"
              value={from}
              onChange={event => {
                setFrom(event.target.value)
                setPreset('custom')
              }}
            />
          </label>
          <label className="date-field">
            <span>To</span>
            <input
              type="date"
              value={to}
              onChange={event => {
                setTo(event.target.value)
                setPreset('custom')
              }}
            />
          </label>
        </div>
      </div>

      <ErrorNote message={state.error} onRetry={state.reload} />
      {state.loading && !report && <LoadingBlock label="Building report…" />}

      {report && (
        <div className="print-area report-print">
          <header className="report-print-head">
            <div>
              <p className="invoice-kicker">Business report</p>
              <h2>{data.settings?.business_name || 'Ethereal Co.'}</h2>
              <p>
                {formatDate(from)} – {formatDate(to)}
              </p>
            </div>
            <div>
              <span>{app.profile?.full_name}</span>
              <span>Prepared {formatDate(today())}</span>
            </div>
          </header>

          <div className="stats-grid compact-grid">
            <StatCard
              label="Net revenue"
              value={formatMoney(report.netRevenue)}
              hint={`${formatMoney(report.returns)} returns deducted`}
              icon="reports"
              tone="green"
            />
            <StatCard
              label="Verified collections"
              value={formatMoney(report.collections)}
              hint="Cash, UPI and bank"
              icon="payments"
              tone="blue"
            />
            <StatCard
              label="Outstanding"
              value={formatMoney(report.outstanding)}
              hint="Still owed by shops"
              icon="clock"
              tone="orange"
            />
            <StatCard
              label="Net after expenses"
              value={formatMoney(report.net)}
              hint={`${formatMoney(report.expenses)} expenses`}
              icon="expenses"
              tone={report.net < 0 ? 'danger' : 'violet'}
            />
          </div>

          <div className="overview-grid">
            <section className="card">
              <SectionTitle
                title="Daily sales and collections"
                description="Confirmed sales against verified payments."
              />
              {daily.length ? (
                <div className="bar-chart">
                  {daily.map(day => (
                    <div className="bar-day" key={day.date}>
                      <div className="bar-pair">
                        <span
                          className="bar bar-sales"
                          style={{ height: `${Math.max(2, (day.revenue / maxDaily) * 100)}%` }}
                          title={`Sales ${formatMoney(day.revenue)}`}
                        />
                        <span
                          className="bar bar-collections"
                          style={{ height: `${Math.max(2, (day.collections / maxDaily) * 100)}%` }}
                          title={`Collected ${formatMoney(day.collections)}`}
                        />
                      </div>
                      <span className="bar-label">{day.date.slice(8)}</span>
                      <span className="bar-month">{day.date.slice(5, 7)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState icon="reports" title="No activity in this period" />
              )}
              <div className="chart-legend">
                <span>
                  <i className="legend-sales" /> Sales
                </span>
                <span>
                  <i className="legend-collections" /> Collections
                </span>
              </div>
            </section>

            <section className="card">
              <SectionTitle
                title="Payment methods"
                description="Verified collections only."
              />
              {report.methods.length ? (
                <ul className="breakdown-list">
                  {report.methods.map(row => (
                    <li key={row.method}>
                      <span>{titleCase(row.method)}</span>
                      <div>
                        <strong>{formatMoney(row.amount)}</strong>
                        <small>
                          {report.collections > 0
                            ? Math.round((row.amount / report.collections) * 100)
                            : 0}
                          %
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted-copy">No verified payments in this period.</p>
              )}
              <SectionTitle title="Expense categories" description="Approved and paid claims." />
              {report.categories.length ? (
                <ul className="breakdown-list">
                  {report.categories.map(row => (
                    <li key={row.category}>
                      <span>{row.category}</span>
                      <div>
                        <strong>{formatMoney(row.amount)}</strong>
                        <small>
                          {report.expenses > 0
                            ? Math.round((row.amount / report.expenses) * 100)
                            : 0}
                          %
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted-copy">No counted expenses in this period.</p>
              )}
            </section>
          </div>

          <section className="card no-pad">
            <div className="card-head">
              <div>
                <h2>Shop performance</h2>
                <p>Confirmed revenue, returns and collections by outlet.</p>
              </div>
              <button type="button" className="button-ghost button-small" onClick={exportShops}>
                <Icon name="download" size={15} /> Export
              </button>
            </div>
            {report.byShop.length ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Shop</th>
                      <th className="num">Sales</th>
                      <th className="num">Returns</th>
                      <th className="num">Collections</th>
                      <th className="num">Outstanding</th>
                      <th className="num">Transactions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byShop.map(row => (
                      <tr key={row.name}>
                        <td>
                          <strong>{row.name}</strong>
                        </td>
                        <td className="num">{formatMoney(row.revenue)}</td>
                        <td className="num">{formatMoney(row.returns)}</td>
                        <td className="num">{formatMoney(row.collections)}</td>
                        <td className="num">{formatMoney(row.outstanding)}</td>
                        <td className="num">{formatNumber(row.transactions)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon="shop" title="No shop activity" />
            )}
          </section>

          <div className="overview-grid">
            <section className="card no-pad">
              <div className="card-head">
                <div>
                  <h2>Salespeople</h2>
                  <p>Confirmed sales attributed to each person.</p>
                </div>
              </div>
              {report.bySalesperson.length ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th className="num">Sales</th>
                        <th className="num">Transactions</th>
                        <th className="num">Outstanding</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.bySalesperson.map(row => (
                        <tr key={row.name}>
                          <td>{row.name}</td>
                          <td className="num">{formatMoney(row.revenue)}</td>
                          <td className="num">{formatNumber(row.transactions)}</td>
                          <td className="num">{formatMoney(row.outstanding)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState icon="team" title="No sales attributable" />
              )}
            </section>

            <section className="card no-pad">
              <div className="card-head">
                <div>
                  <h2>Product sales</h2>
                  <p>Cartons sold and revenue by SKU.</p>
                </div>
              </div>
              {report.products.length ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>SKU</th>
                        <th className="num">Cartons</th>
                        <th className="num">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.products.map(row => (
                        <tr key={`${row.product_name}-${row.sku}`}>
                          <td>
                            <strong>{row.product_name}</strong>
                            <small>{row.bottles_per_carton} bottles / carton</small>
                          </td>
                          <td>{row.sku}</td>
                          <td className="num">{formatNumber(row.cartons)}</td>
                          <td className="num">{formatMoney(row.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState icon="inventory" title="No products sold" />
              )}
            </section>
          </div>

          <p className="report-foot">
            {formatNumber(report.transactions)} confirmed transaction
            {report.transactions === 1 ? '' : 's'} · {report.transactions} sale records · Generated by
            Ethereal Co. Business Manager
          </p>
        </div>
      )}
    </div>
  )
}
