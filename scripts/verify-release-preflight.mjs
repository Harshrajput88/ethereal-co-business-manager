import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const migrationDir = join(process.cwd(), 'supabase', 'migrations')
const archiveDir = join(process.cwd(), 'supabase', 'review', 'phase1')
const approved = new Map([
  ['20261118000100_business_schema.sql', '83887fdc69d08ba7d6fea72b7b0e287f3e17d0d30ee9149760b7335f679ab40d'],
  ['20261118000200_business_core_rpcs.sql', '2f23d236278c120f3172fa6442fb390874ac1bc144e3948001d6bb910bae9ff5'],
  ['20261118000300_business_sales_rpcs.sql', 'a9c619f438a06423cdc9182efcd329ec98ebe242d836d8428d23df389f386cca'],
  ['20261118000400_business_payment_rpcs.sql', '89401f07102d1a08abb80c27a8fbb4f05cd29eae1a3dab52578d7e1424a05144'],
  ['20261118000500_business_inventory_return_expense_rpcs.sql', 'f438a12d4e732053b0adaf19b2bb9e64af8db5e974020673456bc0954cd86626'],
  ['20261118000600_business_dashboard_team_rpcs.sql', '05022af79b4cd7b3d517da848c2b29294b5fdc50aaae9fcebdf5e7a1dc7e6051'],
  ['20261118000700_business_security_integrity_remediation.sql', '16d30d467602c9cb909511424dc0330065f920ee6b9da4d269beb13f12a3abc6'],
  ['20261118000800_controlled_owner_bootstrap.sql', '03a0f3b4c73331532bf027260e3ddca570fcdf327d0382777aa3e3162be45e98'],
  ['20261118000900_revoke_public_rls_auto_enable.sql', '8bbaed3624146df4dc78da915fae0eab5540fb23608dd13f6dbd1932c527e9cd']
])
const historical = [
  '20261117000100_phase1_foundation.sql',
  '20261117000200_phase1_commerce_ledgers.sql'
]
const files = readdirSync(migrationDir).filter(name => name.endsWith('.sql'))
const archivedDrafts = readdirSync(archiveDir).filter(name => name.endsWith('.sql'))
assert.equal(approved.size, 9)
assert.deepEqual([...approved.keys()], [...approved.keys()].sort(), 'Release migrations must be ordered')
for (const name of historical) {
  assert.ok(archivedDrafts.includes(name), `Historical draft must remain archived: ${name}`)
  assert.ok(!files.includes(name), `Historical draft must never be in the active migration directory: ${name}`)
}
for (const [name, expected] of approved) {
  assert.ok(files.includes(name), `Missing release migration: ${name}`)
  const actual = createHash('sha256').update(readFileSync(join(migrationDir, name))).digest('hex')
  assert.equal(actual, expected, `Release SQL changed: ${name}; stop and re-review before staging`)
}
const unreviewed = files.filter(name => !approved.has(name) && !historical.includes(name))
assert.deepEqual(unreviewed, [], 'Unreviewed SQL migration found: do not deploy without review')
assert.deepEqual(files.sort(), [...approved.keys()].sort(), 'Active migration directory must contain exactly the nine approved files')
console.log('PASS: exact nine-file release SHA-256 manifest; historical drafts archived outside migrations; no unreviewed SQL')
console.log('This preflight is NOT staging-write authorization or a substitute for concurrency, security, or restore rehearsals.')
