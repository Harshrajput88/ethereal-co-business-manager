const MAX_LIMIT = 2147483647

/**
 * SQL list RPCs expose a limit but no offset. Grow the limit until the server
 * proves the result is complete. This avoids silently calculating financial
 * reports from a truncated prefix while preserving existing list contracts.
 */
export async function fetchCompleteList(fetchWithLimit, initialLimit = 1000, arrayKey = null) {
  if (!Number.isSafeInteger(initialLimit) || initialLimit < 1 || initialLimit > MAX_LIMIT) {
    throw new RangeError('initialLimit must be a positive PostgreSQL integer')
  }

  let limit = initialLimit
  while (true) {
    const rows = await fetchWithLimit(limit)
    const list = arrayKey ? rows?.[arrayKey] : rows
    if (!Array.isArray(list)) {
      throw new TypeError(arrayKey
        ? `Expected the business API response to contain an array at ${arrayKey}`
        : 'Expected the business list API to return an array')
    }
    if (list.length < limit) return rows
    if (limit === MAX_LIMIT) {
      throw new Error('The result reached PostgreSQL’s maximum list limit; refusing to produce an incomplete report.')
    }
    limit = Math.min(limit * 2, MAX_LIMIT)
  }
}
