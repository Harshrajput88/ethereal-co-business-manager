import { createSeedState, hashPassword } from './localSeed.js'
import { businessDate, monthStart } from './format.js'
import { aggregateReport, round2 } from './business.js'
import { fetchCompleteList } from './fetchCompleteList.js'

const STORAGE_KEY = 'ethereal.local.v1'
const SESSION_KEY = 'ethereal.local.session'

let cache = null
const listeners = new Set()

function persist() {
  if (!cache) return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
}

async function ensure() {
  if (cache) return cache
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      cache = JSON.parse(raw)
      return cache
    } catch {
      cache = null
    }
  }
  cache = await createSeedState()
  persist()
  return cache
}

function emit() {
  listeners.forEach(listener => {
    try {
      listener()
    } catch {
      // listener errors must not break the store
    }
  })
}

function publicUser(user) {
  if (!user) return null
  return {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    role: user.role,
    status: user.status,
    avatar_url: user.avatar_url,
    created_at: user.created_at,
    approved_at: user.approved_at
  }
}

function sessionUserId() {
  return localStorage.getItem(SESSION_KEY)
}

function findUser(state) {
  const id = sessionUserId()
  return id ? state.users.find(user => user.id === id) : null
}

function current() {
  const state = cache
  const user = state ? findUser(state) : null
  if (!state || !user) {
    const error = new Error('Please sign in again')
    error.code = 'AUTH'
    throw error
  }
  return { state, user }
}

function requireApproved() {
  const { state, user } = current()
  if (user.status !== 'approved') {
    throw new Error('Your account is not approved')
  }
  return { state, user }
}

function requireRoles(...roles) {
  const context = requireApproved()
  if (!roles.includes(context.user.role)) {
    throw new Error('You do not have permission for this action')
  }
  return context
}

function isAdmin(user) {
  return user.role === 'owner' || user.role === 'admin'
}

function isAssigned(state, shopId, userId) {
  return state.shopSalespeople.some(
    row => row.shop_id === shopId && row.salesperson_id === userId
  )
}

function isShopVisible(state, shop, user) {
  return (
    isAdmin(user) ||
    isAssigned(state, shop.id, user.id) ||
    shop.submitted_by === user.id
  )
}

function variantInfo(state, variantId) {
  const variant = state.variants.find(item => item.id === variantId)
  if (!variant) return null
  const product = state.products.find(item => item.id === variant.product_id)
  return {
    variant,
    product,
    label: `${product?.name || variant.sku} · ${variant.bottles_per_carton} bottles/carton`
  }
}

function defaultPrice(state, variantId) {
  const price = [...state.defaultPrices]
    .filter(item => item.variant_id === variantId && !item.valid_to)
    .sort((a, b) => String(b.valid_from).localeCompare(String(a.valid_from)))[0]
  return price ? Number(price.amount) : null
}

function effectiveShopPrice(state, shopId, variantId) {
  const override = state.shopPrices
    .filter(
      item =>
        item.shop_id === shopId &&
        item.variant_id === variantId &&
        !item.valid_to
    )
    .sort((a, b) => String(b.valid_from).localeCompare(String(a.valid_from)))[0]

  if (override) {
    return { amount: Number(override.amount), source: 'shop' }
  }
  const fallback = defaultPrice(state, variantId)
  return fallback === null ? null : { amount: fallback, source: 'default' }
}

function stockQty(state, variantId, bucket = 'saleable') {
  return state.movements
    .filter(move => move.variant_id === variantId && move.stock_bucket === bucket)
    .reduce((total, move) => total + Number(move.cartons_delta), 0)
}

function makeCatalog(state) {
  return state.variants
    .filter(variant => variant.active)
    .map(variant => {
      const info = variantInfo(state, variant.id)
      return {
        variant_id: variant.id,
        product_id: variant.product_id,
        product_name: info.product.name,
        sku: variant.sku,
        pack_size_ml: variant.pack_size_ml,
        bottles_per_carton: variant.bottles_per_carton,
        label: info.label,
        active: info.product.active,
        default_price: defaultPrice(state, variant.id),
        stock_saleable: stockQty(state, variant.id, 'saleable'),
        stock_damaged: stockQty(state, variant.id, 'damaged')
      }
    })
    .sort((a, b) => a.pack_size_ml - b.pack_size_ml)
}

function saleAllocated(state, saleId) {
  const verified = new Set(
    state.payments.filter(payment => payment.status === 'verified').map(payment => payment.id)
  )
  return state.allocations
    .filter(row => row.sale_id === saleId && verified.has(row.payment_id))
    .reduce((total, row) => total + Number(row.amount), 0)
}

function saleReturnCredit(state, saleId) {
  return state.ledger
    .filter(entry => entry.sale_id === saleId && entry.entry_type === 'return_credit')
    .reduce((total, entry) => total + Number(entry.amount), 0)
}

function saleBalance(state, saleId) {
  const sale = state.sales.find(item => item.id === saleId)
  if (!sale) return 0
  return Math.max(
    0,
    round2(Number(sale.grand_total) - saleAllocated(state, saleId) - saleReturnCredit(state, saleId))
  )
}

function audit(state, user, action, entityType, entityId, metadata = {}) {
  state.audit.unshift({
    id: crypto.randomUUID(),
    actor_id: user?.id || null,
    action,
    entity_type: entityType,
    entity_id: entityId,
    occurred_at: new Date().toISOString(),
    metadata
  })
}

function nextInvoiceNumber(state) {
  state.meta.invoiceSeq += 1
  const stamp = businessDate().replace(/-/g, '').slice(0, 6)
  return `ETC-INV-${stamp}-${String(state.meta.invoiceSeq).padStart(6, '0')}`
}

function nextReceiptNumber(state) {
  state.meta.receiptSeq += 1
  const stamp = businessDate().replace(/-/g, '').slice(0, 6)
  return `ETC-RCPT-${stamp}-${String(state.meta.receiptSeq).padStart(6, '0')}`
}

function sellerSnapshot(state) {
  const s = state.settings
  return {
    name: s.business_name,
    tagline: s.tagline,
    address: s.address,
    phone: s.phone,
    email: s.email,
    gstin: s.gstin
  }
}

function buyerSnapshot(shop) {
  return {
    name: shop?.name || '',
    phone: shop?.phone || '',
    email: shop?.email || '',
    address_line1: shop?.address_line1 || '',
    address_line2: shop?.address_line2 || '',
    locality: shop?.locality || '',
    city: shop?.city || '',
    state: shop?.state || '',
    postal_code: shop?.postal_code || ''
  }
}

function issueInvoice(state, sale) {
  const existing = state.invoices.find(invoice => invoice.sale_id === sale.id)
  if (existing) return existing

  const shop = state.shops.find(item => item.id === sale.shop_id)
  const lines = state.saleLines
    .filter(line => line.sale_id === sale.id)
    .map(line => ({
      product_name: line.product_name_snapshot,
      sku: line.sku_snapshot,
      cartons: line.cartons,
      unit_price: Number(line.unit_price_snapshot),
      bottles_per_carton: line.bottles_per_carton_snapshot,
      line_total: Number(line.line_total_snapshot)
    }))

  const invoice = {
    id: crypto.randomUUID(),
    sale_id: sale.id,
    invoice_number: nextInvoiceNumber(state),
    issued_at: new Date().toISOString(),
    issued_by: sale.confirmed_by || sale.salesperson_id,
    seller: sellerSnapshot(state),
    buyer: buyerSnapshot(shop),
    currency: 'INR',
    tax_mode: 'non_gst',
    subtotal: Number(sale.subtotal),
    grand_total: Number(sale.grand_total),
    lines
  }
  state.invoices.push(invoice)
  return invoice
}

