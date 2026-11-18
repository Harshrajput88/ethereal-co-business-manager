import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { formatDate, titleCase } from '../lib/format'
import Icon from '../components/Icon'
import { Avatar, Badge, ErrorNote, Field, InlineNote, PageHeader, StatusBadge } from '../components/ui'

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Could not read that image.'))
    reader.readAsDataURL(file)
  })
}

export default function Profile() {
  const app = useApp()
  const profile = app.profile
  const [name, setName] = useState(profile?.full_name || '')
  const [saving, setSaving] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const fileRef = useRef(null)

  useEffect(() => {
    setName(profile?.full_name || '')
  }, [profile?.full_name])

  async function saveName(event) {
    event.preventDefault()
    setError('')
    setSaved('')
    if (!name.trim()) {
      setError('Enter your full name.')
      return
    }
    setSaving(true)
    try {
      const updated = await api.updateMyName(name.trim())
      app.setProfile(updated)
      app.notify('Name updated.', 'success')
      setSaved('Name updated.')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function pickAvatar(event) {
    const file = event.target.files?.[0]
    if (!file) return
    setError('')
    setSaved('')
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file (PNG, JPG or WebP).')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Choose an image smaller than 2 MB.')
      return
    }
    setAvatarBusy(true)
    try {
      const payload = app.mode === 'local' ? await readFileAsDataUrl(file) : file
      const updated = await api.updateMyAvatar(payload)
      app.setProfile(updated)
      app.notify('Profile picture updated.', 'success')
      setSaved('Profile picture updated.')
    } catch (err) {
      setError(err.message)
    } finally {
      setAvatarBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Account"
        title="Profile"
        description="Your name and picture appear on activity, invoices and audit records."
      />

      <div className="profile-layout">
        <section className="card profile-card">
          <div className="profile-hero">
            <button
              type="button"
              className="profile-avatar-button"
              onClick={() => fileRef.current?.click()}
              disabled={avatarBusy || app.mode !== 'local'}
              aria-label="Change profile picture"
            >
              {avatarBusy ? (
                <span className="spinner" />
              ) : (
                <Avatar name={profile?.full_name} url={profile?.avatar_url} size={104} />
              )}
              <span className="avatar-edit">
                <Icon name="edit" size={15} />
              </span>
            </button>
            <h2>{profile?.full_name}</h2>
            <p>{profile?.email}</p>
            <div className="profile-badges">
              <Badge tone={profile?.role === 'owner' ? 'success' : profile?.role === 'admin' ? 'info' : 'neutral'}>
                {titleCase(profile?.role)}
              </Badge>
              <StatusBadge status={profile?.status} />
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={pickAvatar}
              hidden
            />
            <p className="muted-copy small">
              {app.mode === 'local'
                ? 'Click the picture to upload a new one (max 2 MB).'
                : 'Cloud profile-picture uploads are temporarily disabled until private storage and access policies are configured.'}
            </p>
          </div>

          <form className="form-stack" onSubmit={saveName}>
            <Field label="Full name" htmlFor="profile-name">
              <input
                id="profile-name"
                value={name}
                onChange={event => setName(event.target.value)}
                autoComplete="name"
                required
              />
            </Field>
            <Field label="Email" htmlFor="profile-email" hint="Email changes are managed by the owner.">
              <input id="profile-email" value={profile?.email || ''} disabled />
            </Field>
            {error && <ErrorNote message={error} />}
            {saved && <InlineNote tone="success">{saved}</InlineNote>}
            <div className="button-row">
              <button type="submit" className="button-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save name'}
              </button>
            </div>
          </form>
        </section>

        <section className="card profile-meta">
          <h2>Account details</h2>
          <dl>
            <div>
              <dt>Role</dt>
              <dd>{titleCase(profile?.role)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <StatusBadge status={profile?.status} />
              </dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd>{formatDate(profile?.created_at)}</dd>
            </div>
            <div>
              <dt>Approved on</dt>
              <dd>{profile?.approved_at ? formatDate(profile.approved_at) : '—'}</dd>
            </div>
            <div>
              <dt>Workspace</dt>
              <dd>{app.mode === 'local' ? 'Local demo' : 'Supabase cloud'}</dd>
            </div>
          </dl>
          <InlineNote tone="info">
            {profile?.role === 'owner'
              ? 'As owner you can change business settings, roles, credit controls and prices.'
              : profile?.role === 'admin'
                ? 'As admin you can approve shops, payments, returns and expenses. Only the owner can change roles and business settings.'
                : 'As a salesperson you see the shops assigned to you and can record sales, payments, returns and expenses for review.'}
          </InlineNote>
          <button type="button" className="button-secondary sign-out" onClick={() => app.signOut()}>
            <Icon name="logout" size={16} /> Sign out
          </button>
        </section>
      </div>
    </div>
  )
}
