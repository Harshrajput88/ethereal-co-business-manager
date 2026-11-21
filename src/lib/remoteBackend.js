import { supabase } from './supabase.js'
import { recordProfileResult, recordRpcResult } from './integrationStatus.js'

function requireClient() {
  if (!supabase) {
    throw new Error('Cloud access is not configured. Add the public Supabase URL and anon or publishable key, then reload. Demo data was not substituted.')
  }
  return supabase
}

async function rpc(name, args = {}) {
  try {
    const { data, error } = await requireClient().rpc(name, args)
    if (error) {
      const details = error.message || 'The server rejected the request'
      if (error.code === 'PGRST202' || /schema cache|could not find the function/i.test(details)) {
        throw new Error(
          `${name} is missing from the Supabase API schema cache. Confirm the matching migration is deployed to this project, then reload the PostgREST schema cache and retry. (${details})`
        )
      }
      if (error.code === '42501') {
        throw new Error(`Supabase denied access to ${name}. Check the authenticated EXECUTE grant and the user's approved role. (${details})`)
      }
      throw new Error(details)
    }
    recordRpcResult(name)
    return data
  } catch (error) {
    recordRpcResult(name, error.message || 'The business API request failed.')
    throw error
  }
}

async function fetchCursorPages(name, filters = {}, pageSize = 300, arrayKey = null) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new RangeError('Page size must be between 1 and 1000')
  }
  const rows = []
  let cursor = null
  let stock = null
  while (true) {
    const page = await rpc(name, { ...filters, p_cursor: cursor, p_limit: pageSize })
    const items = arrayKey ? page?.[arrayKey] : page?.items
    if (!Array.isArray(items)) throw new TypeError(`${name} returned an invalid page`)
    if (arrayKey && stock === null) stock = page.stock || []
    rows.push(...items)
    if (!page.has_more) break
    if (!page.next_cursor || page.next_cursor === cursor) {
      throw new Error(`${name} returned an invalid pagination cursor`)
    }
    cursor = page.next_cursor
  }
  return arrayKey ? { stock: stock || [], [arrayKey]: rows } : rows
}

async function loadProfile(userId) {
  const { data, error } = await requireClient()
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle()
  if (error) {
    recordProfileResult('profiles.select', error.message)
    return { profile: null, profileError: error.message }
  }
  recordProfileResult('profiles.select')
  return { profile: data, profileError: null }
}

async function getSession() {
  const client = requireClient()
  const { data, error } = await client.auth.getSession()
  if (error) throw new Error(error.message)
  if (!data.session) return null
  const { profile, profileError } = await loadProfile(data.session.user.id)
  return {
    user: { id: data.session.user.id, email: data.session.user.email },
    profile,
    profileError
  }
}

function onAuthChange(callback) {
  const client = requireClient()
  const { data } = client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || !session) callback(null)
    else callback(event)
  })
  return () => data.subscription.unsubscribe()
}

async function signIn(email, password) {
  const { data, error } = await requireClient().auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
  return data
}

async function signUp(fullName, email, password) {
  const { data, error } = await requireClient().auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName.trim() },
      emailRedirectTo: window.location.origin
    }
  })
  if (error) throw new Error(error.message)
  return { needsEmailConfirmation: !data.session, session: data.session }
}

async function signOut() {
  const { error } = await requireClient().auth.signOut()
  if (error) throw new Error(error.message)
}

async function getProfile() {
  const session = await getSession()
  return session?.profile || null
}

async function updateMyName(fullName) {
  const result = await rpc('api_update_my_name', { p_full_name: fullName })
  const session = await getSession()
  return { ...session?.profile, ...result }
}

async function updateMyAvatar() {
  // Fail closed until the private Storage bucket and owner-scoped object
  // policies are separately provisioned and verified.
  throw new Error('Profile-picture uploads are temporarily disabled. They will be enabled after the private Supabase Storage bucket and owner-scoped policies are provisioned and tested.')
}
async function needsFirstOwner() {
  return Boolean(await rpc('api_needs_first_owner'))
}

async function claimOwner() {
  return rpc('api_claim_owner')
}

async function getBusinessSettings() {
  return rpc('api_business_settings')
}

async function updateBusinessSettings(settings) {
  return rpc('api_update_business_settings', {
    p_business_name: settings.business_name,
    p_tagline: settings.tagline || '',
    p_address: settings.address || '',
    p_phone: settings.phone || '',
    p_email: settings.email || '',
    p_gstin: settings.gstin || ''
  })
}

async function getCreditStatus() {
  return rpc('api_credit_status')
}

async function setCreditBlock(blocked, reason) {
  return rpc('api_set_credit_block', { p_blocked: blocked, p_reason: reason || '' })
}

async function getCatalog() {
  return rpc('api_catalog')
}

async function getShopPrices(shopId = null) {
  return rpc('api_shop_prices', { p_shop_id: shopId })
}

async function setDefaultPrice(variantId, amount) {
  return rpc('api_set_default_price', { p_variant_id: variantId, p_amount: amount })
}

async function setShopPrice(shopId, variantId, amount) {
  return rpc('api_set_shop_price', {
    p_shop_id: shopId,
    p_variant_id: variantId,
    p_amount: amount
  })
}

async function clearShopPrice(shopId, variantId) {
  return rpc('api_clear_shop_price', { p_shop_id: shopId, p_variant_id: variantId })
}

async function getShops() {
  return rpc('api_shops_list')
}