function postLedger(state, entry) {
  const row = {
    id: crypto.randomUUID(),
    sale_id: null,
    payment_allocation_id: null,
    return_request_id: null,
    created_at: new Date().toISOString(),
    ...entry
  }
  state.ledger.push(row)
  return row
}

function addMovement(state, user, variantId, bucket, type, delta, sourceType, sourceId, reason) {
  state.movements.push({
    id: crypto.randomUUID(),
    variant_id: variantId,
    stock_bucket: bucket,
    movement_type: type,
    cartons_delta: delta,
    source_type: sourceType,
    source_id: sourceId,
    occurred_at: new Date().toISOString(),
    actor_id: user.id,
    reason
  })
}

function saleView(state, sale) {
  const shop = state.shops.find(item => item.id === sale.shop_id)
  const person = state.users.find(item => item.id === sale.salesperson_id)
  const invoice = state.invoices.find(item => item.sale_id === sale.id)
  return {
    id: sale.id,
    sale_number: sale.sale_number,
    business_date: sale.business_date,
    status: sale.status,
    payment_terms: sale.payment_terms,
    shop_id: sale.shop_id,
    shop_name: shop?.name || 'Unknown shop',
    salesperson_id: sale.salesperson_id,
    salesperson_name: person?.full_name || 'Unknown',
    subtotal: Number(sale.subtotal),
    grand_total: Number(sale.grand_total),
    paid: round2(saleAllocated(state, sale.id)),
    returned: round2(saleReturnCredit(state, sale.id)),
    balance: saleBalance(state, sale.id),
    invoice_number: invoice?.invoice_number || null,
    created_at: sale.created_at,
    rejection_reason: sale.rejection_reason
  }
}

function canSeeSale(state, sale, user) {
  return (
    isAdmin(user) ||
    sale.salesperson_id === user.id ||
    isAssigned(state, sale.shop_id, user.id)
  )
}

function paymentView(state, payment) {
  const shop = state.shops.find(item => item.id === payment.shop_id)
  const person = state.users.find(item => item.id === payment.recorded_by)
  const receipt = state.receipts.find(item => item.payment_id === payment.id)
  return {
    id: payment.id,
    shop_id: payment.shop_id,
    shop_name: shop?.name || 'Unknown shop',
    recorded_by: payment.recorded_by,
    recorded_by_name: person?.full_name || 'Unknown',
    method: payment.method,
    amount: Number(payment.amount),
    received_at: payment.received_at,
    external_reference: payment.external_reference,
    status: payment.status,
    verified_at: payment.verified_at,
    rejection_reason: payment.rejection_reason,
    receipt_number: receipt?.receipt_number || null,
    allocations: state.allocations
      .filter(row => row.payment_id === payment.id)
      .map(row => {
        const sale = state.sales.find(item => item.id === row.sale_id)
        return {
          sale_id: row.sale_id,
          sale_number: sale?.sale_number,
          amount: Number(row.amount)
        }
      })
  }
}

async function getSession() {
  const state = await ensure()
  const user = findUser(state)
  if (!user) return null
  return {
    user: { id: user.id, email: user.email },
    profile: publicUser(user)
  }
}

function onAuthChange(callback) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

async function signIn(email, password) {
  const state = await ensure()
  const normalized = String(email || '').trim().toLowerCase()
  const user = state.users.find(item => item.email.toLowerCase() === normalized)
  if (!user) throw new Error('Invalid email or password')
  const hash = await hashPassword(password)
  if (hash !== user.passwordHash) throw new Error('Invalid email or password')
  localStorage.setItem(SESSION_KEY, user.id)
  emit()
  return { user: { id: user.id, email: user.email }, profile: publicUser(user) }
}

async function signUp(fullName, email, password) {
  const state = await ensure()
  const normalized = String(email || '').trim().toLowerCase()
  if (!fullName.trim()) throw new Error('Enter your full name')
  if (password.length < 8) throw new Error('Password must be at least 8 characters')
  if (state.users.some(item => item.email.toLowerCase() === normalized)) {
    throw new Error('An account with this email already exists')
  }

  const user = {
    id: crypto.randomUUID(),
    email: normalized,
    passwordHash: await hashPassword(password),
    full_name: fullName.trim(),
    role: 'salesperson',
    status: 'pending',
    avatar_url: null,
    approved_at: null,
    created_at: new Date().toISOString()
  }
  state.users.push(user)
  persist()
  localStorage.setItem(SESSION_KEY, user.id)
  emit()
  return { user: { id: user.id, email: user.email }, profile: publicUser(user) }
}

async function signOut() {
  localStorage.removeItem(SESSION_KEY)
  emit()
}

async function getProfile() {
  const state = await ensure()
  const user = findUser(state)
  return publicUser(user)
}

async function updateMyName(fullName) {
  const { user } = requireApproved()
  if (!fullName.trim()) throw new Error('Enter a valid name')
  user.full_name = fullName.trim()
  persist()
  return publicUser(user)
}

async function updateMyAvatar(dataUrl) {
  const { user } = requireApproved()
  user.avatar_url = dataUrl
  persist()
  return publicUser(user)
}

async function needsFirstOwner() {
  const state = await ensure()
  return !state.users.some(user => user.role === 'owner')
}

async function claimOwner() {
  const state = await ensure()
  const user = findUser(state)
  if (!user) throw new Error('Sign in first')
  if (state.users.some(item => item.role === 'owner')) {
    throw new Error('An owner account already exists')
  }
  user.role = 'owner'
  user.status = 'approved'
  user.approved_at = new Date().toISOString()
  audit(state, user, 'owner.claimed', 'profile', user.id)
  persist()
  emit()
  return publicUser(user)
}

async function getBusinessSettings() {
  const state = await ensure()
  requireApproved()
  return { ...state.settings }
}

async function updateBusinessSettings(settings) {
  const { state } = requireRoles('owner')
  state.settings = {
    ...state.settings,
    ...settings,
    business_name: String(settings.business_name || '').trim()
  }
  if (!state.settings.business_name) throw new Error('Business name is required')
  audit(state, findUser(state), 'settings.updated', 'business_settings', null)
  persist()
  return { ...state.settings }
}

async function getCreditStatus() {
  const state = await ensure()
  requireApproved()
  return { ...state.credit }
}

async function setCreditBlock(blocked, reason) {
  const { state } = requireRoles('owner')
  if (blocked && !String(reason || '').trim()) {
    throw new Error('A reason is required to block credit sales')
  }
  state.credit = {
    blocked: Boolean(blocked),
    reason: String(reason || '').trim(),
    changed_at: new Date().toISOString()
  }
  audit(state, findUser(state), blocked ? 'credit.blocked' : 'credit.unblocked', 'credit_controls', null, { reason })
  persist()
  return { ...state.credit }
}

async function getCatalog() {
  const state = await ensure()
  requireApproved()
  return makeCatalog(state)
}

async function getShopPrices(shopId = null) {
  const state = await ensure()
  const { user } = requireApproved()
  return state.shopPrices
    .filter(price => !price.valid_to)
    .filter(price => !shopId || price.shop_id === shopId)
    .filter(price => isAdmin(user) || isAssigned(state, price.shop_id, user.id))
    .map(price => {
      const shop = state.shops.find(item => item.id === price.shop_id)
      const info = variantInfo(state, price.variant_id)
      return {
        id: price.id,
        shop_id: price.shop_id,
        shop_name: shop?.name || '',
        variant_id: price.variant_id,
        product_name: info?.product.name || '',
        sku: info?.variant.sku || '',
        bottles_per_carton: info?.variant.bottles_per_carton || 0,
        amount: Number(price.amount),
        default_amount: defaultPrice(state, price.variant_id),
        valid_from: price.valid_from
      }
    })
}

