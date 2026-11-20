import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchCompleteList } from '../src/lib/fetchCompleteList.js'

test('fetches every record when a report contains more than 1,000 rows', async () => {
  const rows = Array.from({ length: 2501 }, (_, id) => ({ id }))
  const requested = []
  const result = await fetchCompleteList(async limit => {
    requested.push(limit)
    return rows.slice(0, limit)
  })

  assert.equal(result.length, 2501)
  assert.deepEqual(result, rows)
  assert.deepEqual(requested, [1000, 2000, 4000])
})

test('retries exact-limit results because the result may be truncated', async () => {
  const requested = []
  const result = await fetchCompleteList(async limit => {
    requested.push(limit)
    return Array.from({ length: Math.min(limit, 2000) }, (_, id) => id)
  }, 1000)

  assert.equal(result.length, 2000)
  assert.deepEqual(requested, [1000, 2000, 4000])
})

test('returns an empty or short result without an unnecessary second request', async () => {
  let calls = 0
  const result = await fetchCompleteList(async () => {
    calls += 1
    return [1, 2, 3]
  })
  assert.deepEqual(result, [1, 2, 3])
  assert.equal(calls, 1)
})

test('rejects invalid limits and malformed API responses', async () => {
  await assert.rejects(() => fetchCompleteList(async () => [], 0), RangeError)
  await assert.rejects(() => fetchCompleteList(async () => null), TypeError)
})
