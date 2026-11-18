import { useState } from 'react'
import {
  api,
  backendInfo,
  switchToCloudWorkspace,
  switchToLocalWorkspace
} from '../lib/api'
import { DEMO_CREDENTIALS } from '../lib/localSeed'
import Icon from '../components/Icon'

export default function Auth({ onSignedIn }) {
  const [mode, setMode] = useState('login')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  const info = backendInfo()

  function switchMode(next) {
    setMode(next)
    setError('')
    setSuccess('')
    setPassword('')
    setConfirm('')
  }

  function fillDemo(credential) {
    setEmail(credential.email)
    setPassword(credential.password)
    setError('')
    setSuccess('')
  }

  async function submit(event) {
    event.preventDefault()
    setError('')
    setSuccess('')
    if (mode === 'register') {
      if (!fullName.trim()) {
        setError('Enter your full name.')
        return
      }
      if (password.length < 8) {
        setError('Use at least 8 characters for your password.')
        return
      }
      if (password !== confirm) {
        setError('Passwords do not match.')
        return
      }
    }

    setBusy(true)
    try {
      if (mode === 'register') {
        const result = await api.signUp(fullName, email, password)
        if (result?.needsEmailConfirmation) {
          setSuccess(
            'Account created. Check your email to confirm it, then sign in. The owner must approve access.'
          )
          setMode('login')
          setPassword('')
          setConfirm('')
        } else {
          const session = await api.getSession()
          if (session?.profile) onSignedIn(session.profile)
        }
      } else {
        await api.signIn(email.trim(), password)
        const session = await api.getSession()
        if (!session?.profile) {
          throw new Error('Your profile could not be loaded. Ask the owner to check your account.')
        }
        onSignedIn(session.profile)
      }
    } catch (err) {
      setError(err.message || 'Sign in failed. Check your details and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-visual">
        <div className="auth-visual-image" />
        <div className="auth-brand-block">
          <p className="auth-mark">
            <span className="auth-trees">♣♣♣</span>
            <span className="auth-brand-name">Ethereal</span>
            <span className="auth-brand-co">Co.</span>
          </p>
          <div className="auth-brand-rule" />
          <p className="auth-brand-sub">Business Manager</p>
        </div>
        <div className="auth-visual-copy">
          <h1>Quietly run the whole water business.</h1>
          <p>Shops, sales, collections, stock and expenses in one calm workspace.</p>
        </div>
        <footer className="auth-visual-foot">
          <span>Bottled water, delivered with care</span>
          <span>Patna · Bihar</span>
        </footer>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <header className="auth-head">
            <p className="page-eyebrow">
              {mode === 'login' ? 'Welcome back' : 'Request access'}
            </p>
            <h2>{mode === 'login' ? 'Sign in to your workspace' : 'Create your account'}</h2>
            <p>
              {mode === 'login'
                ? 'Use the email and password your owner approved.'
                : 'New accounts are created as salespeople and need owner approval before use.'}
            </p>
          </header>

          {info.mode === 'local' && (
            <div className="auth-mode">
              <Icon name="device" size={16} />
              <span>Local demo workspace</span>
              <small>Data stays in this browser</small>
            </div>
          )}
          {info.mode === 'unconfigured' && (
            <div className="auth-error" role="alert">
              <Icon name="alert" size={17} />
              <span>Cloud access is not configured. Set the public Supabase URL and anon/publishable key. Demo data has not been substituted.</span>
            </div>
          )}

          <form className="auth-form" onSubmit={submit}>
            {mode === 'register' && (
              <label className="field">
                <span>Full name</span>
                <input
                  type="text"
                  value={fullName}
                  onChange={event => setFullName(event.target.value)}
                  autoComplete="name"
                  placeholder="e.g. Rohan Kumar"
                  required
                />
              </label>
            )}
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
                required
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder={mode === 'register' ? 'At least 8 characters' : '••••••••'}
                required
              />
            </label>
            {mode === 'register' && (
              <label className="field">
                <span>Confirm password</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={event => setConfirm(event.target.value)}
                  autoComplete="new-password"
                  required
                />
              </label>
            )}

            {error && (
              <div className="auth-error" role="alert">
                <Icon name="alert" size={17} />
                <span>{error}</span>
              </div>
            )}
            {success && (
              <div className="auth-success" role="status">
                <Icon name="check" size={17} />
                <span>{success}</span>
              </div>
            )}

            <button type="submit" className="auth-submit" disabled={busy}>
              {busy
                ? 'Please wait…'
                : mode === 'login'
                  ? 'Sign in'
                  : 'Create account'}
              {!busy && <Icon name="arrow" size={17} />}
            </button>
          </form>

          <p className="auth-switch">
            {mode === 'login' ? 'New to the team?' : 'Already have an account?'}
            <button
              type="button"
              onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
            >
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </p>

          {mode === 'login' && info.mode === 'local' && (
            <section className="demo-box">
              <div className="demo-box-head">
                <strong>Try the demo</strong>
                <span>Click a role to fill the form</span>
              </div>
              <div className="demo-list">
                {DEMO_CREDENTIALS.map(credential => (
                  <button key={credential.email} type="button" onClick={() => fillDemo(credential)}>
                    <span>{credential.role}</span>
                    <small>{credential.email}</small>
                    <small>{credential.password}</small>
                  </button>
                ))}
              </div>
            </section>
          )}

          <footer className="auth-footer">
            <span>Protected workspace · {info.mode === 'local' ? 'Demo data' : 'Supabase'}</span>
            <div className="auth-workspace-switch">
              {info.mode === 'local' && info.supabaseConfigured && (
                <button type="button" onClick={switchToCloudWorkspace}>
                  Use cloud workspace
                </button>
              )}
              {info.mode === 'supabase' && (
                <button type="button" onClick={switchToLocalWorkspace}>
                  Open demo instead
                </button>
              )}
            </div>
          </footer>
        </div>
        <p className="auth-legal">
          Access is limited to approved Ethereal Co. team members. Contact the owner if you cannot
          sign in.
        </p>
      </section>
    </main>
  )
}
