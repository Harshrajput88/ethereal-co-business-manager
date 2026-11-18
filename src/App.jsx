import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, backendInfo, initializeApi } from './lib/api'
import {
  getIntegrationStatus,
  subscribeIntegrationStatus
} from './lib/integrationStatus'
import { AppContext } from './AppContext'
import { formatDate, titleCase } from './lib/format'
import { useApiData } from './hooks/useApiData'
import Icon from './components/Icon'
import { Avatar, Badge, InlineNote } from './components/ui'
import Auth from './pages/Auth'
import Overview from './pages/Overview'
import Sales from './pages/Sales'
import Payments from './pages/Payments'
import Shops from './pages/Shops'
import Inventory from './pages/Inventory'
import Returns from './pages/Returns'
import Expenses from './pages/Expenses'
import Invoices from './pages/Invoices'
import Reports from './pages/Reports'
import Team from './pages/Team'
import Settings from './pages/Settings'
import Profile from './pages/Profile'
import './App.css'

const PAGES = {
  overview: { title: 'Overview', description: 'Today at a glance' },
  sales: { title: 'Sales', description: 'Orders and invoices' },
  payments: { title: 'Payments', description: 'Collections and verification' },
  shops: { title: 'Shops', description: 'Route book' },
  inventory: { title: 'Inventory', description: 'Godown stock' },
  returns: { title: 'Returns', description: 'Stock coming back' },
  expenses: { title: 'Expenses', description: 'Business spend' },
  invoices: { title: 'Invoices', description: 'Documents' },
  reports: { title: 'Reports', description: 'Performance and exports' },
  team: { title: 'Team', description: 'People and access' },
  settings: { title: 'Settings', description: 'Workspace configuration' },
  profile: { title: 'Profile', description: 'Your account' }
}

const NAV_ICONS = {
  overview: 'overview',
  sales: 'sales',
  payments: 'payments',
  shops: 'shop',
  inventory: 'inventory',
  returns: 'returns',
  expenses: 'expenses',
  invoices: 'invoices',
  reports: 'reports',
  team: 'team',
  settings: 'settings',
  profile: 'profile'
}

function ToastStack({ toasts }) {
  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map(toast => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          <Icon
            name={toast.tone === 'danger' ? 'alert' : toast.tone === 'warning' ? 'clock' : 'check'}
            size={18}
          />
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  )
}

