import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { fetchCompleteList } from '../lib/fetchCompleteList'
import { formatDate, formatDateTime, formatMoney, formatNumber, titleCase } from '../lib/format'
import Icon from '../components/Icon'
import ReturnModal from '../components/ReturnModal'
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
  SearchField,
  StatCard,
  StatusBadge,
  Tabs
} from '../components/ui'

export default function Returns() {
  const app = useApp()
  const [tab, setTab] = useState(app.isAdmin ? 'submitted' : 'all')
  const [query, setQuery] = useState('')
  const [requestOpen, setRequestOpen] = useState(false)
  const [detailId, setDetailId] = useState('')
  const [decision, setDecision] = useState('approve')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState('')

  const state = useApiData(() => api.getReturns(), [app.version])
  const returns = state.data || []
  const detail = detailId ? returns.find(request => request.id === detailId) : null

  const counts = useMemo(
    () => ({
      all: returns.length,
      submitted: returns.filter(request => request.status === 'submitted').length,
      approved: returns.filter(request => request.status === 'approved').length,
      rejected: returns.filter(request => request.status === 'rejected').length
    }),
    [returns]
  )

  const totals = useMemo(() => {
    const approved = returns.filter(request => request.status === 'approved')
    return approved.reduce((sum, request) => {
      return (
        sum +
        request.lines.reduce(
          (lineSum, line) =>
            lineSum + Number(line.approved_cartons || 0) * Number(line.unit_price || 0),
          0
        )
      )
    }, 0)
  }, [returns])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return returns.filter(request => {
      if (tab !== 'all' && request.status !== tab) return false
      if (!needle) return true
      return [request.shop_name, request.sale_number, request.submitted_by_name, request.reason]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(needle))
    })
  }, [returns, tab, query])

  function openDetail(request) {
    setDetailId(request.id)
    setDecision('approve')
    setReason('')
    setActionError('')
  }

  async function submitDecision() {
    setActionError('')
    if (decision === 'reject' && !reason.trim()) {
      setActionError('Add a reason for rejecting this return.')
      return
    }
    setSaving(true)
    try {
      await api.reviewReturn({
        returnId: detailId,
        decision,
        reason
      })
      app.notify(
        decision === 'approve'
          ? 'Return approved. Stock and sale credit updated.'
          : 'Return rejected.',
        decision === 'approve' ? 'success' : 'warning'
      )
      app.refresh()
      state.reload({ quiet: true })
      setDecision('approve')
      setReason('')
      setDetailId('')
    } catch (err) {
      setActionError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (state.error && !state.data) {
    return <DataLoadFailure title="Returns" description="Return requests and adjustments could not be loaded." message={state.error} onRetry={state.reload} />
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Stock coming back"
        title="Returns"
        description="Review returned cartons before they re-enter stock or reduce a sale balance."
        actions={
          <button type="button" className="button-primary" onClick={() => setRequestOpen(true)}>
            <Icon name="plus" size={16} /> Request return
          </button>
        }
      />

      {app.isAdmin && counts.submitted > 0 && (
        <InlineNote tone="warning">
          <strong>{counts.submitted} return{counts.submitted === 1 ? '' : 's'} waiting for review.</strong>{' '}
          Approving adds reusable cartons to saleable stock, damaged cartons to the damaged bucket, and
          credits the original sale.
        </InlineNote>
      )}

      <div className="stats-grid compact-grid">
        <StatCard
          label="Awaiting review"
          value={formatNumber(counts.submitted)}
          hint="Submitted requests"
          icon="clock"
          tone={counts.submitted ? 'orange' : 'green'}
        />
        <StatCard
          label="Approved returns"
          value={formatNumber(counts.approved)}
          hint={`${formatMoney(totals)} credited`}
          icon="returns"
          tone="green"
        />
        <StatCard
          label="Rejected"
          value={formatNumber(counts.rejected)}
          hint="Stock unchanged"
          icon="alert"
          tone={counts.rejected ? 'danger' : 'muted'}
        />
      </div>

      <div className="toolbar wrap">
        <Tabs
          items={[
            { id: 'all', label: 'All', count: counts.all },
            { id: 'submitted', label: 'Submitted', count: counts.submitted },
            { id: 'approved', label: 'Approved', count: counts.approved },
            { id: 'rejected', label: 'Rejected', count: counts.rejected }
          ]}
          value={tab}
          onChange={setTab}
        />
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Shop, sale number or reason…"
          label="Search returns"
        />
      </div>

      <ErrorNote message={state.error} onRetry={state.reload} />
      {state.loading && !returns.length && <LoadingBlock label="Loading returns…" />}

      <section className="card no-pad">
        {filtered.length ? (
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr>
                  <th>Submitted</th>
                  <th>Sale</th>
                  <th>Shop</th>
                  <th>By</th>
                  <th>Products</th>
                  <th className="num">Cartons</th>
                  <th className="num">Credit</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map(request => {
                  const cartons = request.lines.reduce(
                    (sum, line) => sum + Number(line.approved_cartons || line.cartons || 0),
                    0
                  )
                  const credit = request.lines.reduce(
                    (sum, line) =>
                      sum +
                      Number(line.approved_cartons || 0) * Number(line.unit_price || 0),
                    0
                  )
                  return (
                    <tr key={request.id} onClick={() => openDetail(request)}>
                      <td>
                        <strong>{formatDate(request.submitted_at)}</strong>
                        <small>{formatDateTime(request.submitted_at).split(', ')[1] || ''}</small>
                      </td>
                      <td>#{request.sale_number}</td>
                      <td>{request.shop_name}</td>
                      <td>{request.submitted_by_name}</td>
                      <td>
                        {request.lines.map(line => line.product_name).filter(Boolean).join(', ') ||
                          '—'}
                      </td>
                      <td className="num">{formatNumber(cartons)}</td>
                      <td className="num">{credit ? formatMoney(credit) : '—'}</td>
                      <td>
                        <StatusBadge status={request.status} />
                      </td>
                      <td className="row-arrow">
                        <Icon name="arrow" size={15} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon="returns"
            title={query ? 'No returns match' : 'No return requests'}
            description={
              query
                ? 'Try another search.'
                : 'Request a return against a confirmed sale when stock comes back.'
            }
            action={
              <button type="button" className="button-primary button-small" onClick={() => setRequestOpen(true)}>
                <Icon name="plus" size={15} /> Request return
              </button>
            }
          />
        )}
      </section>

      <ReturnModal
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        onSubmitted={() => setTab('submitted')}
      />

      <Modal
        open={Boolean(detail)}
        onClose={() => setDetailId('')}
        size="md"
        title={detail ? `Return · Sale #${detail.sale_number}` : 'Return request'}
        subtitle={detail ? `${detail.shop_name} · ${formatDate(detail.submitted_at)}` : undefined}
        footer={
          <>
            <button type="button" className="button-ghost" onClick={() => setDetailId('')}>
              Close
            </button>
            {detail?.status === 'submitted' && app.isAdmin && (
              <button
                type="button"
                className={decision === 'reject' ? 'button-danger' : 'button-primary'}
                disabled={saving}
                onClick={submitDecision}
              >
                {saving
                  ? 'Saving…'
                  : decision === 'reject'
                    ? 'Reject return'
                    : 'Approve return'}
              </button>
            )}
          </>
        }
      >
        {detail && (
          <div className="stack-lg">
            <div className="detail-topline">
              <div>
                <p className="muted-copy">
                  Submitted by {detail.submitted_by_name} on {formatDateTime(detail.submitted_at)}
                </p>
              </div>
              <StatusBadge status={detail.status} />
            </div>

            <InlineNote tone="info">
              <strong>Reason:</strong> {detail.reason}
            </InlineNote>

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Requested</th>
                    <th>Approved</th>
                    <th>Condition</th>
                    <th className="num">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((line, index) => (
                    <tr key={`${line.product_name}-${index}`}>
                      <td>{line.product_name}</td>
                      <td>{formatNumber(line.cartons)} cartons</td>
                      <td>
                        {detail.status === 'approved'
                          ? `${formatNumber(line.approved_cartons)} cartons`
                          : '—'}
                      </td>
                      <td>
                        <Badge tone={line.condition === 'damaged' ? 'danger' : 'success'}>
                          {titleCase(line.condition)}
                        </Badge>
                      </td>
                      <td className="num">
                        {formatMoney(
                          Number(line.approved_cartons || 0) * Number(line.unit_price || 0)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {detail.status === 'rejected' && detail.review_reason && (
              <InlineNote tone="danger">Rejected: {detail.review_reason}</InlineNote>
            )}

            {detail.status === 'approved' && (
              <InlineNote tone="success">
                Approved on {formatDate(detail.reviewed_at)}. Reusable cartons moved to saleable
                stock, damaged cartons moved to the damaged bucket, and the sale was credited.
              </InlineNote>
            )}

            {detail.status === 'submitted' && app.isAdmin && (
              <section className="decision-panel">
                <h3 className="subhead">Review</h3>
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
                  <Field label="Rejection reason" htmlFor="return-reject">
                    <textarea
                      id="return-reject"
                      rows="2"
                      value={reason}
                      onChange={event => setReason(event.target.value)}
                      placeholder="e.g. Cartons were not from this sale"
                    />
                  </Field>
                )}
                {decision === 'approve' && (
                  <InlineNote tone="warning">
                    Approving changes stock and reduces the sale balance immediately. This cannot be
                    undone from the app.
                  </InlineNote>
                )}
                {actionError && (
                  <div className="inline-note note-danger" role="alert">
                    <Icon name="alert" size={17} />
                    <div>{actionError}</div>
                  </div>
                )}
              </section>
            )}

            {detail.status === 'submitted' && !app.isAdmin && (
              <InlineNote tone="warning">
                Waiting for an owner or admin. Your stock stays unchanged until approval.
              </InlineNote>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
