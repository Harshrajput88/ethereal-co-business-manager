import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migrations = [
  '20261118000100_business_schema.sql',
  '20261118000200_business_core_rpcs.sql',
  '20261118000300_business_sales_rpcs.sql',
  '20261118000400_business_payment_rpcs.sql',
  '20261118000500_business_inventory_return_expense_rpcs.sql',
  '20261118000600_business_dashboard_team_rpcs.sql',
  '20261118000700_business_security_integrity_remediation.sql',
  '20261118000800_controlled_owner_bootstrap.sql',
  '20261118000900_revoke_public_rls_auto_enable.sql'
]

const actual = migrations.map((name) => {
  const content = readFileSync(join(root, 'supabase', 'migrations', name))
  const sha256 = createHash('sha256').update(content).digest('hex')
  return { name, sha256 }
})

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA || 'local-working-tree',
  migrations: actual
}, null, 2))
