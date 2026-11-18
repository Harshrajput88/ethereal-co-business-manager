/* Business-workflow tests for the local demo backend.
 *
 * The demo backend is the offline/fallback implementation of the same api_*
 * RPC contract the Supabase backend exposes, so these tests exercise the real
 * pricing, stock, payment-allocation, return and expense rules in Node.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict'
import test from 'node:test'

// The app only touches localStorage in the browser; give Node a minimal one.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map()
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
    clear: () => store.clear(),
    key: index => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    }
  }
}

const { localBackend: api } = await import('../src/lib/localBackend.js')

const stockOf = (inventory, variantId, bucket = 'saleable') =>
  inventory.stock.find(row => row.variant_id === variantId)[bucket]

test('local demo backend: pricing, stock, payments, returns, expenses', async t => {
  let shopId
  let variantId
  let cashSale
  let creditSale
  let inventory

  await t.test('rejects bad credentials and signs in the salesperson', async () => {
    await assert.rejects(api.signIn('sales@ethereal.local', 'wrong'), /Invalid email or password/)
    const session = await api.signIn('sales@ethereal.local', 'sales123')
    assert.equal(session.user.email, 'sales@ethereal.local')
    assert.equal(session.profile.role, 'salesperson')
  })

  await t.test('loads the assigned shop and priced catalog', async () => {
    const shops = await api.getShops()
    const shop = shops.find(row => row.status === 'approved' && row.salespeople.length > 0)
    assert.ok(shop, 'seed data must include an approved shop with a salesperson')
    shopId = shop.id

    const catalog = await api.getCatalog()
    assert.equal(catalog.length, 2)
    assert.ok(catalog.every(row => row.default_price > 0))
    variantId = catalog[0].variant_id
  })

  await t.test('creates a cash sale, decrements stock, and queues the payment', async () => {
    inventory = await api.getInventory()
    const before = stockOf(inventory, variantId)
    assert.ok(before > 5, 'seed stock should leave room for test sales')

    cashSale = await api.createSale({
      shopId,
      paymentTerms: 'cash',
      lines: [{ variant_id: variantId, cartons: 2 }],
      clientReference: 'test-cash-sale'
    })
    assert.equal(cashSale.status, 'confirmed')
    assert.ok(cashSale.invoice_number, 'a confirmed sale issues an invoice')
    assert.equal(stockOf(await api.getInventory(), variantId), before - 2)

    const replay = await api.createSale({
      shopId,
      paymentTerms: 'cash',
      lines: [{ variant_id: variantId, cartons: 2 }],
      clientReference: 'test-cash-sale'
    })
    assert.equal(replay.sale_id, cashSale.sale_id, 'client references make createSale idempotent')
    assert.equal(stockOf(await api.getInventory(), variantId), before - 2)

    const payments = await api.getPayments()
    const pending = payments.filter(row => row.status === 'submitted' && row.method === 'cash')
    assert.ok(pending.length > 0, 'the sale auto-creates a submitted cash payment')

    const detail = await api.getSaleDetail(cashSale.sale_id)
    assert.equal(detail.paid, 0, 'unverified payments do not reduce the balance')
    assert.equal(detail.balance, cashSale.grand_total)
  })

  await t.test('blocks a salesperson from verifying a payment', async () => {
    const payments = await api.getPayments()
    const payment = payments.find(row => row.status === 'submitted' && row.amount === cashSale.grand_total)
    assert.ok(payment)
    await assert.rejects(
      api.verifyPayment({ paymentId: payment.id, decision: 'approve' }),
      /permission|owner|admin/i
    )
  })

  await t.test('credit sales wait for approval before touching stock', async () => {
    const before = stockOf(await api.getInventory(), variantId)
    creditSale = await api.createSale({
      shopId,
      paymentTerms: 'credit',
      lines: [{ variant_id: variantId, cartons: 1 }]
    })
    assert.equal(creditSale.status, 'pending_credit_approval')
    assert.equal(creditSale.invoice_number, null)
    assert.equal(stockOf(await api.getInventory(), variantId), before)

    await api.signIn('owner@ethereal.local', 'owner123')
    const rejected = await api.reviewCreditSale({
      saleId: creditSale.sale_id,
      decision: 'reject',
      reason: 'Over the shop credit limit'
    })
    assert.equal(rejected.status, 'rejected')
    assert.equal(stockOf(await api.getInventory(), variantId), before)
  })

  await t.test('owner verifies the cash payment and the balance settles', async () => {
    const payments = await api.getPayments()
    const payment = payments.find(
      row => row.status === 'submitted' && row.amount === cashSale.grand_total && row.method === 'cash'
    )
    assert.ok(payment)

    await api.verifyPayment({ paymentId: payment.id, decision: 'approve' })
    const detail = await api.getSaleDetail(cashSale.sale_id)
    assert.equal(detail.paid, cashSale.grand_total)
    assert.equal(detail.balance, 0)

    const verified = (await api.getPayments()).find(row => row.id === payment.id)
    assert.equal(verified.status, 'verified')
    assert.ok(verified.receipt_number, 'verification issues a receipt')
  })

  await t.test('a fresh credit sale is approved, decrements stock and carries a balance', async () => {
    await api.signIn('sales@ethereal.local', 'sales123')
    const before = stockOf(await api.getInventory(), variantId)
    const created = await api.createSale({
      shopId,
      paymentTerms: 'credit',
      lines: [{ variant_id: variantId, cartons: 3 }]
    })
    assert.equal(created.status, 'pending_credit_approval')

    await api.signIn('admin@ethereal.local', 'admin123')
    const approved = await api.reviewCreditSale({ saleId: created.sale_id, decision: 'approve' })
    assert.equal(approved.status, 'confirmed')
    assert.ok(approved.invoice_number)
    assert.equal(stockOf(await api.getInventory(), variantId), before - 3)

    const detail = await api.getSaleDetail(created.sale_id)
    assert.equal(detail.balance, created.grand_total)

    creditSale = created
  })

  await t.test('partial payments allocate only to the chosen sale', async () => {
    const detail = await api.getSaleDetail(creditSale.sale_id)
    const partial = Math.round(detail.balance / 2)
    const recorded = await api.recordPayment({
      shopId,
      method: 'upi',
      amount: partial,
      allocations: [{ sale_id: creditSale.sale_id, amount: partial }],
      clientReference: 'test-partial-payment'
    })
    assert.equal(recorded.status, 'submitted')

    // Unverified payments must not change the balance.
    assert.equal((await api.getSaleDetail(creditSale.sale_id)).balance, detail.balance)

    await api.verifyPayment({ paymentId: recorded.payment_id, decision: 'approve' })
    const settled = await api.getSaleDetail(creditSale.sale_id)
    assert.equal(settled.balance, detail.balance - partial)
    assert.equal(settled.paid, partial)
  })

  await t.test('approved returns restore reusable stock and add damaged stock', async () => {
    const sale = await api.getSaleDetail(creditSale.sale_id)
    const line = sale.lines[0]
    const before = await api.getInventory()

    const request = await api.submitReturn({
      saleId: creditSale.sale_id,
      reason: 'Damaged during delivery',
      lines: [
        { sale_line_id: line.id, cartons: 1, condition: 'damaged' },
        { sale_line_id: line.id, cartons: 1, condition: 'reusable' }
      ]
    })
    assert.equal(request.status, 'submitted')
    assert.equal(
      stockOf(await api.getInventory(), line.variant_id),
      stockOf(before, line.variant_id),
      'stock moves only after approval'
    )

    await api.signIn('sales@ethereal.local', 'sales123')
    await assert.rejects(
      api.reviewReturn({ returnId: request.return_id, decision: 'approve' }),
      /permission|owner|admin/i
    )

    await api.signIn('owner@ethereal.local', 'owner123')
    const approved = await api.reviewReturn({ returnId: request.return_id, decision: 'approve' })
    assert.equal(approved.status, 'approved')
    assert.ok(approved.credit > 0)

    const after = await api.getInventory()
    assert.equal(stockOf(after, line.variant_id, 'saleable'), stockOf(before, line.variant_id, 'saleable') + 1)
    assert.equal(stockOf(after, line.variant_id, 'damaged'), stockOf(before, line.variant_id, 'damaged') + 1)
  })

  await t.test('expenses follow submit, review and paid transitions', async () => {
    await api.signIn('sales@ethereal.local', 'sales123')
    const expense = await api.submitExpense({
      expenseDate: '2026-11-17',
      category: 'transport',
      description: 'Delivery fuel',
      amount: 250
    })
    assert.equal(expense.status, 'submitted')
    await assert.rejects(
      api.reviewExpense({ expenseId: expense.id, decision: 'approve' }),
      /permission|owner|admin/i
    )

    await api.signIn('admin@ethereal.local', 'admin123')
    const approved = await api.reviewExpense({ expenseId: expense.id, decision: 'approve' })
    assert.equal(approved.status, 'approved')
    const paid = await api.markExpensePaid(expense.id)
    assert.equal(paid.status, 'paid')

    const expenses = await api.getExpenses()
    assert.equal(expenses.find(row => row.id === expense.id).status, 'paid')
  })

  await t.test('guards stock, permissions and the last owner', async () => {
    await api.signIn('sales@ethereal.local', 'sales123')
    await assert.rejects(
      api.createSale({ shopId, paymentTerms: 'cash', lines: [{ variant_id: variantId, cartons: 99999 }] }),
      /Insufficient stock/
    )
    await assert.rejects(
      api.receiveStock({ variantId, cartons: 5, reason: 'Supplier delivery' }),
      /permission|owner|admin/i
    )

    await api.signIn('owner@ethereal.local', 'owner123')
    await assert.rejects(
      api.adjustStock({ variantId, bucket: 'saleable', delta: -99999, reason: 'Count correction' }),
      /negative/
    )

    const team = await api.getTeam()
    const owner = team.find(person => person.role === 'owner' && person.status === 'approved')
    assert.ok(owner)
    await assert.rejects(api.setEmployeeRole(owner.id, 'admin'), /last owner/i)
  })

  await t.test('dashboard and product report reflect the new activity', async () => {
    const dashboard = await api.getDashboard()
    assert.equal(typeof dashboard.business_date, 'string')
    assert.ok(dashboard.stock.length >= 2)
    assert.ok(dashboard.month_sales > 0)
    assert.ok(dashboard.recent_sales.length > 0)

    const report = await api.getProductReport({})
    assert.ok(report.length >= 1)
    assert.ok(report.every(row => row.revenue > 0 && row.cartons > 0))
  })
})
