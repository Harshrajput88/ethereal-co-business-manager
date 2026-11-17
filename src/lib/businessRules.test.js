import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertStockAvailable,
  bottlesInCartons,
  calculateAvailableCartons,
  calculateSaleLine,
  validatePaymentAllocation,
  validateReturnQuantity
} from './businessRules.js'

test('carton conversions use the approved pack sizes', () => {
  assert.equal(bottlesInCartons('500ml', 2), 48)
  assert.equal(bottlesInCartons('1l', 3), 36)
  assert.throws(() => bottlesInCartons('500ml', 1.5), /whole number/)
})

test('sale lines use paise-safe arithmetic', () => {
  assert.deepEqual(calculateSaleLine({ cartons: 3, unitPrice: 135.50 }), {
    cartons: 3, unitPrice: 135.5, lineTotal: 406.5
  })
  assert.throws(() => calculateSaleLine({ cartons: 0, unitPrice: 135 }), /positive whole number/)
})

test('payment allocation requires verified payment, confirmed sale and same shop', () => {
  const payment = { status: 'verified', shopId: 'shop-a', amount: 500 }
  const sale = { status: 'confirmed', shopId: 'shop-a', outstandingAmount: 300 }
  assert.equal(validatePaymentAllocation({ payment, sale, amount: 200 }), true)
  assert.throws(() => validatePaymentAllocation({ payment: { ...payment, status: 'submitted' }, sale, amount: 100 }), /verified/)
  assert.throws(() => validatePaymentAllocation({ payment, sale: { ...sale, shopId: 'shop-b' }, amount: 100 }), /same shop/)
  assert.throws(() => validatePaymentAllocation({ payment, sale, amount: 350 }), /outstanding/)
  assert.throws(() => validatePaymentAllocation({ payment, sale, amount: 200, alreadyAllocated: 400 }), /payment amount/)
})

test('stock balance is derived from movements and cannot go negative', () => {
  assert.equal(calculateAvailableCartons([{ cartonsDelta: 20 }, { cartonsDelta: -4 }]), 16)
  assert.equal(assertStockAvailable(16, 6), 10)
  assert.throws(() => assertStockAvailable(3, 4), /Insufficient/)
})

test('approved returns cannot exceed cartons originally sold', () => {
  assert.equal(validateReturnQuantity({ soldCartons: 10, previouslyApprovedCartons: 3, requestedCartons: 7 }), true)
  assert.throws(() => validateReturnQuantity({ soldCartons: 10, previouslyApprovedCartons: 4, requestedCartons: 7 }), /cannot exceed/)
})
