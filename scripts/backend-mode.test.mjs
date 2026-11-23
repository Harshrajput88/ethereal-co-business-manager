import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseBackendMode } from '../src/lib/backendMode.js'

test('demo is selected only by explicit request; cloud outages do not switch to demo', () => {
  assert.equal(chooseBackendMode({ demoRequested: true, configured: true }), 'local')
  assert.equal(chooseBackendMode({ demoRequested: false, configured: true }), 'supabase')
  assert.equal(chooseBackendMode({ demoRequested: false, configured: false }), 'unconfigured')
})
