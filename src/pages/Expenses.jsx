import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { fetchCompleteList } from '../lib/fetchCompleteList'
import { businessDate, downloadCsv, formatDate, formatMoney } from '../lib/format'
import Icon from '../components/Icon'
import {
  EmptyState,
  DataLoadFailure,
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

const CATEGORIES = [
  'Fuel',
  'Travel',
  'Packaging',
  'Salary',
  'Rent',
  'Utilities',
  'Maintenance',
  'Office',
  'Marketing',
  'Other'
]

function emptyForm() {
  return {
    expense_date: businessDate(),
    category: 'Fuel',
    description: '',
    amount: ''
  }
}

export default function Expenses() {
  const app = useApp()
  const [tab, setTab] = useState('all')
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [detailId, setDetailId] = useState('')
  const [decision, setDecision] = useState('approve')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState('')
  const [error, setError] = useState('')

  const state = useApiData(
    () => api.getExpenses({ from: from || null, to: to || null }),
    [app.version, from, to]
  )
  const expenses = state.data || []
  const detail = detailId ? expenses.find(expense => expense.id === detailId) : null
  const ownExpense = detail?.submitted_by === app.profile?.id

  const counts = useMemo(
    () => ({
      all: expenses.length,
      submitted: expenses.filter(expense => expense.status === 'submitted').length,
      approved: expenses.filter(expense => expense.status === 'approved').length,
      paid: expenses.filter(expense => expense.status === 'paid').length,
      rejected: expenses.filter(expense => expense.status === 'rejected').length
    }),
    [expenses]
  )

  const totals = useMemo(() => {
    const counted = expenses.filter(expense => ['approved', 'paid'].includes(expense.status))
    return counted.reduce((sum, expense) => sum + Number(expense.amount), 0)
  }, [expenses])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return expenses.filter(expense => {
      if (tab !== 'all' && expense.status !== tab) return false
      if (!needle) return true
      return [expense.category, expense.description, expense.submitted_by_name]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(needle))
    })
  }, [expenses, tab, query])

  function openAdd() {
    setForm(emptyForm())
    setError('')
    setAddOpen(true)
  }

  function openDetail(expense) {
    setDetailId(expense.id)
    setDecision('approve')
    setReason('')
    setActionError('')
  }

  async function submitExpense(event) {
    event.preventDefault()
    setError('')
    if (!form.category.trim()) {
      setError('Choose a category.')
      return
    }
    if (!form.description.trim()) {
      setError('Describe what the money was spent on.')
      return
    }
    if (!Number(form.amount) || Number(form.amount) <= 0) {
      setError('Enter an amount greater than zero.')
      return
    }
    setSaving(true)
    try {
      await api.submitExpense({
        expenseDate: form.expense_date,
        category: form.category,
        description: form.description.trim(),
        amount: Number(form.amount),
        clientReference:
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `expense-${Date.now()}`
      })
      app.notify('Expense submitted for approval.', 'success')
      app.refresh()
      setAddOpen(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function submitDecision() {
    setActionError('')
    if (decision === 'reject' && !reason.trim()) {
      setActionError('Add a reason for rejecting this expense.')
      return
    }
    setSaving(true)
    try {
      await api.reviewExpense({
        expenseId: detailId,
        decision,
        reason
      })
      app.notify(
        decision === 'approve' ? 'Expense approved.' : 'Expense rejected.',
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

  async function markPaid() {
    setActionError('')
    setSaving(true)
    try {
      await api.markExpensePaid(detailId)
      app.notify('Expense marked as paid.', 'success')
      app.refresh()
      state.reload({ quiet: true })
      setDetailId('')
    } catch (err) {
      setActionError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function exportExpenses() {
    downloadCsv(
      'ethereal-expenses.csv',
      filtered.map(expense => ({
        date: expense.expense_date,
        category: expense.category,
        description: expense.description,
        amount: expense.amount,
        status: expense.status,
        submitted_by: expense.submitted_by_name,
        reviewed_at: expense.reviewed_at || '',
        paid_at: expense.paid_at || ''
      }))
    )
  }

  if (state.error && !state.data) {
    return <DataLoadFailure title="Expenses" description="Expense records and totals could not be loaded." message={state.error} onRetry={state.reload} />
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Cash out"
        title="Expenses"
        description="Submit spend with a description, get it approved and mark it paid."
        actions={
          <>
            <button type="button" className="button-ghost" onClick={exportExpenses} disabled={!filtered.length}>
              <Icon name="download" size={16} /> Export
            </button>
            <button type="button" className="button-primary" onClick={openAdd}>
              <Icon name="plus" size={16} /> New expense
            </button>
          </>
        }
      />

      {app.isAdmin && counts.submitted > 0 && (
        <InlineNote tone="warning">
          <strong>{counts.submitted} expense{counts.submitted === 1 ? '' : 's'} waiting for review.</strong>{' '}
          You cannot approve an expense you submitted yourself.
        </InlineNote>
      )}

      <div className="stats-grid compact-grid">
        <StatCard
          label="Approved + paid"
          value={formatMoney(totals)}
          hint="In the current view"
          icon="expenses"
          tone="orange"
        />
        <StatCard
          label="Awaiting review"
          value={String(counts.submitted)}
          hint="Submitted claims"
          icon="clock"
          tone={counts.submitted ? 'orange' : 'green'}
        />
        <StatCard
          label="Paid"
          value={String(counts.paid)}
          hint="Reimbursed claims"
          icon="check"
          tone="green"
        />
      </div>

      <div className="toolbar wrap">
        <Tabs
          items={[
            { id: 'all', label: 'All', count: counts.all },
            { id: 'submitted', label: 'Submitted', count: counts.submitted },
            { id: 'approved', label: 'Approved', count: counts.approved },
            { id: 'paid', label: 'Paid', count: counts.paid },
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
            placeholder="Category, note or person…"
            label="Search expenses"
          />
        </div>
      </div>

      <ErrorNote message={state.error} onRetry={state.reload} />
      {state.loading && !expenses.length && <LoadingBlock label="Loading expenses…" />}

      <section className="card no-pad">
        {filtered.length ? (
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Description</th>
                  <th>Submitted by</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th>Paid</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map(expense => (
                  <tr key={expense.id} onClick={() => openDetail(expense)}>
                    <td>{formatDate(expense.expense_date)}</td>
                    <td>
                      <strong>{expense.category}</strong>
                    </td>
                    <td className="wrap-cell">{expense.description}</td>
                    <td>{expense.submitted_by_name}</td>
                    <td className="num">{formatMoney(expense.amount)}</td>
                    <td>
                      <StatusBadge status={expense.status} />
                    </td>
                    <td>{expense.paid_at ? formatDate(expense.paid_at) : '—'}</td>
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
            icon="expenses"
            title={query || from || to ? 'No expenses match' : 'No expenses yet'}
            description={
              query || from || to
                ? 'Try a wider date range or clear the search.'
                : 'Submit fuel, travel, packaging or other business spend.'
            }
            action={
              <button type="button" className="button-primary button-small" onClick={openAdd}>
                <Icon name="plus" size={15} /> New expense
              </button>
            }
          />
        )}
      </section>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="New expense"
        subtitle="Claims are reviewed before they count towards business expenses."
        footer={
          <>
            <button type="button" className="button-ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </button>
            <button type="submit" form="expense-form" className="button-primary" disabled={saving}>
              {saving ? 'Submitting…' : 'Submit expense'}
            </button>
          </>
        }
      >
        <form id="expense-form" className="form-stack" onSubmit={submitExpense}>
          <div className="two-col">
            <Field label="Date" htmlFor="expense-date">
              <input
                id="expense-date"
                type="date"
                value={form.expense_date}
                onChange={event => setForm({ ...form, expense_date: event.target.value })}
                required
              />
            </Field>
            <Field label="Amount" htmlFor="expense-amount">
              <input
                id="expense-amount"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={event => setForm({ ...form, amount: event.target.value })}
                placeholder="0.00"
                required
              />
            </Field>
          </div>
          <Field label="Category" htmlFor="expense-category">
            <select
              id="expense-category"
              value={form.category}
              onChange={event => setForm({ ...form, category: event.target.value })}
            >
              {CATEGORIES.map(category => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Description"
            htmlFor="expense-description"
            hint="What was bought, from where, and why it was needed."
          >
            <textarea
              id="expense-description"
              rows="3"
              value={form.description}
              onChange={event => setForm({ ...form, description: event.target.value })}
              placeholder="e.g. Diesel for delivery van, 32 litres"
              required
            />
          </Field>
          {error && (
            <div className="inline-note note-danger" role="alert">
              <Icon name="alert" size={17} />
              <div>{error}</div>
            </div>
          )}
        </form>
      </Modal>

      <Modal
        open={Boolean(detail)}
        onClose={() => setDetailId('')}
        size="md"
        title={detail ? detail.category : 'Expense'}
        subtitle={detail ? `${formatMoney(detail.amount)} · ${formatDate(detail.expense_date)}` : undefined}
        footer={
          <>
            <button type="button" className="button-ghost" onClick={() => setDetailId('')}>
              Close
            </button>
            {detail?.status === 'approved' && app.isAdmin && (
              <button type="button" className="button-primary" disabled={saving} onClick={markPaid}>
                {saving ? 'Saving…' : 'Mark as paid'}
              </button>
            )}
            {detail?.status === 'submitted' && app.isAdmin && !ownExpense && (
              <button
                type="button"
                className={decision === 'reject' ? 'button-danger' : 'button-primary'}
                disabled={saving}
                onClick={submitDecision}
              >
                {saving
                  ? 'Saving…'
                  : decision === 'reject'
                    ? 'Reject expense'
                    : 'Approve expense'}
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
                  Submitted by {detail.submitted_by_name} · {formatDate(detail.created_at)}
                </p>
              </div>
              <StatusBadge status={detail.status} />
            </div>

            <dl className="focus-list">
              <div>
                <dt>Description</dt>
                <dd>{detail.description}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>{formatMoney(detail.amount)}</dd>
              </div>
              <div>
                <dt>Reviewed</dt>
                <dd>{detail.reviewed_at ? formatDate(detail.reviewed_at) : 'Not yet'}</dd>
              </div>
              <div>
                <dt>Paid</dt>
                <dd>{detail.paid_at ? formatDate(detail.paid_at) : 'Not yet'}</dd>
              </div>
            </dl>

            {detail.status === 'rejected' && detail.review_reason && (
              <InlineNote tone="danger">Rejected: {detail.review_reason}</InlineNote>
            )}

            {detail.status === 'submitted' && app.isAdmin && ownExpense && (
              <InlineNote tone="warning">
                You submitted this claim, so another owner or admin must review it.
              </InlineNote>
            )}

            {detail.status === 'submitted' && app.isAdmin && !ownExpense && (
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
                  <Field label="Rejection reason" htmlFor="expense-reject">
                    <textarea
                      id="expense-reject"
                      rows="2"
                      value={reason}
                      onChange={event => setReason(event.target.value)}
                      placeholder="e.g. Receipt missing"
                    />
                  </Field>
                )}
                {decision === 'approve' && (
                  <InlineNote tone="info">
                    Approved expenses count towards reports immediately. Mark them paid when the
                    money leaves the business.
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
                Waiting for an owner or admin to review this claim.
              </InlineNote>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
