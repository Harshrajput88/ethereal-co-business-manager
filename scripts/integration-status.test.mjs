import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getIntegrationStatus,
  recordProfileResult,
  recordRpcResult,
  setConnectionStatus
} from '../src/lib/integrationStatus.js'

test('business API failures remain distinct from transport connectivity and clear per endpoint on retry', () => {
  setConnectionStatus('connected')
  recordRpcResult('api_sales_list', 'Function missing from schema cache')
  assert.equal(getIntegrationStatus().connection, 'connected')
  assert.equal(getIntegrationStatus().businessApi, 'error')
  assert.deepEqual(getIntegrationStatus().failedRpcs, ['api_sales_list'])

  recordRpcResult('api_payments_list', 'Permission denied')
  recordRpcResult('api_sales_list')
  assert.equal(getIntegrationStatus().businessApi, 'error')
  assert.deepEqual(getIntegrationStatus().failedRpcs, ['api_payments_list'])

  recordRpcResult('api_payments_list')
  assert.equal(getIntegrationStatus().businessApi, 'ready')
  assert.equal(getIntegrationStatus().lastError, '')

  recordProfileResult('profiles.select', 'Profile policy denied')
  assert.equal(getIntegrationStatus().businessApi, 'error')
  recordProfileResult('profiles.select')
  assert.equal(getIntegrationStatus().businessApi, 'ready')
})
