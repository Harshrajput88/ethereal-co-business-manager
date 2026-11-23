// Pure business rules shared by the UI and tests. No Supabase calls here.
export const BUSINESS_TIME_ZONE = 'Asia/Kolkata'

export const PRODUCT_VARIANTS = Object.freeze({
  '500ml': Object.freeze({ sku: 'ETH-500', packSizeMl: 500, bottlesPerCarton: 24 }),
  '1l': Object.freeze({ sku: 'ETH-1L', packSizeMl: 1000, bottlesPerCarton: 12 })
})

export function assertPositiveCartons(cartons) {
  if (!Number.isSafeInteger(cartons) || cartons <= 0) {
    throw new RangeError('Cartons must be a positive whole number.')
  }
  return cartons
}

export function bottlesInCartons(variantKey, cartons) {
  const variant = PRODUCT_VARIANTS[variantKey]
  if (!variant) throw new RangeError('Unknown product variant.')
  assertPositiveCartons(cartons)
  return variant.bottlesPerCarton * cartons
}

export function toPaise(amount) {
  const value = Number(amount)
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Amount must be a non-negative number.')
  }
  return Math.round((value + Number.EPSILON) * 100)
}

export function fromPaise(paise) {
  if (!Number.isSafeInteger(paise) || paise < 0) {
    throw new RangeError('Paise must be a non-negative integer.')
  }
  return paise / 100
}

export function calculateSaleLine({ cartons, unitPrice }) {
  assertPositiveCartons(cartons)
  const pricePaise = toPaise(unitPrice)
  return Object.freeze({
    cartons,
    unitPrice: fromPaise(pricePaise),
    lineTotal: fromPaise(pricePaise * cartons)
  })
}

export function validatePaymentAllocation({ payment, sale, amount, alreadyAllocated = 0 }) {
  const allocationPaise = toPaise(amount)
  const allocatedPaise = toPaise(alreadyAllocated)
  if (!payment || payment.status !== 'verified') {
    throw new Error('Only verified payments can be allocated.')
  }
  if (!sale || sale.status !== 'confirmed') {
    throw new Error('Payments can only be allocated to confirmed sales.')
  }
  if (payment.shopId !== sale.shopId) {
    throw new Error('Payment and sale must belong to the same shop.')
  }
  if (allocationPaise <= 0) {
    throw new RangeError('Allocation must be greater than zero.')
  }
  if (allocatedPaise + allocationPaise > toPaise(payment.amount)) {
    throw new RangeError('Allocation exceeds the verified payment amount.')
  }
  if (allocationPaise > toPaise(sale.outstandingAmount)) {
    throw new RangeError('Allocation exceeds the sale outstanding amount.')
  }
  return true
}

export function calculateAvailableCartons(movements) {
  if (!Array.isArray(movements)) throw new TypeError('Movements must be an array.')
  return movements.reduce((balance, movement) => {
    if (!Number.isSafeInteger(movement.cartonsDelta)) {
      throw new TypeError('Every stock movement must use whole cartons.')
    }
    return balance + movement.cartonsDelta
  }, 0)
}

export function assertStockAvailable(currentCartons, cartonsToDeduct) {
  assertPositiveCartons(cartonsToDeduct)
  if (!Number.isSafeInteger(currentCartons) || currentCartons < cartonsToDeduct) {
    throw new RangeError('Insufficient saleable stock.')
  }
  return currentCartons - cartonsToDeduct
}

export function validateReturnQuantity({ soldCartons, previouslyApprovedCartons = 0, requestedCartons }) {
  assertPositiveCartons(soldCartons)
  assertPositiveCartons(requestedCartons)
  if (!Number.isSafeInteger(previouslyApprovedCartons) || previouslyApprovedCartons < 0) {
    throw new RangeError('Previously approved cartons must be a non-negative whole number.')
  }
  if (previouslyApprovedCartons + requestedCartons > soldCartons) {
    throw new RangeError('Approved returns cannot exceed the original sold quantity.')
  }
  return true
}
