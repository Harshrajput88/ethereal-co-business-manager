let status = {
  connection: 'unknown',
  businessApi: 'not_checked',
  lastError: '',
  failedRpcs: []
}

const listeners = new Set()
const failures = new Map()
let businessApiSucceeded = false

function publish(next) {
  const unchanged =
    Object.entries(next).every(([key, value]) => {
      if (Array.isArray(value)) {
        return Array.isArray(status[key]) && value.length === status[key].length && value.every((item, index) => item === status[key][index])
      }
      return status[key] === value
    })
  if (unchanged) return
  status = { ...status, ...next }
  for (const listener of listeners) listener(status)
}

export function getIntegrationStatus() {
  return status
}

export function subscribeIntegrationStatus(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setConnectionStatus(connection) {
  publish({ connection })
}

export function recordRpcResult(name, error = null) {
  if (!error) businessApiSucceeded = true
  recordApiResult(name, error, true)
}

export function recordProfileResult(name, error = null) {
  recordApiResult(name, error, false)
}

function recordApiResult(name, error, isBusinessRpc) {
  if (error) {
    failures.set(name, error)
    publish({
      businessApi: 'error',
      lastError: error,
      failedRpcs: [...failures.keys()]
    })
    return
  }

  failures.delete(name)
  const lastError = [...failures.values()].at(-1) || ''
  publish({
    businessApi: failures.size
      ? 'error'
      : isBusinessRpc || businessApiSucceeded
        ? 'ready'
        : 'not_checked',
    lastError,
    failedRpcs: [...failures.keys()]
  })
}
