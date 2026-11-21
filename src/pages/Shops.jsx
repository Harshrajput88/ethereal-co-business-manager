import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { usePagedItems } from '../hooks/usePagedItems'
import TablePagination from '../components/TablePagination'
import { formatDate, formatMoney, titleCase } from '../lib/format'
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
  SearchField,
  StatusBadge,
  Tabs
} from '../components/ui'

const blankShop = {
  name: '',
  phone: '',
  email: '',
  address_line1: '',
  address_line2: '',
  locality: '',
  city: '',
  state: '',
  postal_code: '',
  notes: ''
}

export default function Shops() {
  const app = useApp()
  const [tab, setTab] = useState(app.isAdmin ? 'pending' : 'all')
  const [query, setQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState(blankShop)
  const [reviewShop, setReviewShop] = useState(null)
  const [decision, setDecision] = useState('approved')
  const [primaryId, setPrimaryId] = useState('')
  const [additionalIds, setAdditionalIds] = useState([])
  const [reason, setReason] = useState('')
  const [assignShop, setAssignShop] = useState(null)
  const [visitShop, setVisitShop] = useState(null)
  const [visitNote, setVisitNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const state = useApiData(
    async () => {
      const shops = await api.getShops()
      let team = []
      if (app.isAdmin) {
        team = await api.getTeam()
      }
      return { shops, team }
    },
    [app.version]
  )

  const shops = state.data?.shops || []
  const team = state.data?.team || []
  const approvedPeople = team.filter(person => person.status === 'approved')

  const counts = useMemo(
    () => ({
      all: shops.length,
      pending: shops.filter(shop => shop.status === 'pending').length,
      approved: shops.filter(shop => shop.status === 'approved').length,
      rejected: shops.filter(shop => shop.status === 'rejected').length
    }),
    [shops]
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return shops.filter(shop => {
      const matchesTab = tab === 'all' || shop.status === tab
      if (!matchesTab) return false
      if (!needle) return true
      return [shop.name, shop.city, shop.locality, shop.phone, shop.email]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(needle))
    })
  }, [shops, tab, query])

  const pagination = usePagedItems(filtered, 24)

  useEffect(() => {
    if (!reviewShop && !assignShop) return
    const target = reviewShop || assignShop
    const currentPrimary = target.salespeople?.find(person => person.is_primary)
    setPrimaryId(currentPrimary?.id || '')
    setAdditionalIds(
      (target.salespeople || []).filter(person => !person.is_primary).map(person => person.id)
    )
    setDecision('approved')
    setReason('')
    setError('')
  }, [reviewShop, assignShop])

  function openAdd() {
    setForm(blankShop)
    setError('')
    setAddOpen(true)
  }

  function closeAdd() {
    setAddOpen(false)
    setError('')
  }

  async function submitShop(event) {
    event.preventDefault()
    setError('')
    if (!form.name.trim()) {
      setError('Enter the shop name.')
      return
    }
    setSaving(true)
    try {
      await api.submitShop(form)
      app.notify('Shop submitted. It needs approval before sales can be recorded.', 'success')
      app.refresh()
      closeAdd()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function submitReview(event) {
    event.preventDefault()
    setError('')
    if (decision === 'approved' && !primaryId) {
      setError('Choose the primary salesperson for this shop.')
      return
    }
    if (decision === 'rejected' && !reason.trim()) {
      setError('Add a rejection reason for the salesperson.')
      return
    }
    setSaving(true)
    try {
      await api.reviewShop({
        shopId: reviewShop.id,
        decision,
        reason,
        primaryId: decision === 'approved' ? primaryId : null,
        additionalIds: decision === 'approved' ? additionalIds : []
      })
      app.notify(
        decision === 'approved' ? 'Shop approved and assigned.' : 'Shop request rejected.',
        decision === 'approved' ? 'success' : 'warning'
      )
      app.refresh()
      setReviewShop(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function submitAssignment(event) {
    event.preventDefault()
    setError('')
    if (!primaryId) {
      setError('Choose a primary salesperson.')
      return
    }
    setSaving(true)
    try {
      await api.assignShopSalespeople({
        shopId: assignShop.id,
        primaryId,
        additionalIds
      })
      app.notify('Shop salespeople updated.', 'success')
      app.refresh()
      setAssignShop(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function submitVisit(event) {
    event.preventDefault()
    setError('')
    setSaving(true)
    try {
      await api.addShopVisit(visitShop.id, visitNote)
      app.notify('Visit logged.', 'success')
      app.refresh()
      setVisitShop(null)
      setVisitNote('')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function toggleAdditional(id) {
    setAdditionalIds(current =>
      current.includes(id) ? current.filter(item => item !== id) : [...current, id]
    )
  }

  const activeReview = reviewShop
  const activeAssign = assignShop

  if (state.error && !state.data) {
    return <DataLoadFailure title="Shops" description="Shop records could not be loaded." message={state.error} onRetry={state.reload} />
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Route book"
        title="Shops"
        description="Approve new outlets, assign the right salesperson and keep contact details current."
        actions={
          <button type="button" className="button-primary" onClick={openAdd}>
            <Icon name="plus" size={16} /> Add shop
          </button>
        }
      />

      <div className="toolbar">
        <Tabs
          items={[
            { id: 'all', label: 'All', count: counts.all },
            { id: 'pending', label: 'Pending', count: counts.pending },
            { id: 'approved', label: 'Approved', count: counts.approved },
            { id: 'rejected', label: 'Rejected', count: counts.rejected }
          ]}
          value={tab}
          onChange={setTab}
        />
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search shop, area or phone…"
          label="Search shops"
        />
      </div>

      <ErrorNote message={state.error} onRetry={state.reload} />
      {state.loading && <LoadingBlock label="Loading shops…" />}

      {!state.loading && !filtered.length && (
        <EmptyState
          icon="shop"
          title={query ? 'No shop matches your search' : tab === 'pending' ? 'No shops waiting' : 'No shops here yet'}
          description={
            query
              ? 'Try a shorter search or clear the filter.'
              : tab === 'pending'
                ? 'Every shop request has been reviewed.'
                : 'Add the first outlet to start taking orders.'
          }
          action={
            !query && (
              <button type="button" className="button-primary button-small" onClick={openAdd}>
                <Icon name="plus" size={15} /> Add shop
              </button>
            )
          }
        />
      )}

      <div className="shop-grid">
        {pagination.visibleItems.map(shop => {
          const address = [
            shop.address_line1,
            shop.address_line2,
            [shop.locality, shop.city].filter(Boolean).join(', '),
            [shop.state, shop.postal_code].filter(Boolean).join(' ')
          ].filter(Boolean)
          return (
            <article className="shop-card" key={shop.id}>
              <header className="shop-card-head">
                <div>
                  <h2>{shop.name}</h2>
                  <StatusBadge status={shop.status} />
                </div>
                {shop.outstanding > 0 && (
                  <span className="outstanding-chip">
                    {formatMoney(shop.outstanding)} due
                  </span>
                )}
              </header>

              <div className="shop-contact">
                {address.length > 0 && (
                  <p>
                    <Icon name="map" size={15} />
                    <span>{address.join(' · ')}</span>
                  </p>
                )}
                {shop.phone && (
                  <p>
                    <Icon name="phone" size={15} />
                    <a href={`tel:${shop.phone}`}>{shop.phone}</a>
                  </p>
                )}
                {shop.email && (
                  <p>
                    <Icon name="mail" size={15} />
                    <a href={`mailto:${shop.email}`}>{shop.email}</a>
                  </p>
                )}
              </div>

              {shop.notes && <p className="shop-note">{shop.notes}</p>}

              <div className="shop-assignees">
                <span className="label">Salespeople</span>
                {shop.salespeople.length ? (
                  <div className="avatar-stack">
                    {shop.salespeople.map(person => (
                      <span key={person.id} className="assignee">
                        {person.name}
                        {person.is_primary && <small>Primary</small>}
                      </span>
                    ))}
                  </div>
                ) : shop.status === 'approved' ? (
                  <Badge tone="warning">Unassigned</Badge>
                ) : (
                  <span className="muted-copy">Assigned on approval</span>
                )}
              </div>

              {shop.status === 'pending' && (
                <p className="shop-submitted">
                  Requested by {shop.submitted_by_name || 'a salesperson'} ·{' '}
                  {formatDate(shop.created_at)}
                </p>
              )}

              {shop.status === 'rejected' && shop.rejection_reason && (
                <InlineNote tone="danger">{shop.rejection_reason}</InlineNote>
              )}

              <footer className="shop-card-actions">
                <button
                  type="button"
                  className="button-ghost button-small"
                  onClick={() => {
                    setVisitShop(shop)
                    setVisitNote('')
                    setError('')
                  }}
                >
                  <Icon name="map" size={15} /> Log visit
                </button>
                {app.isAdmin && shop.status === 'pending' && (
                  <button
                    type="button"
                    className="button-primary button-small"
                    onClick={() => setReviewShop(shop)}
                  >
                    Review request
                  </button>
                )}
                {app.isAdmin && shop.status === 'approved' && (
                  <button
                    type="button"
                    className="button-secondary button-small"
                    onClick={() => setAssignShop(shop)}
                  >
                    Manage team
                  </button>
                )}
                {app.isAdmin && shop.status === 'rejected' && (
                  <button
                    type="button"
                    className="button-ghost button-small"
                    onClick={() => {
                      setReviewShop(shop)
                      setDecision('approved')
                    }}
                  >
                    Reconsider
                  </button>
                )}
              </footer>
            </article>
          )
        })}
      </div>
      <TablePagination page={pagination.page} pageCount={pagination.pageCount} total={filtered.length} pageSize={24} onPageChange={pagination.setPage} />

      <Modal
        open={addOpen}
        onClose={closeAdd}
        size="lg"
        title="Add a shop"
        subtitle="New shops start as pending until an owner or admin approves them."
        footer={
          <>
            <button type="button" className="button-ghost" onClick={closeAdd}>
              Cancel
            </button>
            <button type="submit" form="add-shop-form" className="button-primary" disabled={saving}>
              {saving ? 'Submitting…' : 'Submit shop'}
            </button>
          </>
        }
      >
        <form id="add-shop-form" className="form-stack" onSubmit={submitShop}>
          <div className="two-col">
            <Field label="Shop name" htmlFor="shop-name">
              <input
                id="shop-name"
                value={form.name}
                onChange={event => setForm({ ...form, name: event.target.value })}
                placeholder="e.g. Green Valley Store"
                required
              />
            </Field>
            <Field label="Phone" htmlFor="shop-phone">
              <input
                id="shop-phone"
                type="tel"
                value={form.phone}
                onChange={event => setForm({ ...form, phone: event.target.value })}
                placeholder="Optional"
              />
            </Field>
          </div>
          <Field label="Email" htmlFor="shop-email">
            <input
              id="shop-email"
              type="email"
              value={form.email}
              onChange={event => setForm({ ...form, email: event.target.value })}
              placeholder="Optional"
            />
          </Field>
          <div className="two-col">
            <Field label="Address line 1" htmlFor="shop-address1">
              <input
                id="shop-address1"
                value={form.address_line1}
                onChange={event => setForm({ ...form, address_line1: event.target.value })}
              />
            </Field>
            <Field label="Address line 2" htmlFor="shop-address2">
              <input
                id="shop-address2"
                value={form.address_line2}
                onChange={event => setForm({ ...form, address_line2: event.target.value })}
              />
            </Field>
          </div>
          <div className="three-col">
            <Field label="Locality" htmlFor="shop-locality">
              <input
                id="shop-locality"
                value={form.locality}
                onChange={event => setForm({ ...form, locality: event.target.value })}
              />
            </Field>
            <Field label="City" htmlFor="shop-city">
              <input
                id="shop-city"
                value={form.city}
                onChange={event => setForm({ ...form, city: event.target.value })}
              />
            </Field>
            <Field label="PIN code" htmlFor="shop-pin">
              <input
                id="shop-pin"
                inputMode="numeric"
                value={form.postal_code}
                onChange={event => setForm({ ...form, postal_code: event.target.value })}
              />
            </Field>
          </div>
          <Field label="State" htmlFor="shop-state">
            <input
              id="shop-state"
              value={form.state}
              onChange={event => setForm({ ...form, state: event.target.value })}
            />
          </Field>
          <Field label="Notes" htmlFor="shop-notes" hint="Delivery preferences, gate codes, best time to visit.">
            <textarea
              id="shop-notes"
              rows="2"
              value={form.notes}
              onChange={event => setForm({ ...form, notes: event.target.value })}
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
        open={Boolean(activeReview)}
        onClose={() => setReviewShop(null)}
        title={activeReview ? `Review ${activeReview.name}` : 'Review shop'}
        subtitle="Approval assigns the shop to a primary salesperson."
        footer={
          <>
            <button type="button" className="button-ghost" onClick={() => setReviewShop(null)}>
              Cancel
            </button>
            <button
              type="submit"
              form="review-shop-form"
              className={decision === 'rejected' ? 'button-danger' : 'button-primary'}
              disabled={saving}
            >
              {saving ? 'Saving…' : decision === 'approved' ? 'Approve shop' : 'Reject request'}
            </button>
          </>
        }
      >
        <form id="review-shop-form" className="form-stack" onSubmit={submitReview}>
          <div className="segmented">
            <button
              type="button"
              className={decision === 'approved' ? 'active' : ''}
              onClick={() => setDecision('approved')}
            >
              Approve
            </button>
            <button
              type="button"
              className={decision === 'rejected' ? 'active' : ''}
              onClick={() => setDecision('rejected')}
            >
              Reject
            </button>
          </div>

          {activeReview && (
            <div className="review-summary">
              <strong>{activeReview.name}</strong>
              <span>
                {[activeReview.locality, activeReview.city].filter(Boolean).join(', ') ||
                  'No address supplied'}
              </span>
              {activeReview.notes && <p>{activeReview.notes}</p>}
            </div>
          )}

          {decision === 'approved' ? (
            <>
              <Field label="Primary salesperson" htmlFor="review-primary">
                <select
                  id="review-primary"
                  value={primaryId}
                  onChange={event => setPrimaryId(event.target.value)}
                  required
                >
                  <option value="">Choose an approved employee…</option>
                  {approvedPeople.map(person => (
                    <option key={person.id} value={person.id}>
                      {person.full_name} · {titleCase(person.role)}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="field">
                <span className="field-label">Additional salespeople</span>
                {approvedPeople.filter(person => person.id !== primaryId).length ? (
                  <div className="check-grid">
                    {approvedPeople
                      .filter(person => person.id !== primaryId)
                      .map(person => (
                        <label key={person.id} className="check-row">
                          <input
                            type="checkbox"
                            checked={additionalIds.includes(person.id)}
                            onChange={() => toggleAdditional(person.id)}
                          />
                          <span>{person.full_name}</span>
                        </label>
                      ))}
                  </div>
                ) : (
                  <p className="muted-copy">No other approved employees.</p>
                )}
              </div>
            </>
          ) : (
            <Field label="Rejection reason" htmlFor="review-reason">
              <textarea
                id="review-reason"
                rows="3"
                value={reason}
                onChange={event => setReason(event.target.value)}
                placeholder="Tell the salesperson what needs fixing."
                required
              />
            </Field>
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
        open={Boolean(activeAssign)}
        onClose={() => setAssignShop(null)}
        title={activeAssign ? `Salespeople for ${activeAssign.name}` : 'Assign salespeople'}
        subtitle="The primary salesperson owns the relationship; additional people can also sell."
        footer={
          <>
            <button type="button" className="button-ghost" onClick={() => setAssignShop(null)}>
              Cancel
            </button>
            <button
              type="submit"
              form="assign-shop-form"
              className="button-primary"
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save assignments'}
            </button>
          </>
        }
      >
        <form id="assign-shop-form" className="form-stack" onSubmit={submitAssignment}>
          <Field label="Primary salesperson" htmlFor="assign-primary">
            <select
              id="assign-primary"
              value={primaryId}
              onChange={event => setPrimaryId(event.target.value)}
              required
            >
              <option value="">Choose an approved employee…</option>
              {approvedPeople.map(person => (
                <option key={person.id} value={person.id}>
                  {person.full_name} · {titleCase(person.role)}
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <span className="field-label">Additional salespeople</span>
            <div className="check-grid">
              {approvedPeople
                .filter(person => person.id !== primaryId)
                .map(person => (
                  <label key={person.id} className="check-row">
                    <input
                      type="checkbox"
                      checked={additionalIds.includes(person.id)}
                      onChange={() => toggleAdditional(person.id)}
                    />
                    <span>{person.full_name}</span>
                  </label>
                ))}
            </div>
          </div>
          {error && (
            <div className="inline-note note-danger" role="alert">
              <Icon name="alert" size={17} />
              <div>{error}</div>
            </div>
          )}
        </form>
      </Modal>

      <Modal
        open={Boolean(visitShop)}
        onClose={() => setVisitShop(null)}
        title={visitShop ? `Log a visit to ${visitShop.name}` : 'Log a visit'}
        footer={
          <>
            <button type="button" className="button-ghost" onClick={() => setVisitShop(null)}>
              Cancel
            </button>
            <button type="submit" form="visit-form" className="button-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save visit'}
            </button>
          </>
        }
      >
        <form id="visit-form" className="form-stack" onSubmit={submitVisit}>
          <Field
            label="Visit note"
            htmlFor="visit-note"
            hint="What did you discuss? Order plans, display, competition, payment promises."
          >
            <textarea
              id="visit-note"
              rows="4"
              value={visitNote}
              onChange={event => setVisitNote(event.target.value)}
              placeholder="e.g. Owner wants an extra carton of 1 L next week."
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
    </div>
  )
}
