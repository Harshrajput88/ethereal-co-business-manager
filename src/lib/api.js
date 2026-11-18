import { checkSupabaseHealth, isSupabaseConfigured } from './supabase.js'
import { localBackend } from './localBackend.js'
import { remoteBackend } from './remoteBackend.js'
import { getIntegrationStatus, setConnectionStatus } from './integrationStatus.js'
import { chooseBackendMode } from './backendMode.js'

const PREFER_LOCAL_KEY = 'ethereal.preferLocal'

let active = null
let pending = null
let info = {
  mode: 'starting',
  reason: 'Starting the workspace…',
  supabaseConfigured: isSupabaseConfigured,
  ...getIntegrationStatus()
}

function requestedDemo() {
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('demo') === '1') {
      return 'Demo mode was requested in the link.'
    }
  } catch {
    // window is always available in the browser; ignore odd embeddings
  }
  if (import.meta.env.VITE_LOCAL_MODE === 'true') {
    return 'Local demo mode is enabled by configuration.'
  }
  if (localStorage.getItem(PREFER_LOCAL_KEY) === '1') {
    return 'Local demo mode is selected on this device.'
  }
  return null
}

export async function initializeApi() {
  if (active) return info
  if (pending) return pending

  pending = (async () => {
    const demoReason = requestedDemo()
    const mode = chooseBackendMode({
      demoRequested: Boolean(demoReason),
      configured: isSupabaseConfigured
    })

    if (mode === 'supabase') {
      const healthy = await checkSupabaseHealth()
      setConnectionStatus(healthy ? 'connected' : 'disconnected')
      active = remoteBackend
      info = {
        mode: 'supabase',
        reason: healthy
          ? 'Supabase Auth endpoint responded; business API readiness is checked separately.'
          : 'Supabase Auth endpoint did not respond. Cloud mode is retained; retry instead of switching to demo data.',
        supabaseConfigured: true,
        ...getIntegrationStatus()
      }
      return info
    }

    if (mode === 'local') {
      active = localBackend
      info = {
        mode: 'local',
        reason: demoReason,
        supabaseConfigured: isSupabaseConfigured
      }
    } else {
      active = remoteBackend
      info = {
        mode: 'unconfigured',
        reason: 'Supabase is not configured. Set the public Vite URL and anon/publishable key; demo data was not selected.',
        supabaseConfigured: false,
        ...getIntegrationStatus()
      }
    }

    if (info.mode === 'local') await localBackend.getSession()
    return info
  })()

  return pending
}

export function backendInfo() {
  return { ...info, ...getIntegrationStatus() }
}

export function isLocalMode() {
  return info.mode === 'local'
}

export function switchToLocalWorkspace() {
  localStorage.setItem(PREFER_LOCAL_KEY, '1')
  window.location.assign('/')
}

export function switchToCloudWorkspace() {
  localStorage.removeItem(PREFER_LOCAL_KEY)
  window.location.assign('/')
}

export function resetLocalWorkspace() {
  localStorage.removeItem('ethereal.local.v1')
  localStorage.removeItem('ethereal.local.session')
  window.location.assign('/')
}

export const api = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === 'mode') return info.mode
      if (property === 'isLocal') return info.mode === 'local'
      if (!active) {
        return () => {
          throw new Error('The workspace is still starting. Try again in a moment.')
        }
      }
      const value = active[property]
      if (typeof value !== 'function') return value
      return (...args) => value.apply(active, args)
    }
  }
)
