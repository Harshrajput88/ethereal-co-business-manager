import { useMemo, useState } from 'react'
import { usePagedItems } from '../hooks/usePagedItems'
import TablePagination from '../components/TablePagination'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { formatDate, formatDateTime, formatMoney, titleCase } from '../lib/format'
import Icon from '../components/Icon'
import PaymentModal from '../components/PaymentModal'
import {
  EmptyState,
  DataLoadFailure,
  ErrorNote,
  Field,
  InlineNote,
  LoadingBlock,
  Metric,
  Modal,
  PageHeader,
  SearchField,
  StatCard,
  StatusBadge,
  Tabs
} from '../components/ui'

function Receipt({ payment }) {
  return (
    <article className="receipt-sheet print-area">
      <header>
        <div>
          <p className="invoice-kicker">Payment receipt</p>
          <h2>Ethereal Co.</h2>
          <span>Business Manager</span>
        </div>
        <strong>{payment.receipt_number}</strong>
      </header>
      <dl className="receipt-grid">
        <div>
          <dt>Shop</dt>
          <dd>{payment.shop_name}</dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd>{formatDateTime(payment.received_at)}</dd>
        </div>
        <div>
          <dt>Method</dt>
          <dd>{titleCase(payment.method)}</dd>
        </div>
        <div>
          <dt>Recorded by</dt>
          <dd>{payment.recorded_by_name}</dd>
        </div>
        <div>
          <dt>Reference</dt>
          <dd>{payment.external_reference || '—'}</dd>
        </div>
        <div>
          <dt>Verified</dt>
          <dd>{formatDateTime(payment.verified_at)}</dd>
        </div>
      </dl>
      <div className="receipt-amount">
        <span>Amount received</span>
        <strong>{formatMoney(payment.amount)}</strong>
      </div>
      {payment.allocations.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Applied to sale</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {payment.allocations.map(row => (
              <tr key={row.sale_id}>
                <td>Sale #{row.sale_number}</td>
                <td className="num">{formatMoney(row.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="receipt-foot">Thank you. This receipt is generated after owner verification.</p>
    </article>
  )
}

export default function Payments() {
  const app = useApp()
  const [tab, setTab] = useState('all')
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [recordOpen, setRecordOpen] = useState(false)
  const [detailId, setDetailId] = useState('')
  const [decision, setDecision] = useState('approve')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState('')
  const [receiptOpen, setReceiptOpen] = useState(false)

  const state = useApiData(
    () => api.getPayments({ from: from || null, to: to || null }),
    [app.version, from, to]
  )
  const payments = state.data || []
  const detail = detailId ? payments.find(payment => payment.id === detailId) : null

  const counts = useMemo(
    () => ({
      all: payments.length,
      submitted: payments.filter(payment => payment.status === 'submitted').length,
      verified: payments.filter(payment => payment.status === 'verified').length,
      rejected: payments.filter(payment => payment.status === 'rejected').length
    }),
    [payments]
  )

  const totals = useMemo(() => {
    const verified = payments.filter(payment => payment.status === 'verified')
    const submitted = payments.filter(payment => payment.status === 'submitted')
    return {
      verified: verified.reduce((sum, payment) => sum + Number(payment.amount), 0),
      pending: submitted.reduce((sum, payment) => sum + Number(payment.amount), 0)
    }
  }, [payments])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return payments.filter(payment => {
      if (tab !== 'all' && payment.status !== tab) return false
      if (!needle) return true
      return [
        payment.shop_name,
        payment.receipt_number,
        payment.recorded_by_name,
        payment.external_reference,
        payment.method
      ]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(needle))
    })
  }, [payments, tab, query])

  const { page, pageCount, visibleItems: visibleRows, setPage } = usePagedItems(filtered, 25)

  function openDetail(payment) {
    setDetailId(payment.id)
    setDecision('approve')
    setReason('')
    setActionError('')
  }

  async function verify(action) {
    setActionError('')
    if (action === 'reject' && !reason.trim()) {
      setActionError('Add a reason for rejecting this payment.')
      return
    }
    setSaving(true)
    try {
      const result = await api.verifyPayment({
        paymentId: detailId,
        decision: action,
        reason
      })
      app.notify(
        action === 'approve'
          ? `Payment verified${result.receipt_number ? ` · receipt ${result.receipt_number}` : ''}.`
          : 'Payment rejected.',
        action === 'approve' ? 'success' : 'warning'
      )
      app.refresh()
      setDecision('approve')
      setReason('')
      state.reload({ quiet: true })
    } catch (err) {
      setActionError(action === 'approve'
        ? `Payment was not verified and remains submitted with its original allocation. Do not retry verification unchanged. Reject this submission with a clear reason, then record the payment again using the current outstanding invoices. Server details: ${err.message}`
        : err.message)
    } finally {
      setSaving(false)
    }
  }

  const afterAction = () => {
    setDetailId('')
    setDecision('approve')
    setReason('')
    setActionError('')
  }

  if (state.error && !state.data) {
    return <DataLoadFailure title="Payments" description="Payment records and balances could not be loaded." message={state.error} onRetry={state.reload} />
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Collections"
        title="Payments"
        description="Record money received and verify it before it reduces an invoice balance."
        actions={
          <button type="button" className="button-primary" onClick={() => setRecordOpen(true)}>
            <Icon name="plus" size={16} /> Record payment
          </button>
        }
      />

      {app.isAdmin && counts.submitted > 0 && (
        <InlineNote tone="warning">
          <strong>{counts.submitted} payment{counts.submitted === 1 ? '' : 's'} waiting for verification.</strong>{' '}
          Verify only after the cash, UPI or bank credit is confirmed.
        </InlineNote>
      )}

      <div className="stats-grid compact-grid">
        <StatCard
          label="Verified collections"
          value={formatMoney(totals.verified)}
          hint={`${counts.verified} payment${counts.verified === 1 ? '' : 's'}`}
          icon="check"
          tone="green"
        />
        <StatCard
          label="Awaiting verification"
          value={formatMoney(totals.pending)}
          hint={`${counts.submitted} submitted`}
          icon="clock"
          tone="orange"
        />
        <StatCard
          label="Rejected"
          value={String(counts.rejected)}
          hint="Needs to be recorded again"
          icon="alert"
          tone={counts.rejected ? 'danger' : 'muted'}
        />
      </div>

      <div className="toolbar wrap">
        <Tabs
          items={[
            { id: 'all', label: 'All', count: counts.all },
            { id: 'submitted', label: 'Submitted', count: counts.submitted },
            { id: 'verified', label: 'Verified', count: counts.verified },
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
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Shop, receipt or reference…"
            label="Search payments"
          />
        </div>
      </div>

      <ErrorNote message={state.error} onRetry={state.reload} />
      {state.loading && !payments.length && <LoadingBlock label="Loading payments…" />}

      <section className="card no-pad">
        {filtered.length ? (
          <>
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Shop</th>
                  <th>Recorded by</th>
                  <th>Method</th>
                  <th className="num">Amount</th>
                  <th>Applied to</th>
                  <th>Status</th>
                  <th>Receipt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(payment => (
                  <tr key={payment.id} onClick={() => openDetail(payment)}>
                    <td>
                      <strong>{formatDate(payment.received_at)}</strong>
                      <small>{titleCase(payment.method)}</small>
                    </td>
                    <td>{payment.shop_name}</td>
                    <td>{payment.recorded_by_name}</td>
                    <td>{titleCase(payment.method)}</td>
                    <td className="num">{formatMoney(payment.amount)}</td>
                    <td>
                      {payment.allocations.length
                        ? `${payment.allocations.length} sale${payment.allocations.length === 1 ? '' : 's'}`
                        : 'Unapplied'}
                    </td>
                    <td>
                      <StatusBadge status={payment.status} />
                    </td>
                    <td>
                      {payment.receipt_number ? (
                        <span className="invoice-chip">
                          <Icon name="check" size={13} />
                          {payment.receipt_number.replace('ETC-RCPT-', '')}
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
          <TablePagination page={page} pageCount={pageCount} total={filtered.length} pageSize={25} onPageChange={setPage} />
          </>
        ) : (
          <EmptyState
            icon="payments"
            title={query || from || to ? 'No payments match' : 'No payments recorded'}
            description={
              query || from || to
                ? 'Try a different date range or clear the search.'
                : 'Record cash, UPI or bank transfers as they arrive.'
            }
            action={
              <button type="button" className="button-primary button-small" onClick={() => setRecordOpen(true)}>
                <Icon name="plus" size={15} /> Record payment
              </button>
            }
          />
        )}
      </section>

      <PaymentModal
        open={recordOpen}
        onClose={() => setRecordOpen(false)}
        onCreated={() => setTab('submitted')}
      />

      <Modal
        open={Boolean(detail)}
        onClose={afterAction}
        size="md"
        title={detail ? `Payment · ${detail.shop_name}` : 'Payment'}
        subtitle={detail ? `${formatMoney(detail.amount)} received ${formatDate(detail.received_at)}` : undefined}
        footer={
          <>
            <button type="button" className="button-ghost" onClick={afterAction}>
              Close
            </button>
            {detail?.status === 'verified' && detail.receipt_number && (
              <button type="button" className="button-secondary" onClick={() => setReceiptOpen(true)}>
                <Icon name="invoices" size={16} /> Receipt
              </button>
            )}
          </>
        }
      >
        {detail && (
          <div className="stack-lg">
            <div className="detail-topline">
              <div>
                <StatusBadge status={detail.status} />
                <p className="muted-copy">
                  Recorded by {detail.recorded_by_name} · {formatDateTime(detail.received_at)}
                </p>
              </div>
              <strong className="large-amount">{formatMoney(detail.amount)}</strong>
            </div>

            <div className="metric-row">
              <Metric label="Method" value={titleCase(detail.method)} />
              <Metric label="Reference" value={detail.external_reference || '—'} />
              <Metric
                label="Receipt"
                value={detail.receipt_number || 'Pending verification'}
              />
              <Metric
                label="Verified"
                value={detail.verified_at ? formatDate(detail.verified_at) : '—'}
              />
            </div>

            <section>
              <h3 className="subhead">Applied to</h3>
              {detail.allocations.length ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Sale</th>
                        <th className="num">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.allocations.map(row => (
                        <tr key={row.sale_id}>
                          <td>Sale #{row.sale_number}</td>
                          <td className="num">{formatMoney(row.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted-copy">
                  No invoice allocation yet. Verification automatically applies this payment to the
                  oldest open invoices for the shop.
                </p>
              )}
              {detail.amount >
                detail.allocations.reduce((sum, row) => sum + Number(row.amount), 0) && (
                <p className="muted-copy">
                  Unapplied:{' '}
                  {formatMoney(
                    detail.amount -
                      detail.allocations.reduce((sum, row) => sum + Number(row.amount), 0)
                  )}
                </p>
              )}
            </section>

            {detail.status === 'rejected' && detail.rejection_reason && (
              <InlineNote tone="danger">
                Rejected: {detail.rejection_reason}
              </InlineNote>
            )}

            {detail.status === 'submitted' && app.isAdmin && (
              <section className="decision-panel">
                <h3 className="subhead">Verify or reject</h3>
                <p className="muted-copy">
                  Approving creates the receipt and applies any unallocated amount to the oldest open
                  invoices. Rejecting leaves balances untouched.
                </p>
                <div className="segmented">
                  <button
                    type="button"
                    className={decision === 'approve' ? 'active' : ''}
                    onClick={() => setDecision('approve')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={decision === 'reject' ? 'active' : ''}
                    onClick={() => setDecision('reject')}
                  >
                    Reject
                  </button>
                </div>
                {decision === 'reject' && (
                  <Field label="Rejection reason" htmlFor="payment-reject">
                    <textarea
                      id="payment-reject"
                      rows="2"
                      value={reason}
                      onChange={event => setReason(event.target.value)}
                      placeholder="e.g. Cash count did not match"
                    />
                  </Field>
                )}
                <ErrorNote message={actionError} />
                <div className="button-row">
                  <button
                    type="button"
                    className={decision === 'reject' ? 'button-danger' : 'button-primary'}
                    disabled={saving}
                    onClick={() => verify(decision)}
                  >
                    {saving
                      ? 'Saving…'
                      : decision === 'reject'
                        ? 'Confirm rejection'
                        : 'Verify payment'}
                  </button>
                </div>
              </section>
            )}

            {detail.status === 'submitted' && !app.isAdmin && (
              <InlineNote tone="warning">
                This payment is waiting for an owner or admin to verify it. Balances update after
                verification.
              </InlineNote>
            )}

          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(receiptOpen && detail?.receipt_number)}
        onClose={() => setReceiptOpen(false)}
        size="md"
        title="Payment receipt"
        footer={
          <>
            <button type="button" className="button-ghost" onClick={() => setReceiptOpen(false)}>
              Close
            </button>
            <button type="button" className="button-primary" onClick={() => window.print()}>
              <Icon name="print" size={16} /> Print receipt
            </button>
          </>
        }
      >
        {detail && detail.receipt_number && <Receipt payment={detail} />}
      </Modal>
    </div>
  )
}
