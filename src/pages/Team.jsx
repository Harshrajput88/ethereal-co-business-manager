import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { formatDate, formatDateTime, titleCase } from '../lib/format'
import Icon from '../components/Icon'
import {
  Avatar,
  Badge,
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

export default function Team() {
  const app = useApp()
  const [tab, setTab] = useState('all')
  const [query, setQuery] = useState('')
  const [action, setAction] = useState(null)
  const [roleValue, setRoleValue] = useState('salesperson')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const state = useApiData(
    async () => {
      const [team, audit] = await Promise.all([api.getTeam(), api.getAuditLog(100)])
      return { team, audit }
    },
    [app.version]
  )

  const team = state.data?.team || []
  const audit = state.data?.audit || []

  const counts = useMemo(
    () => ({
      all: team.length,
      pending: team.filter(person => person.status === 'pending').length,
      approved: team.filter(person => person.status === 'approved').length,
      disabled: team.filter(person => person.status === 'disabled').length
    }),
    [team]
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return team.filter(person => {
      if (tab !== 'all' && person.status !== tab) return false
      if (!needle) return true
      return [person.full_name, person.email, person.role]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(needle))
    })
  }, [team, tab, query])

  function askStatus(person, status) {
    setAction({ type: 'status', person, value: status })
    setError('')
  }

  function askRole(person, role) {
    if (role === person.role) return
    setAction({ type: 'role', person, value: role })
    setRoleValue(role)
    setError('')
  }

  async function applyAction() {
    if (!action) return
    setError('')
    setBusy(true)
    try {
      if (action.type === 'status') {
        await api.setEmployeeStatus(action.person.id, action.value)
        app.notify(
          `${action.person.full_name} is now ${action.value}.`,
          action.value === 'approved' ? 'success' : 'warning'
        )
      } else {
        await api.setEmployeeRole(action.person.id, roleValue)
        app.notify(`${action.person.full_name} is now ${titleCase(roleValue)}.`, 'success')
      }
      app.refresh()
      state.reload({ quiet: true })
      setAction(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (state.error && !state.data) {
    return <DataLoadFailure title="Team" description="Team access and audit records could not be loaded." message={state.error} onRetry={state.reload} />
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="People"
        title="Team"
        description="Approve new salespeople, manage access and see who can sign in."
      />

      <InlineNote tone="info">
        New people register from the login screen. They stay pending until you approve them here.
        Only the owner can change roles.
      </InlineNote>

      <div className="stats-grid compact-grid">
        <StatCard
          label="Active team"
          value={String(counts.approved)}
          hint="Can sign in"
          icon="team"
          tone="green"
        />
        <StatCard
          label="Pending approval"
          value={String(counts.pending)}
          hint="Waiting for access"
          icon="clock"
          tone={counts.pending ? 'orange' : 'muted'}
        />
        <StatCard
          label="Disabled"
          value={String(counts.disabled)}
          hint="Blocked from signing in"
          icon="lock"
          tone={counts.disabled ? 'danger' : 'muted'}
        />
      </div>

      <div className="toolbar wrap">
        <Tabs
          items={[
            { id: 'all', label: 'All', count: counts.all },
            { id: 'pending', label: 'Pending', count: counts.pending },
            { id: 'approved', label: 'Approved', count: counts.approved },
            { id: 'disabled', label: 'Disabled', count: counts.disabled }
          ]}
          value={tab}
          onChange={setTab}
        />
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Name, email or role…"
          label="Search team"
        />
      </div>

      <ErrorNote message={state.error} onRetry={state.reload} />
      {state.loading && !team.length && <LoadingBlock label="Loading team…" />}

      <section className="card no-pad">
        {filtered.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th className="num">Shops</th>
                  <th>Joined</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(person => {
                  const isSelf = person.id === app.profile?.id
                  return (
                    <tr key={person.id}>
                      <td>
                        <div className="person-cell">
                          <Avatar name={person.full_name} url={person.avatar_url} size={36} />
                          <div>
                            <strong>
                              {person.full_name} {isSelf && <Badge tone="neutral">You</Badge>}
                            </strong>
                            <small>{person.email}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        {app.isOwner && !isSelf ? (
                          <select
                            className="role-select"
                            value={person.role}
                            onChange={event => askRole(person, event.target.value)}
                            aria-label={`Role for ${person.full_name}`}
                          >
                            <option value="salesperson">Salesperson</option>
                            <option value="admin">Admin</option>
                            <option value="owner">Owner</option>
                          </select>
                        ) : (
                          <Badge
                            tone={
                              person.role === 'owner'
                                ? 'success'
                                : person.role === 'admin'
                                  ? 'info'
                                  : 'neutral'
                            }
                          >
                            {titleCase(person.role)}
                          </Badge>
                        )}
                      </td>
                      <td>
                        <StatusBadge status={person.status} />
                      </td>
                      <td className="num">{person.shop_count}</td>
                      <td>{formatDate(person.created_at)}</td>
                      <td>
                        <div className="row-actions">
                          {person.status === 'pending' && (
                            <button
                              type="button"
                              className="button-primary button-tiny"
                              onClick={() => askStatus(person, 'approved')}
                            >
                              <Icon name="check" size={13} /> Approve
                            </button>
                          )}
                          {person.status === 'approved' && !isSelf && (
                            <button
                              type="button"
                              className="button-ghost button-tiny"
                              onClick={() => askStatus(person, 'disabled')}
                            >
                              Disable
                            </button>
                          )}
                          {person.status === 'disabled' && (
                            <button
                              type="button"
                              className="button-secondary button-tiny"
                              onClick={() => askStatus(person, 'approved')}
                            >
                              Reactivate
                            </button>
                          )}
                          {person.status === 'pending' && (
                            <button
                              type="button"
                              className="button-ghost button-tiny"
                              onClick={() => askStatus(person, 'disabled')}
                            >
                              Decline
                            </button>
                          )}
                          {isSelf && <span className="muted-copy">Current account</span>}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon="team"
            title={query ? 'No people match' : 'No team members here'}
            description={query ? 'Try another search.' : 'New registrations will appear here.'}
          />
        )}
      </section>

      <section className="card no-pad">
        <div className="card-head">
          <div>
            <h2>Activity log</h2>
            <p>Recent approvals, sales, payments and stock changes.</p>
          </div>
        </div>
        {audit.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Entity</th>
                </tr>
              </thead>
              <tbody>
                {audit.slice(0, 30).map(entry => (
                  <tr key={entry.id}>
                    <td>{formatDateTime(entry.occurred_at)}</td>
                    <td>{entry.actor_name}</td>
                    <td>
                      <strong>{titleCase(entry.action)}</strong>
                    </td>
                    <td>{titleCase(entry.entity_type)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon="clock" title="No activity recorded" />
        )}
      </section>

      <Modal
        open={Boolean(action)}
        onClose={() => {
          setAction(null)
          setError('')
        }}
        title={
          action?.type === 'role'
            ? `Change role for ${action.person.full_name}`
            : action?.value === 'disabled'
              ? `Disable ${action?.person.full_name}?`
              : `Approve ${action?.person.full_name}?`
        }
        subtitle={
          action?.type === 'role'
            ? 'Roles change what this person can approve and manage.'
            : action?.value === 'disabled'
              ? 'They will be signed out of actions and cannot use the workspace until reactivated.'
              : 'They will be able to sign in and use the workspace.'
        }
        footer={
          <>
            <button
              type="button"
              className="button-ghost"
              onClick={() => {
                setAction(null)
                setError('')
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className={action?.value === 'disabled' ? 'button-danger' : 'button-primary'}
              onClick={applyAction}
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Confirm'}
            </button>
          </>
        }
      >
        {action && (
          <div className="form-stack">
            <div className="person-cell large">
              <Avatar name={action.person.full_name} url={action.person.avatar_url} size={48} />
              <div>
                <strong>{action.person.full_name}</strong>
                <small>{action.person.email}</small>
              </div>
            </div>
            {action.type === 'role' && (
              <Field label="New role" htmlFor="team-role">
                <select
                  id="team-role"
                  value={roleValue}
                  onChange={event => setRoleValue(event.target.value)}
                >
                  <option value="salesperson">Salesperson</option>
                  <option value="admin">Admin</option>
                  <option value="owner">Owner</option>
                </select>
              </Field>
            )}
            {action.type === 'role' && roleValue === 'owner' && (
              <InlineNote tone="warning">
                Owners can manage settings, roles and credit controls. Make sure this is intended.
              </InlineNote>
            )}
            {error && (
              <div className="inline-note note-danger" role="alert">
                <Icon name="alert" size={17} />
                <div>{error}</div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
