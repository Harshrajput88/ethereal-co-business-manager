import { useEffect, useMemo, useState } from 'react'
import { api, backendInfo, resetLocalWorkspace, switchToCloudWorkspace, switchToLocalWorkspace } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { formatMoney, titleCase } from '../lib/format'
import Icon from '../components/Icon'
import {
  Badge,
  ErrorNote,
  DataLoadFailure,
  Field,
  InlineNote,
  LoadingBlock,
  Modal,
  PageHeader,
  SectionTitle
} from '../components/ui'

const blankSettings = {
  business_name: '',
  tagline: '',
  address: '',
  phone: '',
  email: '',
  gstin: ''
}

export default function Settings() {
  const app = useApp()
  const [form, setForm] = useState(blankSettings)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [settingsSaved, setSettingsSaved] = useState(false)

  const [defaults, setDefaults] = useState({})
  const [priceBusy, setPriceBusy] = useState('')
  const [priceError, setPriceError] = useState('')

  const [shopId, setShopId] = useState('')
  const [overrides, setOverrides] = useState({})
  const [overrideError, setOverrideError] = useState('')

  const [blockOpen, setBlockOpen] = useState(false)
  const [blockReason, setBlockReason] = useState('')
  const [creditError, setCreditError] = useState('')
  const [creditSaving, setCreditSaving] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')

  const state = useApiData(
    async () => {
      const [settings, credit, catalog, shops, shopPrices] = await Promise.all([
        api.getBusinessSettings(),
        api.getCreditStatus(),
        api.getCatalog(),
        api.getShops(),
        app.isAdmin ? api.getShopPrices() : []
      ])
      return { settings, credit, catalog, shops, shopPrices }
    },
    [app.version]
  )

  const data = state.data
  const info = backendInfo()

  useEffect(() => {
    if (!data?.settings) return
    setForm({
      business_name: data.settings.business_name || '',
      tagline: data.settings.tagline || '',
      address: data.settings.address || '',
      phone: data.settings.phone || '',
      email: data.settings.email || '',
      gstin: data.settings.gstin || ''
    })
  }, [data?.settings])

  useEffect(() => {
    if (!data?.catalog) return
    setDefaults(
      Object.fromEntries(
        data.catalog.map(item => [
          item.variant_id,
          item.default_price === null || item.default_price === undefined
            ? ''
            : String(item.default_price)
        ])
      )
    )
  }, [data?.catalog])

  useEffect(() => {
    if (!data?.shopPrices) return
    setOverrides(
      Object.fromEntries(
        data.shopPrices.map(price => [price.variant_id, String(price.amount)])
      )
    )
  }, [data?.shopPrices, shopId])

  const approvedShops = (data?.shops || []).filter(shop => shop.status === 'approved')
  const catalog = data?.catalog || []
  const shopOverrides = useMemo(() => {
    if (!data?.shopPrices) return {}
    return Object.fromEntries(
      data.shopPrices
        .filter(price => price.shop_id === shopId)
        .map(price => [price.variant_id, String(price.amount)])
    )
  }, [data?.shopPrices, shopId])

  useEffect(() => {
    setOverrides(shopOverrides)
  }, [shopOverrides])

  async function saveSettings(event) {
    event.preventDefault()
    setSettingsError('')
    setSettingsSaved(false)
    if (!form.business_name.trim()) {
      setSettingsError('Business name is required.')
      return
    }
    setSettingsSaving(true)
    try {
      await api.updateBusinessSettings(form)
      app.notify('Business details saved.', 'success')
      app.refresh()
      setSettingsSaved(true)
    } catch (err) {
      setSettingsError(err.message)
    } finally {
      setSettingsSaving(false)
    }
  }

  async function saveDefault(item) {
    const value = defaults[item.variant_id]
    setPriceError('')
    if (!Number(value) || Number(value) <= 0) {
      setPriceError(`Enter a price greater than zero for ${item.product_name}.`)
      return
    }
    setPriceBusy(item.variant_id)
    try {
      await api.setDefaultPrice(item.variant_id, Number(value))
      app.notify(`Default price updated for ${item.product_name}.`, 'success')
      app.refresh()
      state.reload({ quiet: true })
    } catch (err) {
      setPriceError(err.message)
    } finally {
      setPriceBusy('')
    }
  }

  async function saveOverride(item) {
    setOverrideError('')
    if (!shopId) {
      setOverrideError('Choose a shop first.')
      return
    }
    const value = overrides[item.variant_id]
    if (!Number(value) || Number(value) <= 0) {
      setOverrideError(`Enter a shop price greater than zero for ${item.product_name}.`)
      return
    }
    setPriceBusy(item.variant_id)
    try {
      await api.setShopPrice(shopId, item.variant_id, Number(value))
      app.notify(`Shop price saved for ${item.product_name}.`, 'success')
      app.refresh()
      state.reload({ quiet: true })
    } catch (err) {
      setOverrideError(err.message)
    } finally {
      setPriceBusy('')
    }
  }

  async function clearOverride(item) {
    setOverrideError('')
    setPriceBusy(item.variant_id)
    try {
      await api.clearShopPrice(shopId, item.variant_id)
      app.notify(`Shop override removed for ${item.product_name}.`, 'success')
      app.refresh()
      state.reload({ quiet: true })
    } catch (err) {
      setOverrideError(err.message)
    } finally {
      setPriceBusy('')
    }
  }

  async function saveCredit(blocked) {
    setCreditError('')
    if (blocked && !blockReason.trim()) {
      setCreditError('Explain why credit sales are being blocked.')
      return
    }
    setCreditSaving(true)
    try {
      await api.setCreditBlock(blocked, blocked ? blockReason.trim() : '')
      app.notify(blocked ? 'Credit sales blocked.' : 'Credit sales unblocked.', 'success')
      app.refresh()
      state.reload({ quiet: true })
      setBlockOpen(false)
      setBlockReason('')
    } catch (err) {
      setCreditError(err.message)
    } finally {
      setCreditSaving(false)
    }
  }

  if (state.error && !state.data) {
    return <DataLoadFailure title="Settings" description="Business and pricing settings could not be loaded." message={state.error} onRetry={state.reload} />
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Workspace"
        title="Settings"
        description="Business identity, credit controls and the prices used to record sales."
      />

      <ErrorNote message={state.error} onRetry={state.reload} />
      {state.loading && !data && <LoadingBlock label="Loading settings…" />}

      {data && (
        <>
          <section className="card">
            <SectionTitle
              title="Business details"
              description="These appear on invoices and receipts."
              action={app.isOwner ? <Badge tone="success">Owner editable</Badge> : <Badge tone="neutral">Read-only</Badge>}
            />
            <form className="form-stack" onSubmit={saveSettings}>
              <div className="two-col">
                <Field label="Business name" htmlFor="settings-name">
                  <input
                    id="settings-name"
                    value={form.business_name}
                    onChange={event => setForm({ ...form, business_name: event.target.value })}
                    disabled={!app.isOwner}
                    required
                  />
                </Field>
                <Field label="Tagline" htmlFor="settings-tagline">
                  <input
                    id="settings-tagline"
                    value={form.tagline}
                    onChange={event => setForm({ ...form, tagline: event.target.value })}
                    disabled={!app.isOwner}
                    placeholder="Pure water, delivered with care"
                  />
                </Field>
              </div>
              <Field label="Address" htmlFor="settings-address">
                <textarea
                  id="settings-address"
                  rows="2"
                  value={form.address}
                  onChange={event => setForm({ ...form, address: event.target.value })}
                  disabled={!app.isOwner}
                />
              </Field>
              <div className="two-col">
                <Field label="Phone" htmlFor="settings-phone">
                  <input
                    id="settings-phone"
                    value={form.phone}
                    onChange={event => setForm({ ...form, phone: event.target.value })}
                    disabled={!app.isOwner}
                  />
                </Field>
                <Field label="Email" htmlFor="settings-email">
                  <input
                    id="settings-email"
                    type="email"
                    value={form.email}
                    onChange={event => setForm({ ...form, email: event.target.value })}
                    disabled={!app.isOwner}
                  />
                </Field>
              </div>
              <Field label="GSTIN" htmlFor="settings-gstin" hint="Leave blank for non-GST invoicing.">
                <input
                  id="settings-gstin"
                  value={form.gstin}
                  onChange={event => setForm({ ...form, gstin: event.target.value })}
                  disabled={!app.isOwner}
                />
              </Field>
              {settingsError && (
                <div className="inline-note note-danger" role="alert">
                  <Icon name="alert" size={17} />
                  <div>{settingsError}</div>
                </div>
              )}
              {settingsSaved && <InlineNote tone="success">Business details saved.</InlineNote>}
              {app.isOwner ? (
                <div className="button-row">
                  <button type="submit" className="button-primary" disabled={settingsSaving}>
                    {settingsSaving ? 'Saving…' : 'Save business details'}
                  </button>
                </div>
              ) : (
                <InlineNote tone="info">Only the owner can change business details.</InlineNote>
              )}
            </form>
          </section>

          <section className="card">
            <SectionTitle
              title="Credit control"
              description="A global switch that stops new credit sales immediately."
              action={
                <Badge tone={data.credit.blocked ? 'danger' : 'success'}>
                  {data.credit.blocked ? 'Blocked' : 'Credit open'}
                </Badge>
              }
            />
            {data.credit.blocked ? (
              <div className="stack-md">
                <InlineNote tone="danger">
                  <strong>Credit sales are blocked.</strong> {data.credit.reason || 'No reason recorded.'}
                </InlineNote>
                {app.isOwner && (
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => saveCredit(false)}
                    disabled={creditSaving}
                  >
                    {creditSaving ? 'Saving…' : 'Unblock credit sales'}
                  </button>
                )}
              </div>
            ) : (
              <div className="stack-md">
                <p className="muted-copy">
                  Credit sales require owner or admin approval and are counted as outstanding until
                  paid.
                </p>
                {app.isOwner ? (
                  <button type="button" className="button-secondary" onClick={() => setBlockOpen(true)}>
                    <Icon name="lock" size={16} /> Block credit sales
                  </button>
                ) : (
                  <InlineNote tone="info">Only the owner can change credit controls.</InlineNote>
                )}
              </div>
            )}
            {creditError && <ErrorNote message={creditError} />}
          </section>

          <section className="card">
            <SectionTitle
              title="Default prices"
              description="Used when a shop has no override. Prices are per carton."
            />
            {priceError && <ErrorNote message={priceError} />}
            <div className="price-list">
              {catalog.map(item => (
                <div className="price-row" key={item.variant_id}>
                  <div>
                    <strong>{item.product_name}</strong>
                    <span>
                      {item.sku} · {item.bottles_per_carton} bottles / carton
                    </span>
                  </div>
                  <label>
                    <span className="sr-only">Default price for {item.product_name}</span>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={defaults[item.variant_id] ?? ''}
                      onChange={event =>
                        setDefaults(previous => ({
                          ...previous,
                          [item.variant_id]: event.target.value
                        }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="button-secondary button-small"
                    onClick={() => saveDefault(item)}
                    disabled={priceBusy === item.variant_id}
                  >
                    {priceBusy === item.variant_id ? 'Saving…' : 'Save'}
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <SectionTitle
              title="Shop price overrides"
              description="A shop-specific carton price wins over the default. Remove it to fall back."
            />
            <Field label="Shop" htmlFor="price-shop">
              <select id="price-shop" value={shopId} onChange={event => setShopId(event.target.value)}>
                <option value="">Choose an approved shop…</option>
                {approvedShops.map(shop => (
                  <option key={shop.id} value={shop.id}>
                    {shop.name}
                  </option>
                ))}
              </select>
            </Field>
            {overrideError && <ErrorNote message={overrideError} />}
            {!shopId ? (
              <p className="muted-copy">Choose a shop to see and edit its overrides.</p>
            ) : (
              <div className="price-list">
                {catalog.map(item => {
                  const hasOverride = Boolean(shopOverrides[item.variant_id])
                  return (
                    <div className="price-row" key={item.variant_id}>
                      <div>
                        <strong>{item.product_name}</strong>
                        <span>
                          Default {formatMoney(item.default_price)}{' '}
                          {hasOverride && <Badge tone="info">Override active</Badge>}
                        </span>
                      </div>
                      <label>
                        <span className="sr-only">Shop price for {item.product_name}</span>
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={overrides[item.variant_id] ?? ''}
                          onChange={event =>
                            setOverrides(previous => ({
                              ...previous,
                              [item.variant_id]: event.target.value
                            }))
                          }
                          placeholder={item.default_price ? String(item.default_price) : ''}
                        />
                      </label>
                      <div className="price-actions">
                        <button
                          type="button"
                          className="button-secondary button-small"
                          onClick={() => saveOverride(item)}
                          disabled={priceBusy === item.variant_id}
                        >
                          Save
                        </button>
                        {hasOverride && (
                          <button
                            type="button"
                            className="button-ghost button-small"
                            onClick={() => clearOverride(item)}
                            disabled={priceBusy === item.variant_id}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="card">
            <SectionTitle
              title="Workspace mode"
              description="Where this session's data lives."
            />
            <div className="workspace-card">
              <span className="workspace-icon">
                <Icon name={app.mode === 'local' ? 'device' : 'cloud'} size={26} />
              </span>
              <div>
                <strong>{app.mode === 'local' ? 'Local demo workspace' : 'Supabase cloud workspace'}</strong>
                <p>{info.reason}</p>
                <p className="muted-copy">
                  {app.mode === 'local'
                    ? 'Data is stored in this browser only. Clearing browser storage deletes it.'
                    : 'Data is stored in Supabase and protected by row-level security.'}
                </p>
              </div>
            </div>
            <div className="button-row">
              {app.mode === 'local' && info.supabaseConfigured && (
                <button type="button" className="button-secondary" onClick={switchToCloudWorkspace}>
                  <Icon name="cloud" size={16} /> Switch to cloud workspace
                </button>
              )}
              {app.mode === 'local' && (
                <button type="button" className="button-ghost" onClick={() => setResetOpen(true)}>
                  <Icon name="refresh" size={16} /> Reset demo data
                </button>
              )}
              {app.mode === 'supabase' && (
                <button type="button" className="button-ghost" onClick={switchToLocalWorkspace}>
                  <Icon name="device" size={16} /> Open local demo instead
                </button>
              )}
            </div>
            {workspaceError && <ErrorNote message={workspaceError} />}
          </section>
        </>
      )}

      <Modal
        open={blockOpen}
        onClose={() => {
          setBlockOpen(false)
          setBlockReason('')
          setCreditError('')
        }}
        title="Block credit sales"
        subtitle="Cash and UPI sales continue. Pending credit approvals can still be decided."
        footer={
          <>
            <button
              type="button"
              className="button-ghost"
              onClick={() => {
                setBlockOpen(false)
                setBlockReason('')
                setCreditError('')
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button-danger"
              onClick={() => saveCredit(true)}
              disabled={creditSaving}
            >
              {creditSaving ? 'Saving…' : 'Block credit sales'}
            </button>
          </>
        }
      >
        <div className="form-stack">
          <Field label="Reason" htmlFor="block-reason" hint="Salespeople see this when credit is blocked.">
            <textarea
              id="block-reason"
              rows="3"
              value={blockReason}
              onChange={event => setBlockReason(event.target.value)}
              placeholder="e.g. Collections review until Friday"
              required
            />
          </Field>
          {creditError && (
            <div className="inline-note note-danger" role="alert">
              <Icon name="alert" size={17} />
              <div>{creditError}</div>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset demo data?"
        subtitle="This deletes the local demo workspace and seeds the original sample data."
        footer={
          <>
            <button type="button" className="button-ghost" onClick={() => setResetOpen(false)}>
              Keep my data
            </button>
            <button
              type="button"
              className="button-danger"
              onClick={() => {
                setWorkspaceError('')
                resetLocalWorkspace()
              }}
            >
              Reset demo data
            </button>
          </>
        }
      >
        <InlineNote tone="danger">
          All local sales, shops, payments, returns, expenses and registered demo users will be
          removed. You will be signed out. Cloud data is not touched.
        </InlineNote>
      </Modal>

      <p className="page-foot">
        {app.profile?.role === 'owner' ? titleCase('owner') : titleCase(app.profile?.role || '')} ·{' '}
        Ethereal Co. Business Manager
      </p>
    </div>
  )
}
