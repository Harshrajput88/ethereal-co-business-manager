import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'
import { statusTone, titleCase } from '../lib/format'

export function initials(name = '') {
  return (
    String(name)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0]?.toUpperCase())
      .join('') || '?'
  )
}

export function Avatar({ name, url, size = 40, className = '' }) {
  return (
    <span
      className={`avatar ${className}`}
      style={{ width: size, height: size, fontSize: Math.max(11, size * 0.36) }}
      title={name || 'User'}
    >
      {url ? <img src={url} alt="" /> : initials(name)}
    </span>
  )
}

export function PageHeader({ eyebrow, title, description, actions }) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

export function SectionTitle({ title, description, action }) {
  return (
    <div className="section-title">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function StatCard({ label, value, hint, icon = 'sparkle', tone = 'green' }) {
  return (
    <article className={`stat-tile tone-${tone}`}>
      <span className="stat-tile-icon">
        <Icon name={icon} size={21} />
      </span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        {hint && <small>{hint}</small>}
      </div>
    </article>
  )
}

export function Badge({ children, tone = 'neutral', className = '' }) {
  return <span className={`badge badge-${tone} ${className}`}>{children}</span>
}

export function StatusBadge({ status }) {
  return <Badge tone={statusTone(status)}>{titleCase(status)}</Badge>
}

export function InlineNote({ tone = 'info', children }) {
  return (
    <div className={`inline-note note-${tone}`}>
      <Icon name={tone === 'danger' ? 'alert' : tone === 'warning' ? 'clock' : 'sparkle'} size={17} />
      <div>{children}</div>
    </div>
  )
}

export function ErrorNote({ message, onRetry }) {
  if (!message) return null
  return (
    <div className="inline-note note-danger" role="alert">
      <Icon name="alert" size={18} />
      <div>
        <strong>Could not load this data.</strong>
        <p>{message}</p>
      </div>
      {onRetry && (
        <button type="button" className="button-ghost button-small" onClick={() => onRetry()}>
          <Icon name="refresh" size={15} /> Retry
        </button>
      )}
    </div>
  )
}

export function DataLoadFailure({ title, description, message, onRetry }) {
  return (
    <div className="page-stack">
      <PageHeader title={title} description={description} />
      <ErrorNote message={message} onRetry={onRetry} />
    </div>
  )
}

export function LoadingBlock({ label = 'Loading…' }) {
  return (
    <div className="loading-block" role="status">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  )
}

export function EmptyState({ icon = 'sparkle', title, description, action }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  )
}

export function Field({ label, htmlFor, hint, error, className = '', children }) {
  return (
    <div className={`field ${error ? 'has-error' : ''} ${className}`}>
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? (
        <small className="field-error">{error}</small>
      ) : (
        hint && <small className="field-hint">{hint}</small>
      )}
    </div>
  )
}

export function SearchField({ value, onChange, placeholder = 'Search…', label = 'Search' }) {
  return (
    <label className="search-field">
      <Icon name="search" size={17} />
      <span className="sr-only">{label}</span>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  )
}

export function Tabs({ items, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          className={value === item.id ? 'active' : ''}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count > 0 && <span className="tab-count">{item.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  children,
  footer,
  className = ''
}) {
  const titleId = useId()
  const panelRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onKey = event => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const timer = window.setTimeout(() => {
      const focusable = panelRef.current?.querySelector(
        'input:not([type="hidden"]), select, textarea, button'
      )
      focusable?.focus()
    }, 30)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      window.clearTimeout(timer)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="modal-layer"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={panelRef}
        className={`modal modal-${size} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-button modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </section>
    </div>,
    document.body
  )
}

export function Metric({ label, value, hint }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  )
}

export function ProgressBar({ value, max, tone = 'green' }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className={`progress track-${tone}`} aria-hidden="true">
      <span style={{ width: `${percent}%` }} />
    </div>
  )
}