async function submitShop(input) {
  return rpc('api_submit_shop', {
    p_name: input.name,
    p_phone: input.phone || null,
    p_email: input.email || null,
    p_address_line1: input.address_line1 || null,
    p_address_line2: input.address_line2 || null,
    p_locality: input.locality || null,
    p_city: input.city || null,
    p_state: input.state || null,
    p_postal_code: input.postal_code || null,
    p_notes: input.notes || null,
    p_latitude: input.latitude ? Number(input.latitude) : null,
    p_longitude: input.longitude ? Number(input.longitude) : null
  })
}

async function reviewShop({ shopId, decision, reason, primaryId, additionalIds = [] }) {
  return rpc('api_review_shop', {
    p_shop_id: shopId,
    p_decision: decision,
    p_reason: reason || null,
    p_primary_salesperson_id: primaryId || null,
    p_additional_salesperson_ids: additionalIds
  })
}

async function assignShopSalespeople({ shopId, primaryId, additionalIds = [] }) {
  return rpc('api_assign_shop_salespeople', {
    p_shop_id: shopId,
    p_primary_salesperson_id: primaryId,
    p_additional_salesperson_ids: additionalIds
  })
}

async function addShopVisit(shopId, note) {
  return rpc('api_add_shop_visit', { p_shop_id: shopId, p_note: note || '' })
}

async function getTeam() {
  return rpc('api_team_list')
}

async function setEmployeeStatus(profileId, status) {
  return rpc('api_set_employee_status', { p_profile_id: profileId, p_status: status })
}

async function setEmployeeRole(profileId, role) {
  return rpc('api_set_employee_role', { p_profile_id: profileId, p_role: role })
}

async function getAuditLog(limit = 200) {
  return rpc('api_audit_log', { p_limit: limit })
}

async function getSales({ from = null, to = null, limit = 300 } = {}) {
  return fetchCursorPages('api_sales_page', { p_from: from, p_to: to }, limit)
}

async function createSale({ shopId, paymentTerms, lines, clientReference = null }) {
  return rpc('api_create_sale', {
    p_shop_id: shopId,
    p_payment_terms: paymentTerms,
    p_lines: lines,
    p_client_reference: clientReference
  })
}

async function reviewCreditSale({ saleId, decision, reason }) {
  return rpc('api_review_credit_sale', {
    p_sale_id: saleId,
    p_decision: decision,
    p_reason: reason || null
  })
}

async function getSaleDetail(saleId) {
  return rpc('api_sale_detail', { p_sale_id: saleId })
}

async function getShopOpenSales(shopId) {
  return rpc('api_shop_open_sales', { p_shop_id: shopId })
}

async function getPayments({ from = null, to = null, limit = 300 } = {}) {
  return fetchCursorPages('api_payments_page', { p_from: from, p_to: to }, limit)
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
  return rpc('api_record_payment', {
    p_shop_id: shopId,
    p_method: method,
    p_amount: amount,
    p_received_at: receivedAt ? new Date(receivedAt).toISOString() : new Date().toISOString(),
    p_external_reference: externalReference || null,
    p_allocations: allocations,
    p_client_reference: clientReference
  })
}

async function verifyPayment({ paymentId, decision, reason }) {
  return rpc('api_verify_payment', {
    p_payment_id: paymentId,
    p_decision: decision,
    p_reason: reason || null
  })
}

async function getInventory(limit = 150) {
  const result = await fetchCursorPages('api_inventory_movements_page', {}, limit, 'movements')
  return { stock: result.stock || [], movements: result.movements || [] }
}

async function receiveStock({ variantId, cartons, reason, clientReference = null }) {
  return rpc('api_receive_stock', {
    p_variant_id: variantId,
    p_cartons: Number(cartons),
    p_reason: reason || null,
    p_client_reference: clientReference
  })
}

async function adjustStock({ variantId, bucket, delta, reason }) {
  return rpc('api_adjust_stock', {
    p_variant_id: variantId,
    p_bucket: bucket,
    p_cartons_delta: Number(delta),
    p_reason: reason
  })
}

async function getReturns(limit = 200) {
  return fetchCursorPages('api_returns_page', {}, limit)
}

async function submitReturn({ saleId, reason, lines }) {
  return rpc('api_submit_return', {
    p_sale_id: saleId,
    p_reason: reason,
    p_lines: lines
  })
}

async function reviewReturn({ returnId, decision, reason }) {
  return rpc('api_review_return', {
    p_return_id: returnId,
    p_decision: decision,
    p_reason: reason || null
  })
}

async function getExpenses({ from = null, to = null, limit = 300 } = {}) {
  return fetchCursorPages('api_expenses_page', { p_from: from, p_to: to }, limit)
}

async function submitExpense({ expenseDate, category, description, amount, clientReference = null }) {
  return rpc('api_submit_expense', {
    p_expense_date: expenseDate,
    p_category: category,
    p_description: description,
    p_amount: amount,
    p_client_reference: clientReference
  })
}

async function reviewExpense({ expenseId, decision, reason }) {
  return rpc('api_review_expense', {
    p_expense_id: expenseId,
    p_decision: decision,
    p_reason: reason || null
  })
}

async function markExpensePaid(expenseId) {
  return rpc('api_mark_expense_paid', { p_expense_id: expenseId })
}

async function getDashboard() {
  return rpc('api_dashboard')
}

async function getProductReport({ from = null, to = null } = {}) {
  return rpc('api_product_report', { p_from: from, p_to: to })
}

async function getFinancialReport({ from = null, to = null } = {}) {
  return rpc('api_financial_report', { p_from: from, p_to: to })
}

export const remoteBackend = {
  mode: 'supabase',
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
