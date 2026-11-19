import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferAuthEvent } from '../src/lib/authEvents.js'

test('auth event work is deferred until after the Supabase callback returns', () => {
  const scheduled = []
  const received = []
  const handler = deferAuthEvent(event => received.push(event), (callback, delay) => {
    scheduled.push({ callback, delay })
  })
  handler('SIGNED_IN')
  assert.deepEqual(received, [])
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].delay, 0)
  scheduled[0].callback()
  assert.deepEqual(received, ['SIGNED_IN'])
})

test('deferred auth handler preserves signed-out events', () => {
  let task
  const received = []
  deferAuthEvent(event => received.push(event), callback => { task = callback })(null)
  task()
  assert.deepEqual(received, [null])
})
