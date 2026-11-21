import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditRpcContracts } from './rpc-contracts.mjs'

test('every frontend RPC has an exact migrated signature and authenticated-only execution', () => {
  const audit = auditRpcContracts()
  assert.equal(audit.migrationFiles.length, 9, 'expected nine ordered 20261118 release migrations including security revocation')
  assert.ok(audit.calls.length > 0, 'expected frontend RPC calls to be inventoried')
  assert.deepEqual(audit.errors, [])
  for (const name of ['api_credit_status', 'api_sales_list', 'api_payments_list', 'api_sales_page', 'api_payments_page', 'api_expenses_page', 'api_returns_page', 'api_inventory_movements_page']) {
    assert.ok(audit.calls.some(call => call.name === name), `${name} must be part of the contract audit`)
  }
})