function StartupScreen({ error, onRetry }) {
  return (
    <main className="startup-screen">
      <div className="startup-brand">
        <p className="auth-mark">
          <span className="auth-trees">♣♣♣</span>
          <span className="auth-brand-name">Ethereal</span>
          <span className="auth-brand-co">Co.</span>
        </p>
        <p className="auth-brand-sub">Business Manager</p>
      </div>
      {error ? (
        <div className="startup-card">
          <Icon name="alert" size={28} />
          <h1>The workspace could not start</h1>
          <p>{error}</p>
          <button type="button" className="button-primary" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : (
        <div className="startup-loading">
          <span className="spinner large" />
          <p>Opening the workspace…</p>
        </div>
      )}
    </main>
  )
}

function AccountScreen({ profile, needsOwner, allowOwnerClaim, onClaimOwner, onSignOut, busy, error }) {
  const disabled = profile?.status === 'disabled'
  return (
    <main className="account-screen">
      <section className="account-card">
        <span className={`account-icon ${disabled ? 'danger' : ''}`}>
          <Icon name={disabled ? 'lock' : 'clock'} size={28} />
        </span>
        <p className="page-eyebrow">Ethereal Co. Business Manager</p>
        <h1>{disabled ? 'Your account is disabled' : 'Your account is waiting for approval'}</h1>
        <p>
          {disabled
            ? 'An owner or admin has disabled access for this account. Contact the owner if this was a mistake.'
            : 'An owner or admin needs to approve your account before you can use the workspace.'}
        </p>
        <div className="account-person">
          <Avatar name={profile?.full_name} url={profile?.avatar_url} size={48} />
          <div>
            <strong>{profile?.full_name}</strong>
            <span>{profile?.email}</span>
          </div>
          <Badge tone={disabled ? 'danger' : 'warning'}>{titleCase(profile?.status || 'pending')}</Badge>
        </div>
        {needsOwner && (
          <InlineNote tone="info">
            {allowOwnerClaim
              ? 'No owner account exists yet. Claim the local demo workspace to continue.'
              : 'Owner setup is restricted to the business operator. Contact the Ethereal Co. system administrator to activate the designated owner account.'}
          </InlineNote>
        )}
        {error && (
          <div className="inline-note note-danger" role="alert">
            <Icon name="alert" size={17} />
            <div>{error}</div>
          </div>
        )}
        <div className="button-row">
          <button type="button" className="button-ghost" onClick={onSignOut}>
            <Icon name="logout" size={16} /> Sign out
          </button>
          {needsOwner && allowOwnerClaim && (
            <button type="button" className="button-primary" onClick={onClaimOwner} disabled={busy}>
              {busy ? 'Claiming…' : 'Claim demo owner account'}
            </button>
          )}
        </div>
      </section>
    </main>
  )
}

function SessionErrorScreen({ message, onSignOut, onRetry }) {
  return (
    <main className="account-screen">
      <section className="account-card">
        <span className="account-icon danger">
          <Icon name="alert" size={28} />
        </span>
        <p className="page-eyebrow">Ethereal Co. Business Manager</p>
        <h1>Your profile could not be loaded</h1>
        <p>{message || 'The account exists but its profile is unavailable. Ask the owner to check your access.'}</p>
        <div className="button-row">
          <button type="button" className="button-secondary" onClick={onRetry}>
            Retry profile load
          </button>
        <button type="button" className="button-primary" onClick={onSignOut}>
          Sign out
        </button>
        </div>
      </section>
    </main>
  )
}

export default function App() {
  const [ready, setReady] = useState(false)
  const [initError, setInitError] = useState('')
  const [initAttempt, setInitAttempt] = useState(0)
  const [backend, setBackend] = useState(null)
  const [integration, setIntegration] = useState(getIntegrationStatus)
  const [profile, setProfile] = useState(null)
  const [hasSession, setHasSession] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [activePage, setActivePage] = useState('overview')
  const [version, setVersion] = useState(0)
  const [toasts, setToasts] = useState([])
  const [needsOwner, setNeedsOwner] = useState(false)
  const [claimBusy, setClaimBusy] = useState(false)
  const [claimError, setClaimError] = useState('')

  const notify = useCallback((message, tone = 'success') => {
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`
    setToasts(current => [...current, { id, message, tone }])
    window.setTimeout(() => {
      setToasts(current => current.filter(toast => toast.id !== id))
    }, 4200)
  }, [])

  const refresh = useCallback(() => {
    setVersion(current => current + 1)
  }, [])

  useEffect(() => {
    let mounted = true
    setReady(false)
    setInitError('')
    initializeApi()
      .then(async () => {
        if (!mounted) return
        setBackend(backendInfo())
        const session = await api.getSession()
        if (!mounted) return
        setHasSession(Boolean(session?.user))
        setProfile(session?.profile || null)
        setProfileError(session?.profileError || '')
        setReady(true)
      })
      .catch(error => {
        if (!mounted) return
        setInitError(error.message || 'The workspace could not start.')
        setReady(true)
      })
    return () => {
      mounted = false
    }
  }, [initAttempt])

  useEffect(() => {
    if (!ready || !backend) return undefined
    let unsubscribe
    try {
      unsubscribe = api.onAuthChange(async () => {
        const session = await api.getSession()
        setHasSession(Boolean(session?.user))
        setProfile(session?.profile || null)
        setProfileError(session?.profileError || '')
      })
    } catch {
      // The backend may not expose auth events; explicit sign-in handles it.
    }
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [ready, backend])

  const isApproved = profile?.status === 'approved'
  const dashboard = useApiData(() => api.getDashboard(), [version], {
    enabled: ready && isApproved
  })
  const metrics = dashboard.data

  useEffect(
    () => subscribeIntegrationStatus(setIntegration),
    []
  )

  useEffect(() => {
    if (!ready || !profile || isApproved) {
      setNeedsOwner(false)
      return
    }
    let cancelled = false
    api
      .needsFirstOwner()
      .then(value => {
        if (!cancelled) setNeedsOwner(Boolean(value))
      })
      .catch(() => {
        if (!cancelled) setNeedsOwner(false)
      })
    return () => {
      cancelled = true
    }
  }, [ready, profile, isApproved, version])

  useEffect(() => {
    document.title = `${PAGES[activePage]?.title || 'Overview'} · Ethereal Co.`
  }, [activePage])

  const signOut = useCallback(async () => {
    try {
      await api.signOut()
    } catch {
      // Signing out locally is still safe if the network call fails.
    }
    setHasSession(false)
    setProfile(null)
    setProfileError('')
    setActivePage('overview')
  }, [])

  const retryProfile = useCallback(async () => {
    setProfileError('')
    try {
      const session = await api.getSession()
      setHasSession(Boolean(session?.user))
      setProfile(session?.profile || null)
      setProfileError(session?.profileError || '')
    } catch (error) {
      setProfileError(error.message || 'The profile could not be loaded. Retry.')
    }
  }, [])

  async function claimOwner() {
    setClaimError('')
    setClaimBusy(true)
    try {
      await api.claimOwner()
      const session = await api.getSession()
      setProfile(session?.profile || null)
      setHasSession(Boolean(session?.user))
      setNeedsOwner(false)
      notify('Owner account claimed. You can now approve the team.', 'success')
      refresh()
    } catch (error) {
      setClaimError(error.message)
    } finally {
      setClaimBusy(false)
    }
  }

  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin'
  const isOwner = profile?.role === 'owner'

  const nav = useMemo(() => {
    const items = [
      { id: 'overview', label: 'Overview' },
      { id: 'sales', label: 'Sales', badge: metrics?.pending_credit_sales },
      { id: 'payments', label: 'Payments', badge: metrics?.pending_payments },
      { id: 'shops', label: 'Shops', badge: metrics?.pending_shops },
      { id: 'inventory', label: 'Inventory' },
      { id: 'returns', label: 'Returns', badge: metrics?.pending_returns },
      { id: 'expenses', label: 'Expenses', badge: metrics?.pending_expenses },
      { id: 'invoices', label: 'Invoices' },
      { id: 'reports', label: 'Reports' }
    ]
    if (isAdmin) {
      items.push({ id: 'team', label: 'Team', badge: metrics?.pending_employees })
      items.push({ id: 'settings', label: 'Settings' })
    }
    items.push({ id: 'profile', label: 'Profile' })
    return items
  }, [isAdmin, metrics])

  const pendingTotal =
    (metrics?.pending_credit_sales || 0) +
    (metrics?.pending_payments || 0) +
    (metrics?.pending_shops || 0) +
    (metrics?.pending_returns || 0) +
    (metrics?.pending_expenses || 0) +
    (metrics?.pending_employees || 0)

  const pendingTarget = metrics
    ? metrics.pending_credit_sales
      ? 'sales'
      : metrics.pending_payments
        ? 'payments'
        : metrics.pending_shops
          ? 'shops'
          : metrics.pending_returns
            ? 'returns'
            : metrics.pending_expenses
              ? 'expenses'
              : metrics.pending_employees
                ? 'team'
                : null
    : null

  const contextValue = useMemo(
    () => ({
      profile,
      setProfile,
      mode: backend?.mode || 'local',
      isAdmin,
      isOwner,
      version,
      refresh,
      notify,
      signOut
    }),
    [profile, backend, isAdmin, isOwner, version, refresh, notify, signOut]
  )

  if (!ready) {
    return <StartupScreen error={initError} onRetry={() => setInitAttempt(current => current + 1)} />
  }

  if (!profile) {
    if (hasSession && profileError) {
      return <SessionErrorScreen message={profileError} onSignOut={signOut} onRetry={retryProfile} />
    }
    return <Auth onSignedIn={nextProfile => {
      setProfile(nextProfile)
      setHasSession(true)
      setProfileError('')
      setActivePage('overview')
    }} />
  }

  if (!isApproved) {
    return (
      <AccountScreen
        profile={profile}
        needsOwner={needsOwner}
        allowOwnerClaim={backend?.mode === 'local'}
        onClaimOwner={claimOwner}
        onSignOut={signOut}
        busy={claimBusy}
        error={claimError}
      />
    )
  }

  const page = PAGES[activePage] || PAGES.overview

  function renderPage() {
    switch (activePage) {
      case 'sales':
        return <Sales />
      case 'payments':
        return <Payments />
      case 'shops':
        return <Shops />
      case 'inventory':
        return <Inventory />
      case 'returns':
        return <Returns />
      case 'expenses':
        return <Expenses />
      case 'invoices':
        return <Invoices />
      case 'reports':
        return <Reports />
      case 'team':
        return isAdmin ? <Team /> : <Overview onNavigate={setActivePage} />
      case 'settings':
        return isAdmin ? <Settings /> : <Overview onNavigate={setActivePage} />
      case 'profile':
        return <Profile />
      default:
        return <Overview onNavigate={setActivePage} />
    }
  }

  return (
    <AppContext.Provider value={contextValue}>
      <div className="app-shell">
        <aside className="sidebar" aria-label="Main navigation">
          <button type="button" className="brand-lockup" onClick={() => setActivePage('overview')}>
            <span className="brand-trees" aria-hidden="true">
              ♣♣♣
            </span>
            <span className="brand-name">Ethereal</span>
            <span className="brand-co">Co.</span>
            <span className="brand-rule" aria-hidden="true" />
            <span className="brand-subtitle">Business Manager</span>
          </button>
          <p className="nav-label">Workspace</p>
          <nav className="sidebar-nav">
            {nav.map(item => (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${activePage === item.id ? 'active' : ''}`}
                onClick={() => setActivePage(item.id)}
                aria-current={activePage === item.id ? 'page' : undefined}
              >
                <span className="nav-icon">
                  <Icon name={NAV_ICONS[item.id]} size={19} />
                </span>
                <span>{item.label}</span>
                {item.badge > 0 && <span className="nav-badge">{item.badge}</span>}
              </button>
            ))}
          </nav>
          <div className="sidebar-art" aria-hidden="true" />
          <p className="sidebar-tagline">Pure water, delivered with care</p>
          <div className="sidebar-tagline-rule" aria-hidden="true" />
          <div className="sidebar-user">
            <Avatar name={profile.full_name} url={profile.avatar_url} size={36} />
            <div>
              <strong>{profile.full_name}</strong>
              <span>{titleCase(profile.role)}</span>
            </div>
            <button type="button" className="sidebar-signout" onClick={signOut} aria-label="Sign out">
              <Icon name="logout" size={17} />
            </button>
          </div>
          <p className="sidebar-mode" title={backend?.lastError || backend?.reason}>
            <span className={`connection-dot ${backend?.mode === 'supabase' && integration.connection === 'connected' && integration.businessApi === 'ready' ? 'is-online' : ''}`} />
            {backend?.mode === 'local'
              ? 'Local demo'
              : backend?.mode === 'unconfigured'
                ? 'Cloud not configured'
                : integration.businessApi === 'error'
                  ? 'Cloud API error'
                  : integration.connection === 'disconnected'
                    ? 'Cloud disconnected'
                    : integration.businessApi === 'ready'
                      ? 'Cloud · API responding'
                      : 'Cloud · API checking'}
          </p>
        </aside>

        <div className="main-area">
          <header className="topbar">
            <div className="topbar-title">
              <h2>{page.title}</h2>
              <p>
                {formatDate(new Date())} · {page.description}
              </p>
            </div>
            <div className="topbar-actions">
              {isAdmin && pendingTotal > 0 && pendingTarget && (
                <button
                  type="button"
                  className="topbar-alert"
                  onClick={() => setActivePage(pendingTarget)}
                  title="Open the next thing waiting for approval"
                >
                  <Icon name="alert" size={16} />
                  <span>{pendingTotal} waiting</span>
                </button>
              )}
              <span className={`connection-dot ${backend?.mode === 'supabase' && integration.connection === 'connected' && integration.businessApi === 'ready' ? 'is-online' : ''}`} />
              <span className="connection-text" title={integration.lastError || backend?.reason}>
                {backend?.mode === 'local'
                  ? 'Demo'
                  : backend?.mode === 'unconfigured'
                    ? 'Not configured'
                    : integration.businessApi === 'error'
                      ? 'API error'
                      : integration.connection === 'disconnected'
                        ? 'Disconnected'
                        : integration.businessApi === 'ready'
                          ? 'Supabase · API responding'
                          : 'Supabase · Checking'}
              </span>
              <button
                type="button"
                className="top-avatar"
                onClick={() => setActivePage('profile')}
                aria-label="Open profile"
              >
                {profile.avatar_url ? (
                  <img src={profile.avatar_url} alt="" />
                ) : (
                  <span>{profile.full_name?.slice(0, 1)}</span>
                )}
              </button>
            </div>
          </header>
          <div className="dashboard-content">{renderPage()}</div>
        </div>
        <ToastStack toasts={toasts} />
      </div>
    </AppContext.Provider>
  )
}