async function setDefaultPrice(variantId, amount) {
  const { state, user } = requireRoles('owner', 'admin')
  if (Number(amount) <= 0) throw new Error('Price must be greater than zero')
  if (!state.variants.some(variant => variant.id === variantId)) {
    throw new Error('Product variant not found')
  }
  state.defaultPrices.forEach(price => {
    if (price.variant_id === variantId && !price.valid_to) price.valid_to = new Date().toISOString()
  })
  state.defaultPrices.push({
    id: crypto.randomUUID(),
    variant_id: variantId,
    amount: round2(amount),
    valid_from: new Date().toISOString(),
    valid_to: null,
    set_by: user.id
  })
  audit(state, user, 'price.default_set', 'product_variant', variantId, { amount: round2(amount) })
  persist()
  return { variant_id: variantId, amount: round2(amount) }
}

async function setShopPrice(shopId, variantId, amount) {
  const { state, user } = requireRoles('owner', 'admin')
  if (Number(amount) <= 0) throw new Error('Price must be greater than zero')
  const shop = state.shops.find(item => item.id === shopId)
  if (!shop || shop.status !== 'approved') throw new Error('Shop must be approved')
  state.shopPrices.forEach(price => {
    if (price.shop_id === shopId && price.variant_id === variantId && !price.valid_to) {
      price.valid_to = new Date().toISOString()
    }
  })
  state.shopPrices.push({
    id: crypto.randomUUID(),
    shop_id: shopId,
    variant_id: variantId,
    amount: round2(amount),
    valid_from: new Date().toISOString(),
    valid_to: null,
    set_by: user.id
  })
  audit(state, user, 'price.shop_set', 'shop', shopId, { variant_id: variantId, amount: round2(amount) })
  persist()
  return { shop_id: shopId, variant_id: variantId, amount: round2(amount) }
}

async function clearShopPrice(shopId, variantId) {
  const { state, user } = requireRoles('owner', 'admin')
  state.shopPrices.forEach(price => {
    if (price.shop_id === shopId && price.variant_id === variantId && !price.valid_to) {
      price.valid_to = new Date().toISOString()
    }
  })
  audit(state, user, 'price.shop_cleared', 'shop', shopId, { variant_id: variantId })
  persist()
}

async function getShops() {
  const state = await ensure()
  const { user } = requireApproved()
  return state.shops
    .filter(shop => isShopVisible(state, shop, user))
    .map(shop => ({
      ...shop,
      submitted_by_name: state.users.find(person => person.id === shop.submitted_by)?.full_name || '',
      salespeople: state.shopSalespeople
        .filter(row => row.shop_id === shop.id)
        .map(row => ({
          id: row.salesperson_id,
          name: state.users.find(person => person.id === row.salesperson_id)?.full_name || '',
          is_primary: row.is_primary
        }))
        .sort((a, b) => Number(b.is_primary) - Number(a.is_primary)),
      outstanding: round2(
        state.sales
          .filter(sale => sale.shop_id === shop.id && sale.status === 'confirmed')
          .reduce((total, sale) => total + saleBalance(state, sale.id), 0)
      )
    }))
    .sort((a, b) => {
      const rank = { pending: 0, approved: 1 }
      return (rank[a.status] ?? 2) - (rank[b.status] ?? 2) || a.name.localeCompare(b.name)
    })
}

async function submitShop(input) {
  const { state, user } = requireApproved()
  if (!String(input.name || '').trim()) throw new Error('Shop name is required')
  const shop = {
    id: crypto.randomUUID(),
    name: String(input.name).trim(),
    phone: input.phone || null,
    email: input.email || null,
    address_line1: input.address_line1 || null,
    address_line2: input.address_line2 || null,
    locality: input.locality || null,
    city: input.city || null,
    state: input.state || null,
    postal_code: input.postal_code || null,
    notes: input.notes || null,
    status: 'pending',
    submitted_by: user.id,
    reviewed_by: null,
    reviewed_at: null,
    rejection_reason: null,
    created_at: new Date().toISOString()
  }
  state.shops.push(shop)
  audit(state, user, 'shop.submitted', 'shop', shop.id, { name: shop.name })
  persist()
  return { id: shop.id, status: 'pending' }
}

async function reviewShop({ shopId, decision, reason, primaryId, additionalIds = [] }) {
  const { state, user } = requireRoles('owner', 'admin')
  const shop = state.shops.find(item => item.id === shopId)
  if (!shop) throw new Error('Shop not found')
  if (!['approved', 'rejected', 'inactive'].includes(decision)) throw new Error('Invalid decision')
  if (decision === 'rejected' && !String(reason || '').trim()) {
    throw new Error('A rejection reason is required')
  }
  if (decision === 'approved') {
    if (!primaryId) throw new Error('Choose a primary salesperson before approving a shop')
    const primary = state.users.find(person => person.id === primaryId && person.status === 'approved')
    if (!primary) throw new Error('Primary salesperson must be an approved employee')
    state.shopSalespeople = state.shopSalespeople.filter(row => row.shop_id !== shopId)
    state.shopSalespeople.push({
      shop_id: shopId,
      salesperson_id: primaryId,
      is_primary: true,
      assigned_by: user.id,
      assigned_at: new Date().toISOString()
    })
    additionalIds
      .filter(id => id !== primaryId)
      .forEach(id => {
        state.shopSalespeople.push({
          shop_id: shopId,
          salesperson_id: id,
          is_primary: false,
          assigned_by: user.id,
          assigned_at: new Date().toISOString()
        })
      })
  }
  shop.status = decision
  shop.reviewed_by = user.id
  shop.reviewed_at = new Date().toISOString()
  shop.rejection_reason = decision === 'rejected' ? String(reason).trim() : null
  audit(state, user, `shop.${decision}`, 'shop', shopId, { reason })
  persist()
  return { id: shopId, status: decision }
}

async function assignShopSalespeople({ shopId, primaryId, additionalIds = [] }) {
  const { state, user } = requireRoles('owner', 'admin')
  const shop = state.shops.find(item => item.id === shopId && item.status === 'approved')
  if (!shop) throw new Error('Approve the shop before assigning salespeople')
  if (!state.users.some(person => person.id === primaryId && person.status === 'approved')) {
    throw new Error('Primary salesperson must be an approved employee')
  }
  state.shopSalespeople = state.shopSalespeople.filter(row => row.shop_id !== shopId)
  state.shopSalespeople.push({
    shop_id: shopId,
    salesperson_id: primaryId,
    is_primary: true,
    assigned_by: user.id,
    assigned_at: new Date().toISOString()
  })
  additionalIds
    .filter(id => id !== primaryId)
    .forEach(id => {
      state.shopSalespeople.push({
        shop_id: shopId,
        salesperson_id: id,
        is_primary: false,
        assigned_by: user.id,
        assigned_at: new Date().toISOString()
      })
    })
  audit(state, user, 'shop.assignments_updated', 'shop', shopId)
  persist()
  return { id: shopId }
}

async function addShopVisit(shopId, note) {
  const { state, user } = requireApproved()
  if (!isAdmin(user) && !isAssigned(state, shopId, user.id)) {
    throw new Error('You are not assigned to this shop')
  }
  state.visits.push({
    id: crypto.randomUUID(),
    shop_id: shopId,
    visited_by: user.id,
    visited_at: new Date().toISOString(),
    visit_note: String(note || '').trim() || null
  })
  persist()
  return { id: state.visits[state.visits.length - 1].id }
}

