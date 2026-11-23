export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100
}

export function resolveSalePrice(catalog, shopPrices, shopId, variantId) {
  const override = (shopPrices || []).find(
    item => item.shop_id === shopId && item.variant_id === variantId
  )
  if (override) {
    return { amount: Number(override.amount), source: 'shop' }
  }
  const item = (catalog || []).find(variant => variant.variant_id === variantId)
  if (item && item.default_price !== null && item.default_price !== undefined) {
    return { amount: Number(item.default_price), source: 'default' }
  }
  return null
}

export function bottlesFor(cartons, bottlesPerCarton) {
  return Number(cartons || 0) * Number(bottlesPerCarton || 0)
}

export function aggregateReport({ sales = [], payments = [], expenses = [], products = [] }) {
  const confirmed = sales.filter(sale => sale.status === 'confirmed')
  const verifiedPayments = payments.filter(payment => payment.status === 'verified')
  const countedExpenses = expenses.filter(expense =>
    ['approved', 'paid'].includes(expense.status)
  )

  const revenue = confirmed.reduce((total, sale) => total + Number(sale.grand_total || 0), 0)
  const returns = confirmed.reduce((total, sale) => total + Number(sale.returned || 0), 0)
  const collections = verifiedPayments.reduce(
    (total, payment) => total + Number(payment.amount || 0),
    0
  )
  const outstanding = confirmed.reduce((total, sale) => total + Number(sale.balance || 0), 0)
  const expenseTotal = countedExpenses.reduce(
    (total, expense) => total + Number(expense.amount || 0),
    0
  )

  const shopMap = new Map()
  function shopEntry(name) {
    if (!shopMap.has(name)) {
      shopMap.set(name, {
        name,
        revenue: 0,
        returns: 0,
        outstanding: 0,
        collections: 0,
        transactions: 0
      })
    }
    return shopMap.get(name)
  }

  confirmed.forEach(sale => {
    const entry = shopEntry(sale.shop_name || 'Unknown shop')
    entry.revenue += Number(sale.grand_total || 0)
    entry.returns += Number(sale.returned || 0)
    entry.outstanding += Number(sale.balance || 0)
    entry.transactions += 1
  })
  verifiedPayments.forEach(payment => {
    shopEntry(payment.shop_name || 'Unknown shop').collections += Number(payment.amount || 0)
  })

  const personMap = new Map()
  confirmed.forEach(sale => {
    const name = sale.salesperson_name || 'Unknown'
    if (!personMap.has(name)) {
      personMap.set(name, { name, revenue: 0, transactions: 0, outstanding: 0 })
    }
    const entry = personMap.get(name)
    entry.revenue += Number(sale.grand_total || 0)
    entry.transactions += 1
    entry.outstanding += Number(sale.balance || 0)
  })

  const dailyMap = new Map()
  confirmed.forEach(sale => {
    const date = sale.business_date
    if (!dailyMap.has(date)) dailyMap.set(date, { date, revenue: 0, collections: 0 })
    dailyMap.get(date).revenue += Number(sale.grand_total || 0)
  })
  verifiedPayments.forEach(payment => {
    const date = String(payment.received_at || '').slice(0, 10)
    if (!dailyMap.has(date)) dailyMap.set(date, { date, revenue: 0, collections: 0 })
    dailyMap.get(date).collections += Number(payment.amount || 0)
  })

  const methodMap = new Map()
  verifiedPayments.forEach(payment => {
    const method = payment.method || 'other'
    methodMap.set(method, (methodMap.get(method) || 0) + Number(payment.amount || 0))
  })

  const categoryMap = new Map()
  countedExpenses.forEach(expense => {
    const category = expense.category || 'Other'
    categoryMap.set(category, (categoryMap.get(category) || 0) + Number(expense.amount || 0))
  })

  return {
    revenue: round2(revenue),
    returns: round2(returns),
    netRevenue: round2(revenue - returns),
    collections: round2(collections),
    outstanding: round2(outstanding),
    expenses: round2(expenseTotal),
    net: round2(revenue - returns - expenseTotal),
    transactions: confirmed.length,
    byShop: [...shopMap.values()].sort((a, b) => b.revenue - a.revenue),
    bySalesperson: [...personMap.values()].sort((a, b) => b.revenue - a.revenue),
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    methods: [...methodMap.entries()]
      .map(([method, amount]) => ({ method, amount: round2(amount) }))
      .sort((a, b) => b.amount - a.amount),
    categories: [...categoryMap.entries()]
      .map(([category, amount]) => ({ category, amount: round2(amount) }))
      .sort((a, b) => b.amount - a.amount),
    products: products.map(product => ({
      ...product,
      cartons: Number(product.cartons || 0),
      revenue: Number(product.revenue || 0)
    }))
  }
}

export function overallOutstanding(sales) {
  return round2(
    sales
      .filter(sale => sale.status === 'confirmed')
      .reduce((total, sale) => total + Number(sale.balance || 0), 0)
  )
}

export function pendingCounts({ dashboard, sales = [], payments = [], returns = [], expenses = [], shops = [], team = [] }) {
  if (dashboard) {
    return {
      creditSales: dashboard.pending_credit_sales,
      payments: dashboard.pending_payments,
      returns: dashboard.pending_returns,
      expenses: dashboard.pending_expenses,
      shops: dashboard.pending_shops,
      employees: dashboard.pending_employees
    }
  }
  return {
    creditSales: sales.filter(s => s.status === 'pending_credit_approval').length,
    payments: payments.filter(p => p.status === 'submitted').length,
    returns: returns.filter(r => r.status === 'submitted').length,
    expenses: expenses.filter(e => e.status === 'submitted').length,
    shops: shops.filter(s => s.status === 'pending').length,
    employees: team.filter(t => t.status === 'pending').length
  }
}
