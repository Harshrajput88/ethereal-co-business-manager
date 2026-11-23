import { addDays, businessDate } from './format.js'

export const DEMO_CREDENTIALS = [
  { role: 'Owner', email: 'owner@ethereal.local', password: 'owner123' },
  { role: 'Admin', email: 'admin@ethereal.local', password: 'admin123' },
  { role: 'Salesperson', email: 'sales@ethereal.local', password: 'sales123' }
]

export async function hashPassword(password) {
  const data = new TextEncoder().encode(`ethereal-local-demo:${password}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

const isoDaysAgo = days => new Date(Date.now() - days * 86400000).toISOString()

export async function createSeedState() {
  const today = businessDate()
  const yesterday = addDays(today, -1)
  const threeDaysAgo = addDays(today, -3)

  const [ownerHash, adminHash, salesHash, sales2Hash] = await Promise.all([
    hashPassword('owner123'),
    hashPassword('admin123'),
    hashPassword('sales123'),
    hashPassword('sales123')
  ])

  const users = [
    {
      id: '10000000-0000-4000-8000-000000000001',
      email: 'owner@ethereal.local',
      passwordHash: ownerHash,
      full_name: 'Aarav Mehta',
      role: 'owner',
      status: 'approved',
      avatar_url: null,
      approved_at: isoDaysAgo(120),
      created_at: isoDaysAgo(120)
    },
    {
      id: '10000000-0000-4000-8000-000000000002',
      email: 'admin@ethereal.local',
      passwordHash: adminHash,
      full_name: 'Neha Verma',
      role: 'admin',
      status: 'approved',
      avatar_url: null,
      approved_at: isoDaysAgo(90),
      created_at: isoDaysAgo(100)
    },
    {
      id: '10000000-0000-4000-8000-000000000003',
      email: 'sales@ethereal.local',
      passwordHash: salesHash,
      full_name: 'Rohan Kumar',
      role: 'salesperson',
      status: 'approved',
      avatar_url: null,
      approved_at: isoDaysAgo(60),
      created_at: isoDaysAgo(70)
    },
    {
      id: '10000000-0000-4000-8000-000000000004',
      email: 'priya@ethereal.local',
      passwordHash: sales2Hash,
      full_name: 'Priya Singh',
      role: 'salesperson',
      status: 'approved',
      avatar_url: null,
      approved_at: isoDaysAgo(45),
      created_at: isoDaysAgo(50)
    }
  ]

  const shops = [
    {
      id: '20000000-0000-4000-8000-000000000001',
      name: 'Green Valley Store',
      phone: '9990011122',
      email: 'greenvalley@example.com',
      address_line1: '12 Lake Road',
      address_line2: 'Near Gandhi Maidan',
      locality: 'Kankarbagh',
      city: 'Patna',
      state: 'Bihar',
      postal_code: '800020',
      latitude: null,
      longitude: null,
      status: 'approved',
      notes: 'Corner shop, morning delivery preferred.',
      submitted_by: users[2].id,
      reviewed_by: users[0].id,
      reviewed_at: isoDaysAgo(55),
      rejection_reason: null,
      created_at: isoDaysAgo(60)
    },
    {
      id: '20000000-0000-4000-8000-000000000002',
      name: 'Sunrise Mart',
      phone: '9990022233',
      email: 'sunrise@example.com',
      address_line1: '4 Hill Street',
      address_line2: null,
      locality: 'Boring Road',
      city: 'Patna',
      state: 'Bihar',
      postal_code: '800001',
      latitude: null,
      longitude: null,
      status: 'approved',
      notes: null,
      submitted_by: users[2].id,
      reviewed_by: users[1].id,
      reviewed_at: isoDaysAgo(40),
      rejection_reason: null,
      created_at: isoDaysAgo(44)
    },
    {
      id: '20000000-0000-4000-8000-000000000003',
      name: 'Lakeview Cafe',
      phone: '9990033344',
      email: null,
      address_line1: '7 Riverside Walk',
      address_line2: null,
      locality: 'Patrakar Nagar',
      city: 'Patna',
      state: 'Bihar',
      postal_code: '800013',
      latitude: null,
      longitude: null,
      status: 'pending',
      notes: 'New cafe, owner asked for weekly delivery.',
      submitted_by: users[3].id,
      reviewed_by: null,
      reviewed_at: null,
      rejection_reason: null,
      created_at: isoDaysAgo(1)
    },
    {
      id: '20000000-0000-4000-8000-000000000004',
      name: 'Hillside Grocers',
      phone: '9990044455',
      email: null,
      address_line1: '88 Station Road',
      address_line2: null,
      locality: 'Danapur',
      city: 'Patna',
      state: 'Bihar',
      postal_code: '801503',
      latitude: null,
      longitude: null,
      status: 'approved',
      notes: null,
      submitted_by: users[3].id,
      reviewed_by: users[0].id,
      reviewed_at: isoDaysAgo(20),
      rejection_reason: null,
      created_at: isoDaysAgo(25)
    }
  ]

  const shopSalespeople = [
    {
      shop_id: shops[0].id,
      salesperson_id: users[2].id,
      is_primary: true,
      assigned_by: users[0].id,
      assigned_at: isoDaysAgo(55)
    },
    {
      shop_id: shops[1].id,
      salesperson_id: users[2].id,
      is_primary: true,
      assigned_by: users[1].id,
      assigned_at: isoDaysAgo(40)
    },
    {
      shop_id: shops[3].id,
      salesperson_id: users[3].id,
      is_primary: true,
      assigned_by: users[0].id,
      assigned_at: isoDaysAgo(20)
    }
  ]

  const products = [
    { id: '30000000-0000-4000-8000-000000000001', name: '500 ml Water', active: true },
    { id: '30000000-0000-4000-8000-000000000002', name: '1 Litre Water', active: true }
  ]

  const variants = [
    {
      id: '31000000-0000-4000-8000-000000000001',
      product_id: products[0].id,
      sku: 'ETC-500ML-24',
      pack_size_ml: 500,
      bottles_per_carton: 24,
      active: true
    },
    {
      id: '31000000-0000-4000-8000-000000000002',
      product_id: products[1].id,
      sku: 'ETC-1L-12',
      pack_size_ml: 1000,
      bottles_per_carton: 12,
      active: true
    }
  ]

  const defaultPrices = [
    {
      id: '32000000-0000-4000-8000-000000000001',
      variant_id: variants[0].id,
      amount: 240,
      valid_from: isoDaysAgo(30),
      valid_to: null,
      set_by: users[0].id
    },
    {
      id: '32000000-0000-4000-8000-000000000002',
      variant_id: variants[1].id,
      amount: 300,
      valid_from: isoDaysAgo(30),
      valid_to: null,
      set_by: users[0].id
    }
  ]

  const shopPrices = [
    {
      id: '33000000-0000-4000-8000-000000000001',
      shop_id: shops[0].id,
      variant_id: variants[0].id,
      amount: 230,
      valid_from: isoDaysAgo(28),
      valid_to: null,
      set_by: users[0].id
    }
  ]

  const sale1Lines = [
    {
      id: '41000000-0000-4000-8000-000000000001',
      sale_id: '40000000-0000-4000-8000-000000000001',
      variant_id: variants[0].id,
      cartons: 2,
      product_name_snapshot: products[0].name,
      sku_snapshot: variants[0].sku,
      pack_size_ml_snapshot: 500,
      bottles_per_carton_snapshot: 24,
      unit_price_snapshot: 230,
      line_subtotal: 460,
      line_total_snapshot: 460
    },
    {
      id: '41000000-0000-4000-8000-000000000002',
      sale_id: '40000000-0000-4000-8000-000000000001',
      variant_id: variants[1].id,
      cartons: 1,
      product_name_snapshot: products[1].name,
      sku_snapshot: variants[1].sku,
      pack_size_ml_snapshot: 1000,
      bottles_per_carton_snapshot: 12,
      unit_price_snapshot: 300,
      line_subtotal: 300,
      line_total_snapshot: 300
    }
  ]

  const sale2Line = {
    id: '41000000-0000-4000-8000-000000000003',
    sale_id: '40000000-0000-4000-8000-000000000002',
    variant_id: variants[1].id,
    cartons: 4,
    product_name_snapshot: products[1].name,
    sku_snapshot: variants[1].sku,
    pack_size_ml_snapshot: 1000,
    bottles_per_carton_snapshot: 12,
    unit_price_snapshot: 300,
    line_subtotal: 1200,
    line_total_snapshot: 1200
  }

  const sale3Line = {
    id: '41000000-0000-4000-8000-000000000004',
    sale_id: '40000000-0000-4000-8000-000000000003',
    variant_id: variants[0].id,
    cartons: 3,
    product_name_snapshot: products[0].name,
    sku_snapshot: variants[0].sku,
    pack_size_ml_snapshot: 500,
    bottles_per_carton_snapshot: 24,
    unit_price_snapshot: 230,
    line_subtotal: 690,
    line_total_snapshot: 690
  }

  const sales = [
    {
      id: '40000000-0000-4000-8000-000000000001',
      sale_number: 1,
      shop_id: shops[0].id,
      salesperson_id: users[2].id,
      status: 'confirmed',
      payment_terms: 'cash',
      business_date: today,
      subtotal: 760,
      tax_total: 0,
      grand_total: 760,
      created_at: isoDaysAgo(0),
      confirmed_at: isoDaysAgo(0),
      confirmed_by: users[2].id,
      rejected_at: null,
      rejected_by: null,
      rejection_reason: null,
      client_reference: null
    },
    {
      id: '40000000-0000-4000-8000-000000000002',
      sale_number: 2,
      shop_id: shops[1].id,
      salesperson_id: users[2].id,
      status: 'confirmed',
      payment_terms: 'credit',
      business_date: yesterday,
      subtotal: 1200,
      tax_total: 0,
      grand_total: 1200,
      created_at: isoDaysAgo(1),
      confirmed_at: isoDaysAgo(1),
      confirmed_by: users[1].id,
      rejected_at: null,
      rejected_by: null,
      rejection_reason: null,
      client_reference: null
    },
    {
      id: '40000000-0000-4000-8000-000000000003',
      sale_number: 3,
      shop_id: shops[0].id,
      salesperson_id: users[2].id,
      status: 'pending_credit_approval',
      payment_terms: 'credit',
      business_date: today,
      subtotal: 690,
      tax_total: 0,
      grand_total: 690,
      created_at: isoDaysAgo(0),
      confirmed_at: null,
      confirmed_by: null,
      rejected_at: null,
      rejected_by: null,
      rejection_reason: null,
      client_reference: null
    }
  ]

  const seller = {
    name: 'Ethereal Co.',
    tagline: 'Pure by nature · Safe for life',
    address: 'Patna, Bihar, India',
    phone: '+91 99900 00000',
    email: 'hello@ethereal.co',
    gstin: ''
  }

  const invoices = [
    {
      id: '44000000-0000-4000-8000-000000000001',
      sale_id: sales[0].id,
      invoice_number: 'ETC-INV-202611-000001',
      issued_at: isoDaysAgo(0),
      issued_by: users[2].id,
      seller,
      buyer: { name: shops[0].name, phone: shops[0].phone, address_line1: shops[0].address_line1, city: shops[0].city, state: shops[0].state, postal_code: shops[0].postal_code },
      currency: 'INR',
      tax_mode: 'non_gst',
      subtotal: 760,
      grand_total: 760,
      lines: sale1Lines.map(line => ({
        product_name: line.product_name_snapshot,
        sku: line.sku_snapshot,
        cartons: line.cartons,
        unit_price: line.unit_price_snapshot,
        bottles_per_carton: line.bottles_per_carton_snapshot,
        line_total: line.line_total_snapshot
      }))
    },
    {
      id: '44000000-0000-4000-8000-000000000002',
      sale_id: sales[1].id,
      invoice_number: 'ETC-INV-202611-000002',
      issued_at: isoDaysAgo(1),
      issued_by: users[1].id,
      seller,
      buyer: { name: shops[1].name, phone: shops[1].phone, address_line1: shops[1].address_line1, city: shops[1].city, state: shops[1].state, postal_code: shops[1].postal_code },
      currency: 'INR',
      tax_mode: 'non_gst',
      subtotal: 1200,
      grand_total: 1200,
      lines: [{
        product_name: sale2Line.product_name_snapshot,
        sku: sale2Line.sku_snapshot,
        cartons: sale2Line.cartons,
        unit_price: sale2Line.unit_price_snapshot,
        bottles_per_carton: sale2Line.bottles_per_carton_snapshot,
        line_total: sale2Line.line_total_snapshot
      }]
    }
  ]

  const payments = [
    {
      id: '42000000-0000-4000-8000-000000000001',
      shop_id: shops[0].id,
      recorded_by: users[2].id,
      method: 'cash',
      amount: 760,
      received_at: isoDaysAgo(0),
      external_reference: null,
      status: 'verified',
      verified_by: users[0].id,
      verified_at: isoDaysAgo(0),
      rejected_by: null,
      rejected_at: null,
      rejection_reason: null,
      created_at: isoDaysAgo(0)
    },
    {
      id: '42000000-0000-4000-8000-000000000002',
      shop_id: shops[1].id,
      recorded_by: users[2].id,
      method: 'upi',
      amount: 500,
      received_at: isoDaysAgo(1),
      external_reference: 'UPI-884421',
      status: 'verified',
      verified_by: users[1].id,
      verified_at: isoDaysAgo(1),
      rejected_by: null,
      rejected_at: null,
      rejection_reason: null,
      created_at: isoDaysAgo(1)
    },
    {
      id: '42000000-0000-4000-8000-000000000003',
      shop_id: shops[0].id,
      recorded_by: users[2].id,
      method: 'upi',
      amount: 500,
      received_at: isoDaysAgo(0),
      external_reference: 'UPI-991104',
      status: 'submitted',
      verified_by: null,
      verified_at: null,
      rejected_by: null,
      rejected_at: null,
      rejection_reason: null,
      created_at: isoDaysAgo(0)
    }
  ]

  const allocations = [
    {
      id: '43000000-0000-4000-8000-000000000001',
      payment_id: payments[0].id,
      sale_id: sales[0].id,
      amount: 760,
      created_at: isoDaysAgo(0)
    },
    {
      id: '43000000-0000-4000-8000-000000000002',
      payment_id: payments[1].id,
      sale_id: sales[1].id,
      amount: 500,
      created_at: isoDaysAgo(1)
    }
  ]

  const receipts = [
    {
      id: '43500000-0000-4000-8000-000000000001',
      payment_id: payments[0].id,
      receipt_number: 'ETC-RCPT-202611-000001',
      amount_snapshot: 760,
      method_snapshot: 'cash',
      shop_snapshot: { id: shops[0].id, name: shops[0].name, phone: shops[0].phone },
      issued_at: isoDaysAgo(0)
    },
    {
      id: '43500000-0000-4000-8000-000000000002',
      payment_id: payments[1].id,
      receipt_number: 'ETC-RCPT-202611-000002',
      amount_snapshot: 500,
      method_snapshot: 'upi',
      shop_snapshot: { id: shops[1].id, name: shops[1].name, phone: shops[1].phone },
      issued_at: isoDaysAgo(1)
    }
  ]

  const movements = [
    {
      id: '45000000-0000-4000-8000-000000000001',
      variant_id: variants[0].id,
      stock_bucket: 'saleable',
      movement_type: 'opening',
      cartons_delta: 400,
      source_type: 'opening',
      source_id: 'opening-500',
      occurred_at: isoDaysAgo(30),
      actor_id: users[0].id,
      reason: 'Opening stock'
    },
    {
      id: '45000000-0000-4000-8000-000000000002',
      variant_id: variants[1].id,
      stock_bucket: 'saleable',
      movement_type: 'opening',
      cartons_delta: 250,
      source_type: 'opening',
      source_id: 'opening-1l',
      occurred_at: isoDaysAgo(30),
      actor_id: users[0].id,
      reason: 'Opening stock'
    },
    {
      id: '45000000-0000-4000-8000-000000000003',
      variant_id: variants[0].id,
      stock_bucket: 'damaged',
      movement_type: 'adjustment',
      cartons_delta: 6,
      source_type: 'opening',
      source_id: 'damaged-500',
      occurred_at: isoDaysAgo(30),
      actor_id: users[0].id,
      reason: 'Damaged bottles found during count'
    },
    {
      id: '45000000-0000-4000-8000-000000000004',
      variant_id: variants[1].id,
      stock_bucket: 'damaged',
      movement_type: 'adjustment',
      cartons_delta: 2,
      source_type: 'opening',
      source_id: 'damaged-1l',
      occurred_at: isoDaysAgo(30),
      actor_id: users[0].id,
      reason: 'Damaged bottles found during count'
    },
    {
      id: '45000000-0000-4000-8000-000000000005',
      variant_id: variants[0].id,
      stock_bucket: 'saleable',
      movement_type: 'sale',
      cartons_delta: -2,
      source_type: 'sale',
      source_id: sales[0].id,
      occurred_at: isoDaysAgo(0),
      actor_id: users[2].id,
      reason: 'Confirmed sale'
    },
    {
      id: '45000000-0000-4000-8000-000000000006',
      variant_id: variants[1].id,
      stock_bucket: 'saleable',
      movement_type: 'sale',
      cartons_delta: -1,
      source_type: 'sale',
      source_id: sales[0].id,
      occurred_at: isoDaysAgo(0),
      actor_id: users[2].id,
      reason: 'Confirmed sale'
    },
    {
      id: '45000000-0000-4000-8000-000000000007',
      variant_id: variants[1].id,
      stock_bucket: 'saleable',
      movement_type: 'sale',
      cartons_delta: -4,
      source_type: 'sale',
      source_id: sales[1].id,
      occurred_at: isoDaysAgo(1),
      actor_id: users[2].id,
      reason: 'Confirmed credit sale'
    }
  ]

  const ledger = [
    {
      id: '47000000-0000-4000-8000-000000000001',
      shop_id: shops[0].id,
      sale_id: sales[0].id,
      payment_allocation_id: null,
      return_request_id: null,
      entry_type: 'sale_debit',
      amount: 760,
      entry_date: today,
      created_by: users[2].id,
      created_at: isoDaysAgo(0)
    },
    {
      id: '47000000-0000-4000-8000-000000000002',
      shop_id: shops[0].id,
      sale_id: null,
      payment_allocation_id: allocations[0].id,
      return_request_id: null,
      entry_type: 'payment_credit',
      amount: 760,
      entry_date: today,
      created_by: users[0].id,
      created_at: isoDaysAgo(0)
    },
    {
      id: '47000000-0000-4000-8000-000000000003',
      shop_id: shops[1].id,
      sale_id: sales[1].id,
      payment_allocation_id: null,
      return_request_id: null,
      entry_type: 'sale_debit',
      amount: 1200,
      entry_date: yesterday,
      created_by: users[2].id,
      created_at: isoDaysAgo(1)
    },
    {
      id: '47000000-0000-4000-8000-000000000004',
      shop_id: shops[1].id,
      sale_id: null,
      payment_allocation_id: allocations[1].id,
      return_request_id: null,
      entry_type: 'payment_credit',
      amount: 500,
      entry_date: yesterday,
      created_by: users[1].id,
      created_at: isoDaysAgo(1)
    }
  ]

  const returns = [
    {
      id: '48000000-0000-4000-8000-000000000001',
      sale_id: sales[1].id,
      shop_id: shops[1].id,
      submitted_by: users[2].id,
      status: 'submitted',
      reason: 'One carton was damaged in transit.',
      submitted_at: isoDaysAgo(0),
      reviewed_by: null,
      reviewed_at: null,
      review_reason: null,
      lines: [
        {
          id: '48100000-0000-4000-8000-000000000001',
          sale_line_id: sale2Line.id,
          cartons: 1,
          condition: 'damaged',
          approved_cartons: 0
        }
      ]
    }
  ]

  const expenses = [
    {
      id: '49000000-0000-4000-8000-000000000001',
      claim_reference: '49100000-0000-4000-8000-000000000001',
      submitted_by: users[2].id,
      expense_date: today,
      category: 'Transport',
      description: 'Auto fare to Sunrise Mart',
      amount: 150,
      status: 'submitted',
      reviewed_by: null,
      reviewed_at: null,
      review_reason: null,
      paid_at: null,
      paid_by: null,
      created_at: isoDaysAgo(0)
    },
    {
      id: '49000000-0000-4000-8000-000000000002',
      claim_reference: '49100000-0000-4000-8000-000000000002',
      submitted_by: users[1].id,
      expense_date: yesterday,
      category: 'Fuel',
      description: 'Delivery van fuel',
      amount: 800,
      status: 'approved',
      reviewed_by: users[0].id,
      reviewed_at: isoDaysAgo(1),
      review_reason: null,
      paid_at: null,
      paid_by: null,
      created_at: isoDaysAgo(1)
    },
    {
      id: '49000000-0000-4000-8000-000000000003',
      claim_reference: '49100000-0000-4000-8000-000000000003',
      submitted_by: users[1].id,
      expense_date: threeDaysAgo,
      category: 'Packaging',
      description: 'Carton tape and labels',
      amount: 300,
      status: 'paid',
      reviewed_by: users[0].id,
      reviewed_at: isoDaysAgo(3),
      review_reason: null,
      paid_at: isoDaysAgo(2),
      paid_by: users[0].id,
      created_at: isoDaysAgo(3)
    }
  ]

  return {
    meta: { version: 1, invoiceSeq: 2, receiptSeq: 2 },
    users,
    shops,
    shopSalespeople,
    products,
    variants,
    defaultPrices,
    shopPrices,
    credit: { blocked: false, reason: '', changed_at: isoDaysAgo(30) },
    settings: {
      business_name: 'Ethereal Co.',
      tagline: 'Pure by nature · Safe for life',
      address: 'Patna, Bihar, India',
      phone: '+91 99900 00000',
      email: 'hello@ethereal.co',
      gstin: '',
      invoice_prefix: 'ETC-INV'
    },
    sales,
    saleLines: [...sale1Lines, sale2Line, sale3Line],
    invoices,
    payments,
    allocations,
    receipts,
    movements,
    returns,
    expenses,
    ledger,
    audit: [],
    visits: []
  }
}