async function getTeam() {
  const state = await ensure()
  await ensure()
  requireRoles('owner', 'admin')
  return state.users
    .map(user => ({
      ...publicUser(user),
      shop_count: state.shopSalespeople.filter(row => row.salesperson_id === user.id).length
    }))
    .sort((a, b) => {
      const rank = { pending: 0, approved: 1, disabled: 2 }
      return (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.full_name.localeCompare(b.full_name)
    })
}

async function setEmployeeStatus(profileId, status) {
  const { state, user } = requireRoles('owner', 'admin')
  const target = state.users.find(person => person.id === profileId)
  if (!target) throw new Error('Employee not found')
  if (!['pending', 'approved', 'disabled'].includes(status)) throw new Error('Invalid status')
  if (target.role === 'owner' && user.role !== 'owner') {
    throw new Error('Only the owner can change an owner account')
  }
  if (user.role === 'admin' && ['owner', 'admin'].includes(target.role)) {
    throw new Error('Admins can only manage salesperson accounts')
  }
  if (target.id === user.id && status === 'disabled') {
    throw new Error('You cannot disable your own account')
  }
  if (status === 'disabled' && target.role === 'owner') {
    const activeOwners = state.users.filter(person => person.role === 'owner' && person.status === 'approved')
    if (activeOwners.length <= 1) throw new Error('The last active owner cannot be disabled')
  }
  target.status = status
  if (status === 'approved') {
    target.approved_at = target.approved_at || new Date().toISOString()
  }
  audit(state, user, `employee.${status}`, 'profile', profileId, { status })
  persist()
  return { id: profileId, status }
}

async function setEmployeeRole(profileId, role) {
  const { state, user } = requireRoles('owner')
  const target = state.users.find(person => person.id === profileId)
  if (!target) throw new Error('Employee not found')
  if (!['owner', 'admin', 'salesperson'].includes(role)) throw new Error('Invalid role')
  if (target.role === 'owner' && role !== 'owner') {
    const owners = state.users.filter(person => person.role === 'owner' && person.status === 'approved')
    if (owners.length <= 1) throw new Error('The last owner cannot be demoted')
  }
  target.role = role
  if (['owner', 'admin'].includes(role)) {
    target.status = 'approved'
    target.approved_at = target.approved_at || new Date().toISOString()
  }
  audit(state, user, 'employee.role_changed', 'profile', profileId, { role })
  persist()
  return { id: profileId, role }
}

async function getAuditLog(limit = 200) {
  const state = await ensure()
  requireRoles('owner', 'admin')
  return state.audit.slice(0, limit).map(entry => ({
    ...entry,
    actor_name: state.users.find(person => person.id === entry.actor_id)?.full_name || 'System'
  }))
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------
function salesFor(state, user, { from = null, to = null, limit = 300 } = {}) {
  return state.sales
    .filter(sale => canSeeSale(state, sale, user))
    .filter(sale => !from || sale.business_date >= from)
    .filter(sale => !to || sale.business_date <= to)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit)
    .map(sale => saleView(state, sale))
}

async function getSales(options = {}) {
  const state = await ensure()
  const { user } = requireApproved()
  return salesFor(state, user, options)
}

async function createSale({ shopId, paymentTerms, lines, clientReference = null }) {
  const { state, user } = requireApproved()
  if (clientReference) {
    const existing = state.sales.find(sale => sale.client_reference === clientReference)
    if (existing) {
      return {
        sale_id: existing.id,
        sale_number: existing.sale_number,
        status: existing.status,
        grand_total: Number(existing.grand_total),
        idempotent: true
      }
    }
  }

  if (!['cash', 'upi', 'credit'].includes(paymentTerms)) {
    throw new Error('Choose cash, UPI or credit')
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('Add at least one product line')
  }

  const shop = state.shops.find(item => item.id === shopId)
  if (!shop || shop.status !== 'approved') throw new Error('Select an approved shop')
  if (!isAdmin(user) && !isAssigned(state, shopId, user.id)) {
    throw new Error('You are not assigned to this shop')
  }
  if (paymentTerms === 'credit' && state.credit.blocked) {
    throw new Error('Credit sales are currently blocked by the owner')
  }

  const normalized = lines.map(line => ({
    variant_id: line.variant_id,
    cartons: Number(line.cartons)
  }))

  if (normalized.some(line => !Number.isInteger(line.cartons) || line.cartons <= 0)) {
    throw new Error('Carton quantities must be positive whole numbers')
  }
  if (new Set(normalized.map(line => line.variant_id)).size !== normalized.length) {
    throw new Error('Each product may appear only once per sale')
  }

  const status = paymentTerms === 'credit' ? 'pending_credit_approval' : 'confirmed'
  const businessDateValue = businessDate()

  let total = 0
  const prepared = normalized.map(line => {
    const info = variantInfo(state, line.variant_id)
    if (!info || !info.variant.active || !info.product.active) {
      throw new Error('An inactive or unknown product was selected')
    }
    const price = effectiveShopPrice(state, shopId, line.variant_id)
    if (!price || price.amount <= 0) {
      throw new Error(`No active price is set for ${info.product.name}`)
    }
    if (status === 'confirmed') {
      const stock = stockQty(state, line.variant_id, 'saleable')
      if (stock < line.cartons) {
        throw new Error(`Insufficient stock for ${info.product.name} (available: ${stock} cartons)`)
      }
    }
    const lineTotal = round2(price.amount * line.cartons)
    total = round2(total + lineTotal)
    return { ...line, info, price: price.amount, lineTotal }
  })

  if (total <= 0) throw new Error('Sale total must be greater than zero')

  const sale = {
    id: crypto.randomUUID(),
    sale_number: Math.max(0, ...state.sales.map(item => item.sale_number)) + 1,
    shop_id: shopId,
    salesperson_id: user.id,
    status,
    payment_terms: paymentTerms,
    business_date: businessDateValue,
    subtotal: total,
    tax_total: 0,
    grand_total: total,
    created_at: new Date().toISOString(),
    confirmed_at: status === 'confirmed' ? new Date().toISOString() : null,
    confirmed_by: status === 'confirmed' ? user.id : null,
    rejected_at: null,
    rejected_by: null,
    rejection_reason: null,
    client_reference: clientReference
  }
  state.sales.push(sale)

  prepared.forEach(line => {
    state.saleLines.push({
      id: crypto.randomUUID(),
      sale_id: sale.id,
      variant_id: line.variant_id,
      cartons: line.cartons,
      product_name_snapshot: line.info.product.name,
      sku_snapshot: line.info.variant.sku,
      pack_size_ml_snapshot: line.info.variant.pack_size_ml,
      bottles_per_carton_snapshot: line.info.variant.bottles_per_carton,
      unit_price_snapshot: line.price,
      line_subtotal: line.lineTotal,
      line_total_snapshot: line.lineTotal
    })
  })

  let invoice = null
  if (status === 'confirmed') {
    prepared.forEach(line => {
      addMovement(state, user, line.variant_id, 'saleable', 'sale', -line.cartons, 'sale', sale.id, 'Confirmed sale')
    })
    postLedger(state, {
      shop_id: shopId,
      sale_id: sale.id,
      entry_type: 'sale_debit',
      amount: total,
      entry_date: businessDateValue,
      created_by: user.id
    })
    invoice = issueInvoice(state, sale)

    if (paymentTerms === 'cash' || paymentTerms === 'upi') {
      const payment = {
        id: crypto.randomUUID(),
        payment_reference: crypto.randomUUID(),
        shop_id: shopId,
        recorded_by: user.id,
        method: paymentTerms,
        amount: total,
        received_at: new Date().toISOString(),
        external_reference: null,
        status: 'submitted',
        verified_by: null,
        verified_at: null,
        rejected_by: null,
        rejected_at: null,
        rejection_reason: null,
        created_at: new Date().toISOString()
      }
      state.payments.push(payment)
      state.allocations.push({
        id: crypto.randomUUID(),
        payment_id: payment.id,
        sale_id: sale.id,
        amount: total,
        created_at: new Date().toISOString()
      })
    }
  }

  audit(state, user, 'sale.created', 'sale', sale.id, { status, total, terms: paymentTerms })
  persist()
  return {
    sale_id: sale.id,
    sale_number: sale.sale_number,
    status,
    grand_total: total,
    payment_terms: paymentTerms,
    business_date: businessDateValue,
    invoice_number: invoice?.invoice_number || null
  }
}

async function reviewCreditSale({ saleId, decision, reason }) {
  const { state, user } = requireRoles('owner', 'admin')
  const sale = state.sales.find(item => item.id === saleId)
  if (!sale) throw new Error('Sale not found')
  if (sale.status !== 'pending_credit_approval') throw new Error('This credit sale is no longer pending')

  if (decision === 'reject') {
    if (!String(reason || '').trim()) throw new Error('A rejection reason is required')
    sale.status = 'rejected'
    sale.rejected_at = new Date().toISOString()
    sale.rejected_by = user.id
    sale.rejection_reason = String(reason).trim()
    audit(state, user, 'sale.credit_rejected', 'sale', saleId, { reason })
    persist()
    return { sale_id: saleId, status: 'rejected' }
  }

  if (state.credit.blocked) throw new Error('Credit sales are currently blocked by the owner')

  const lines = state.saleLines.filter(line => line.sale_id === saleId)
  lines.forEach(line => {
    const stock = stockQty(state, line.variant_id, 'saleable')
    if (stock < line.cartons) {
      throw new Error(
        `Insufficient stock for ${line.product_name_snapshot} (available: ${stock} cartons)`
      )
    }
  })
  lines.forEach(line => {
    addMovement(state, user, line.variant_id, 'saleable', 'sale', -line.cartons, 'sale', saleId, 'Approved credit sale')
  })

  sale.status = 'confirmed'
  sale.confirmed_at = new Date().toISOString()
  sale.confirmed_by = user.id
  postLedger(state, {
    shop_id: sale.shop_id,
    sale_id: sale.id,
    entry_type: 'sale_debit',
    amount: Number(sale.grand_total),
    entry_date: businessDate(),
    created_by: user.id
  })
  const invoice = issueInvoice(state, sale)
  audit(state, user, 'sale.credit_approved', 'sale', saleId)
  persist()
  return { sale_id: saleId, status: 'confirmed', invoice_number: invoice.invoice_number }
}

async function getSaleDetail(saleId) {
  const state = await ensure()
  const { user } = requireApproved()
  const sale = state.sales.find(item => item.id === saleId)
  if (!sale) throw new Error('Sale not found')
  if (!canSeeSale(state, sale, user)) throw new Error('You do not have access to this sale')

  const shop = state.shops.find(item => item.id === sale.shop_id)
  const person = state.users.find(item => item.id === sale.salesperson_id)
  const invoice = state.invoices.find(item => item.sale_id === sale.id)
  const lines = state.saleLines
    .filter(line => line.sale_id === sale.id)
    .map(line => ({
      id: line.id,
      variant_id: line.variant_id,
      product_name: line.product_name_snapshot,
      sku: line.sku_snapshot,
      pack_size_ml: line.pack_size_ml_snapshot,
      bottles_per_carton: line.bottles_per_carton_snapshot,
      cartons: line.cartons,
      unit_price: Number(line.unit_price_snapshot),
      line_total: Number(line.line_total_snapshot)
    }))

  return {
    id: sale.id,
    sale_number: sale.sale_number,
    status: sale.status,
    payment_terms: sale.payment_terms,
    business_date: sale.business_date,
    subtotal: Number(sale.subtotal),
    grand_total: Number(sale.grand_total),
    paid: round2(saleAllocated(state, sale.id)),
    balance: saleBalance(state, sale.id),
    shop: {
      id: shop?.id,
      name: shop?.name || '',
      phone: shop?.phone,
      address_line1: shop?.address_line1,
      address_line2: shop?.address_line2,
      city: shop?.city,
      state: shop?.state,
      postal_code: shop?.postal_code
    },
    salesperson: { id: person?.id, name: person?.full_name || '' },
    lines,
    invoice: invoice
      ? {
          id: invoice.id,
          invoice_number: invoice.invoice_number,
          issued_at: invoice.issued_at,
          seller: invoice.seller,
          buyer: invoice.buyer,
          tax_mode: invoice.tax_mode,
          subtotal: invoice.subtotal,
          grand_total: invoice.grand_total,
          lines: invoice.lines
        }
      : null,
    payments: state.payments
      .filter(payment =>
        state.allocations.some(row => row.payment_id === payment.id && row.sale_id === sale.id)
      )
      .map(payment => ({
        id: payment.id,
        method: payment.method,
        amount: Number(payment.amount),
        status: payment.status,
        received_at: payment.received_at,
        verified_at: payment.verified_at,
        allocated: round2(
          state.allocations
            .filter(row => row.payment_id === payment.id && row.sale_id === sale.id)
            .reduce((total, row) => total + Number(row.amount), 0)
        )
      })),
    returns: state.returns
      .filter(row => row.sale_id === sale.id)
      .map(row => ({
        id: row.id,
        status: row.status,
        reason: row.reason,
        submitted_at: row.submitted_at,
        reviewed_at: row.reviewed_at,
        review_reason: row.review_reason,
        lines: row.lines.map(line => {
          const saleLine = state.saleLines.find(item => item.id === line.sale_line_id)
          return {
            product_name: saleLine?.product_name_snapshot || '',
            cartons: line.cartons,
            approved_cartons: line.approved_cartons,
            condition: line.condition
          }
        })
      }))
  }
}

async function getShopOpenSales(shopId) {
  const state = await ensure()
  const { user } = requireApproved()
  if (!isAdmin(user) && !isAssigned(state, shopId, user.id)) return []
  return state.sales
    .filter(sale => sale.shop_id === shopId && sale.status === 'confirmed')
    .map(sale => ({
      sale_id: sale.id,
      sale_number: sale.sale_number,
      business_date: sale.business_date,
      grand_total: Number(sale.grand_total),
      balance: saleBalance(state, sale.id)
    }))
    .filter(sale => sale.balance > 0)
    .sort((a, b) => a.business_date.localeCompare(b.business_date) || a.sale_number - b.sale_number)
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
function paymentVisible(state, payment, user) {
  return (
    isAdmin(user) ||
    payment.recorded_by === user.id ||
    isAssigned(state, payment.shop_id, user.id)
  )
}

async function getPayments({ from = null, to = null, limit = 300 } = {}) {
  const state = await ensure()
  const { user } = requireApproved()
  return state.payments
    .filter(payment => paymentVisible(state, payment, user))
    .filter(payment => !from || businessDate(new Date(payment.received_at)) >= from)
    .filter(payment => !to || businessDate(new Date(payment.received_at)) <= to)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit)
    .map(payment => paymentView(state, payment))
}

async function recordPayment({
  shopId,
  method,
  amount,
  receivedAt,
  externalReference = '',
  allocations = [],
  clientReference = null
}) {
  const { state, user } = requireApproved()
  if (clientReference) {
    const existing = state.payments.find(payment => payment.payment_reference === clientReference)
    if (existing) {
      return { payment_id: existing.id, status: existing.status, idempotent: true }
    }
  }
  if (!['cash', 'upi', 'bank_transfer'].includes(method)) {
    throw new Error('Choose cash, UPI or bank transfer')
  }
  if (!Number(amount) || Number(amount) <= 0) {
    throw new Error('Payment amount must be greater than zero')
  }
  const shop = state.shops.find(item => item.id === shopId)
  if (!shop || shop.status !== 'approved') throw new Error('Select an approved shop')
  if (!isAdmin(user) && !isAssigned(state, shopId, user.id)) {
    throw new Error('You are not assigned to this shop')
  }

  let allocatedTotal = 0
  allocations.forEach(row => {
    const sale = state.sales.find(item => item.id === row.sale_id)
    if (!sale || sale.shop_id !== shopId || sale.status !== 'confirmed') {
      throw new Error('An allocation references an invalid sale')
    }
    if (!Number(row.amount) || Number(row.amount) <= 0) {
      throw new Error('Allocation amounts must be greater than zero')
    }
    const balance = saleBalance(state, sale.id)
    if (Number(row.amount) > balance) {
      throw new Error(`Allocation exceeds the outstanding balance for sale #${sale.sale_number}`)
    }
    allocatedTotal = round2(allocatedTotal + Number(row.amount))
  })
  if (allocatedTotal > Number(amount)) {
    throw new Error('Allocations cannot exceed the payment amount')
  }

  const payment = {
    id: crypto.randomUUID(),
    payment_reference: clientReference || crypto.randomUUID(),
    shop_id: shopId,
    recorded_by: user.id,
    method,
    amount: round2(amount),
    received_at: receivedAt || new Date().toISOString(),
    external_reference: String(externalReference || '').trim() || null,
    status: 'submitted',
    verified_by: null,
    verified_at: null,
    rejected_by: null,
    rejected_at: null,
    rejection_reason: null,
    created_at: new Date().toISOString()
  }
  state.payments.push(payment)
  allocations.forEach(row => {
    state.allocations.push({
      id: crypto.randomUUID(),
      payment_id: payment.id,
      sale_id: row.sale_id,
      amount: round2(row.amount),
      created_at: new Date().toISOString()
    })
  })
  audit(state, user, 'payment.submitted', 'payment', payment.id, {
    amount: round2(amount),
    method
  })
  persist()
  return {
    payment_id: payment.id,
    status: 'submitted',
    amount: round2(amount),
    allocated: allocatedTotal
  }
}

async function verifyPayment({ paymentId, decision, reason }) {
  const { state, user } = requireRoles('owner', 'admin')
  const payment = state.payments.find(item => item.id === paymentId)
  if (!payment) throw new Error('Payment not found')
  if (payment.status !== 'submitted') throw new Error('This payment has already been reviewed')

  if (decision === 'reject') {
    if (!String(reason || '').trim()) throw new Error('A rejection reason is required')
    payment.status = 'rejected'
    payment.rejected_by = user.id
    payment.rejected_at = new Date().toISOString()
    payment.rejection_reason = String(reason).trim()
    audit(state, user, 'payment.rejected', 'payment', paymentId, { reason })
    persist()
    return { payment_id: paymentId, status: 'rejected' }
  }

  const existing = state.allocations.filter(row => row.payment_id === paymentId)
  let allocated = 0
  existing.forEach(row => {
    const balance = saleBalance(state, row.sale_id)
    if (Number(row.amount) > balance) {
      throw new Error(
        'Sale balance changed; allocation exceeds the current outstanding amount. Reject and record the payment again.'
      )
    }
    allocated = round2(allocated + Number(row.amount))
  })

  let remaining = round2(Number(payment.amount) - allocated)
  if (remaining > 0) {
    const open = state.sales
      .filter(sale => sale.shop_id === payment.shop_id && sale.status === 'confirmed')
      .filter(sale => !existing.some(row => row.sale_id === sale.id))
      .sort((a, b) => a.business_date.localeCompare(b.business_date) || a.sale_number - b.sale_number)
    for (const sale of open) {
      if (remaining <= 0) break
      const balance = saleBalance(state, sale.id)
      const take = Math.min(remaining, balance)
      if (take > 0) {
        state.allocations.push({
          id: crypto.randomUUID(),
          payment_id: paymentId,
          sale_id: sale.id,
          amount: round2(take),
          created_at: new Date().toISOString()
        })
        remaining = round2(remaining - take)
      }
    }
  }

  payment.status = 'verified'
  payment.verified_by = user.id
  payment.verified_at = new Date().toISOString()

  const receipt = {
    id: crypto.randomUUID(),
    payment_id: paymentId,
    receipt_number: nextReceiptNumber(state),
    amount_snapshot: Number(payment.amount),
    method_snapshot: payment.method,
    shop_snapshot: {
      id: state.shops.find(shop => shop.id === payment.shop_id)?.id,
      name: state.shops.find(shop => shop.id === payment.shop_id)?.name,
      phone: state.shops.find(shop => shop.id === payment.shop_id)?.phone
    },
    issued_at: new Date().toISOString()
  }
  state.receipts.push(receipt)

  state.allocations
    .filter(row => row.payment_id === paymentId)
    .forEach(row => {
      postLedger(state, {
        shop_id: payment.shop_id,
        payment_allocation_id: row.id,
        entry_type: 'payment_credit',
        amount: Number(row.amount),
        entry_date: businessDate(),
        created_by: user.id
      })
    })

  audit(state, user, 'payment.verified', 'payment', paymentId, { amount: Number(payment.amount) })
  persist()
  return {
    payment_id: paymentId,
    status: 'verified',
    receipt_number: receipt.receipt_number,
    unapplied: Math.max(remaining, 0)
  }
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
async function getInventory(limit = 150) {
  const state = await ensure()
  requireApproved()
  return {
    stock: makeCatalog(state).map(item => ({
      variant_id: item.variant_id,
      product_name: item.product_name,
      sku: item.sku,
      pack_size_ml: item.pack_size_ml,
      bottles_per_carton: item.bottles_per_carton,
      saleable: item.stock_saleable,
      damaged: item.stock_damaged,
      default_price: item.default_price
    })),
    movements: [...state.movements]
      .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
      .slice(0, limit)
      .map(move => ({
        ...move,
        product_name: variantInfo(state, move.variant_id)?.product.name || '',
        bottles_per_carton: variantInfo(state, move.variant_id)?.variant.bottles_per_carton || 0,
        actor_name: state.users.find(person => person.id === move.actor_id)?.full_name || 'System'
      }))
  }
}

async function receiveStock({ variantId, cartons, reason, clientReference = null }) {
  const { state, user } = requireRoles('owner', 'admin')
  if (!Number.isInteger(Number(cartons)) || Number(cartons) <= 0) {
    throw new Error('Cartons received must be greater than zero')
  }
  if (!variantInfo(state, variantId)) throw new Error('Product variant not found')
  if (clientReference && state.movements.some(move => move.id === clientReference)) {
    return { variant_id: variantId, saleable: stockQty(state, variantId) }
  }
  addMovement(
    state,
    user,
    variantId,
    'saleable',
    'received',
    Number(cartons),
    'manual_receipt',
    clientReference || crypto.randomUUID(),
    String(reason || '').trim() || 'Stock received'
  )
  audit(state, user, 'inventory.received', 'product_variant', variantId, { cartons: Number(cartons) })
  persist()
  return {
    variant_id: variantId,
    saleable: stockQty(state, variantId, 'saleable'),
    damaged: stockQty(state, variantId, 'damaged')
  }
}

async function adjustStock({ variantId, bucket, delta, reason }) {
  const { state, user } = requireRoles('owner', 'admin')
  if (!['saleable', 'damaged'].includes(bucket)) throw new Error('Invalid stock bucket')
  if (!Number.isInteger(Number(delta)) || Number(delta) === 0) {
    throw new Error('Adjustment must be a non-zero number of cartons')
  }
  if (!String(reason || '').trim()) throw new Error('A reason is required for a stock adjustment')
  if (!variantInfo(state, variantId)) throw new Error('Product variant not found')
  const after = stockQty(state, variantId, bucket) + Number(delta)
  if (after < 0) {
    throw new Error(
      `Adjustment would make ${bucket} stock negative (current: ${stockQty(state, variantId, bucket)})`
    )
  }
  addMovement(state, user, variantId, bucket, 'adjustment', Number(delta), 'manual_adjustment', crypto.randomUUID(), String(reason).trim())
  audit(state, user, 'inventory.adjusted', 'product_variant', variantId, { bucket, delta: Number(delta) })
  persist()
  return {
    variant_id: variantId,
    saleable: stockQty(state, variantId, 'saleable'),
    damaged: stockQty(state, variantId, 'damaged')
  }
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------
function returnVisible(state, request, user) {
  return (
    isAdmin(user) ||
    request.submitted_by === user.id ||
    isAssigned(state, request.shop_id, user.id)
  )
}

async function getReturns(limit = 200) {
  const state = await ensure()
  const { user } = requireApproved()
  return [...state.returns]
    .filter(request => returnVisible(state, request, user))
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)))
    .slice(0, limit)
    .map(request => {
      const sale = state.sales.find(item => item.id === request.sale_id)
      const shop = state.shops.find(item => item.id === request.shop_id)
      return {
        ...request,
        sale_number: sale?.sale_number,
        shop_name: shop?.name || '',
        submitted_by_name:
          state.users.find(person => person.id === request.submitted_by)?.full_name || '',
        lines: request.lines.map(line => {
          const saleLine = state.saleLines.find(item => item.id === line.sale_line_id)
          return {
            product_name: saleLine?.product_name_snapshot || '',
            cartons: line.cartons,
            approved_cartons: line.approved_cartons,
            condition: line.condition,
            unit_price: Number(saleLine?.unit_price_snapshot || 0)
          }
        })
      }
    })
}

async function submitReturn({ saleId, reason, lines }) {
  const { state, user } = requireApproved()
  if (!String(reason || '').trim()) throw new Error('A return reason is required')
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('Add at least one return line')
  const sale = state.sales.find(item => item.id === saleId)
  if (!sale || sale.status !== 'confirmed') throw new Error('Only a confirmed sale can be returned')
  if (!canSeeSale(state, sale, user)) throw new Error('You do not have access to this sale')

  const prepared = lines.map(line => {
    if (!Number.isInteger(Number(line.cartons)) || Number(line.cartons) <= 0) {
      throw new Error('Return quantity must be a positive whole number')
    }
    if (!['reusable', 'damaged'].includes(line.condition)) {
      throw new Error('Return condition must be reusable or damaged')
    }
    const saleLine = state.saleLines.find(
      item => item.id === line.sale_line_id && item.sale_id === saleId
    )
    if (!saleLine) throw new Error('A return line does not belong to this sale')
    if (Number(line.cartons) > saleLine.cartons) {
      throw new Error('Return quantity exceeds the quantity sold')
    }
    return {
      id: crypto.randomUUID(),
      sale_line_id: saleLine.id,
      cartons: Number(line.cartons),
      condition: line.condition,
      approved_cartons: 0
    }
  })

  const request = {
    id: crypto.randomUUID(),
    sale_id: saleId,
    shop_id: sale.shop_id,
    submitted_by: user.id,
    status: 'submitted',
    reason: String(reason).trim(),
    submitted_at: new Date().toISOString(),
    reviewed_by: null,
    reviewed_at: null,
    review_reason: null,
    lines: prepared
  }
  state.returns.push(request)
  audit(state, user, 'return.submitted', 'return_request', request.id, { sale_id: saleId })
  persist()
  return { return_id: request.id, status: 'submitted' }
}

async function reviewReturn({ returnId, decision, reason }) {
  const { state, user } = requireRoles('owner', 'admin')
  const request = state.returns.find(item => item.id === returnId)
  if (!request) throw new Error('Return request not found')
  if (request.status !== 'submitted') throw new Error('This return request has already been reviewed')

  if (decision === 'reject') {
    if (!String(reason || '').trim()) throw new Error('A rejection reason is required')
    request.status = 'rejected'
    request.reviewed_by = user.id
    request.reviewed_at = new Date().toISOString()
    request.review_reason = String(reason).trim()
    audit(state, user, 'return.rejected', 'return_request', returnId, { reason })
    persist()
    return { return_id: returnId, status: 'rejected' }
  }

  let credit = 0
  request.lines.forEach(line => {
    const saleLine = state.saleLines.find(item => item.id === line.sale_line_id)
    const approvedSoFar = state.returns
      .filter(other => other.status === 'approved' && other.id !== returnId)
      .flatMap(other => other.lines)
      .filter(otherLine => otherLine.sale_line_id === line.sale_line_id)
      .reduce((total, otherLine) => total + Number(otherLine.approved_cartons), 0)
    const remaining = saleLine.cartons - approvedSoFar
    if (line.cartons > remaining) {
      throw new Error(`Return exceeds the remaining returnable quantity for ${saleLine.product_name_snapshot}`)
    }
    addMovement(
      state,
      user,
      line.variant_id || saleLine.variant_id,
      line.condition === 'reusable' ? 'saleable' : 'damaged',
      line.condition === 'reusable' ? 'return_reusable' : 'return_damaged',
      line.cartons,
      'return_request',
      returnId,
      'Approved return'
    )
    line.approved_cartons = line.cartons
    credit += line.cartons * Number(saleLine.unit_price_snapshot)
  })

  request.status = 'approved'
  request.reviewed_by = user.id
  request.reviewed_at = new Date().toISOString()
  request.review_reason = String(reason || '').trim() || null

  postLedger(state, {
    shop_id: request.shop_id,
    sale_id: request.sale_id,
    return_request_id: returnId,
    entry_type: 'return_credit',
    amount: round2(credit),
    entry_date: businessDate(),
    created_by: user.id
  })
  audit(state, user, 'return.approved', 'return_request', returnId, { credit: round2(credit) })
  persist()
  return { return_id: returnId, status: 'approved', credit: round2(credit) }
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
async function getExpenses({ from = null, to = null, limit = 300 } = {}) {
  const state = await ensure()
  const { user } = requireApproved()
  return state.expenses
    .filter(expense => isAdmin(user) || expense.submitted_by === user.id)
    .filter(expense => !from || expense.expense_date >= from)
    .filter(expense => !to || expense.expense_date <= to)
    .sort((a, b) => String(b.expense_date).localeCompare(String(a.expense_date)))
    .slice(0, limit)
    .map(expense => ({
      ...expense,
      submitted_by_name:
        state.users.find(person => person.id === expense.submitted_by)?.full_name || ''
    }))
}

async function submitExpense({
  expenseDate,
  category,
  description,
  amount,
  clientReference = null
}) {
  const { state, user } = requireApproved()
  if (clientReference) {
    const existing = state.expenses.find(expense => expense.claim_reference === clientReference)
    if (existing) return { id: existing.id, status: existing.status, idempotent: true }
  }
  if (!String(category || '').trim()) throw new Error('Expense category is required')
  if (!String(description || '').trim()) throw new Error('Expense description is required')
  if (!Number(amount) || Number(amount) <= 0) {
    throw new Error('Expense amount must be greater than zero')
  }
  const expense = {
    id: crypto.randomUUID(),
    claim_reference: clientReference || crypto.randomUUID(),
    submitted_by: user.id,
    expense_date: expenseDate || businessDate(),
    category: String(category).trim(),
    description: String(description).trim(),
    amount: round2(amount),
    status: 'submitted',
    reviewed_by: null,
    reviewed_at: null,
    review_reason: null,
    paid_at: null,
    paid_by: null,
    created_at: new Date().toISOString()
  }
  state.expenses.push(expense)
  audit(state, user, 'expense.submitted', 'expense_claim', expense.id, {
    amount: round2(amount),
    category
  })
  persist()
  return { id: expense.id, status: 'submitted' }
}

async function reviewExpense({ expenseId, decision, reason }) {
  const { state, user } = requireRoles('owner', 'admin')
  const expense = state.expenses.find(item => item.id === expenseId)
  if (!expense) throw new Error('Expense not found')
  if (expense.status !== 'submitted') throw new Error('This expense has already been reviewed')
  if (expense.submitted_by === user.id) throw new Error('You cannot approve or reject your own expense')
  if (decision === 'reject' && !String(reason || '').trim()) {
    throw new Error('A rejection reason is required')
  }
  expense.status = decision === 'approve' ? 'approved' : 'rejected'
  expense.reviewed_by = user.id
  expense.reviewed_at = new Date().toISOString()
  expense.review_reason = String(reason || '').trim() || null
  audit(state, user, `expense.${decision}d`, 'expense_claim', expenseId, { reason })
  persist()
  return { id: expenseId, status: expense.status }
}

async function markExpensePaid(expenseId) {
  const { state, user } = requireRoles('owner', 'admin')
  const expense = state.expenses.find(item => item.id === expenseId)
  if (!expense) throw new Error('Expense not found')
  if (expense.status !== 'approved') throw new Error('Only an approved expense can be marked as paid')
  expense.status = 'paid'
  expense.paid_at = new Date().toISOString()
  expense.paid_by = user.id
  audit(state, user, 'expense.paid', 'expense_claim', expenseId)
  persist()
  return { id: expenseId, status: 'paid' }
}

// ---------------------------------------------------------------------------
// Dashboard and reports
// ---------------------------------------------------------------------------
async function getDashboard() {
  const state = await ensure()
  const { user } = requireApproved()
  const today = businessDate()
  const month = monthStart()
  const visibleSales = state.sales.filter(sale => canSeeSale(state, sale, user))
  const confirmed = visibleSales.filter(sale => sale.status === 'confirmed')
  const visiblePayments = state.payments.filter(payment => paymentVisible(state, payment, user))

  const todaySales = confirmed
    .filter(sale => sale.business_date === today)
    .reduce((total, sale) => total + Number(sale.grand_total), 0)
  const collectedToday = visiblePayments
    .filter(payment => payment.status === 'verified')
    .filter(payment => businessDate(new Date(payment.received_at)) === today)
    .reduce((total, payment) => total + Number(payment.amount), 0)
  const outstanding = confirmed.reduce((total, sale) => total + saleBalance(state, sale.id), 0)
  const monthSales = confirmed
    .filter(sale => sale.business_date >= month)
    .reduce((total, sale) => total + Number(sale.grand_total), 0)
  const monthCollected = visiblePayments
    .filter(payment => payment.status === 'verified')
    .filter(payment => businessDate(new Date(payment.received_at)) >= month)
    .reduce((total, payment) => total + Number(payment.amount), 0)
  const monthExpenses = state.expenses
    .filter(expense => isAdmin(user) || expense.submitted_by === user.id)
    .filter(expense => ['approved', 'paid'].includes(expense.status) && expense.expense_date >= month)
    .reduce((total, expense) => total + Number(expense.amount), 0)

  return {
    business_date: today,
    today_sales: round2(todaySales),
    today_transactions: confirmed.filter(sale => sale.business_date === today).length,
    collected_today: round2(collectedToday),
    outstanding: round2(outstanding),
    month_sales: round2(monthSales),
    month_collected: round2(monthCollected),
    month_expenses: round2(monthExpenses),
    pending_credit_sales: visibleSales.filter(sale => sale.status === 'pending_credit_approval').length,
    pending_payments: visiblePayments.filter(payment => payment.status === 'submitted').length,
    pending_returns: state.returns.filter(
      request => request.status === 'submitted' && returnVisible(state, request, user)
    ).length,
    pending_expenses: state.expenses.filter(
      expense =>
        expense.status === 'submitted' && (isAdmin(user) || expense.submitted_by === user.id)
    ).length,
    pending_shops: state.shops.filter(
      shop => shop.status === 'pending' && (isAdmin(user) || shop.submitted_by === user.id)
    ).length,
    pending_employees: isAdmin(user)
      ? state.users.filter(person => person.status === 'pending').length
      : 0,
    stock: makeCatalog(state).map(item => ({
      variant_id: item.variant_id,
      product_name: item.product_name,
      bottles_per_carton: item.bottles_per_carton,
      pack_size_ml: item.pack_size_ml,
      saleable: item.stock_saleable,
      damaged: item.stock_damaged,
      default_price: item.default_price
    })),
    recent_sales: salesFor(state, user, { limit: 6 })
  }
}

async function getProductReport({ from = null, to = null } = {}) {
  const state = await ensure()
  const { user } = requireApproved()
  const sales = state.sales.filter(
    sale =>
      canSeeSale(state, sale, user) &&
      sale.status === 'confirmed' &&
      (!from || sale.business_date >= from) &&
      (!to || sale.business_date <= to)
  )
  const saleIds = new Set(sales.map(sale => sale.id))
  const map = new Map()
  state.saleLines
    .filter(line => saleIds.has(line.sale_id))
    .forEach(line => {
      const key = `${line.product_name_snapshot}|${line.sku_snapshot}`
      if (!map.has(key)) {
        map.set(key, {
          product_name: line.product_name_snapshot,
          sku: line.sku_snapshot,
          bottles_per_carton: line.bottles_per_carton_snapshot,
          cartons: 0,
          revenue: 0
        })
      }
      const row = map.get(key)
      row.cartons += line.cartons
      row.revenue += Number(line.line_total_snapshot)
    })
  return [...map.values()].sort((a, b) => b.revenue - a.revenue)
}

async function getFinancialReport({ from = null, to = null } = {}) {
  const [sales, payments, expenses, products] = await Promise.all([
    fetchCompleteList(limit => getSales({ from, to, limit }), 300),
    fetchCompleteList(limit => getPayments({ from, to, limit }), 300),
    fetchCompleteList(limit => getExpenses({ from, to, limit }), 300),
    getProductReport({ from, to })
  ])
  return aggregateReport({ sales, payments, expenses, products })
}

export const localBackend = {
  mode: 'local',
  getSession,
  onAuthChange,
  signIn,
  signUp,
  signOut,
  getProfile,
  updateMyName,
  updateMyAvatar,
  needsFirstOwner,
  claimOwner,
  getBusinessSettings,
  updateBusinessSettings,
  getCreditStatus,
  setCreditBlock,
  getCatalog,
  getShopPrices,
  setDefaultPrice,
  setShopPrice,
  clearShopPrice,
  getShops,
  submitShop,
  reviewShop,
  assignShopSalespeople,
  addShopVisit,
  getTeam,
  setEmployeeStatus,
  setEmployeeRole,
  getAuditLog,
  getSales,
  createSale,
  reviewCreditSale,
  getSaleDetail,
  getShopOpenSales,
  getPayments,
  recordPayment,
  verifyPayment,
  getInventory,
  receiveStock,
  adjustStock,
  getReturns,
  submitReturn,
  reviewReturn,
  getExpenses,
  submitExpense,
  reviewExpense,
  markExpensePaid,
  getDashboard,
  getProductReport,
  getFinancialReport
}

