import { writeFileSync } from 'node:fs'
import { auditRpcContracts } from './rpc-contracts.mjs'

const { calls, definitions, errors } = auditRpcContracts()
if (errors.length) throw new Error(errors.join('\n'))
const tick = String.fromCharCode(96)

const rows = calls.map(call => {
  const definition = definitions.get(call.name)
  const source = definition.body
  const returnKeys = [...source.matchAll(/'([a-z][a-z0-9_]*)'\s*,/gi)]
    .map(match => match[1])
    .filter((key, index, keys) => keys.indexOf(key) === index)
  const roleRules = []
  if (/api_role\(\)/i.test(source)) roleRules.push('Requires an active/approved profile (`api_role()`); null role receives null/empty result or is rejected.')
  if (/api_is_admin\(\)/i.test(source)) roleRules.push('Owner/Admin checks are enforced in SQL for privileged operations.')
  if (/api_is_assigned\(/i.test(source)) roleRules.push('SQL scopes records/actions to assigned shops where applicable.')
  if (/auth\.uid\(\)/i.test(source)) roleRules.push('Actor identity comes from `auth.uid()`, not a client-supplied actor.')
  if (!roleRules.length) roleRules.push('See function body: role/assignment checks are SQL-enforced; not inferred from UI.')
  const callers = call.callers.length ? call.callers.join(', ') : 'Remote backend method; no page call found statically'
  const expectedShape = definition.returns.toLowerCase() === 'jsonb'
    ? returnKeys.length
      ? `JSONB; object/list payload fields: ${returnKeys.map(key => `${tick}${key}${tick}`).join(', ')}`
      : 'JSONB; inspect function body for scalar/null/list response'
    : `${definition.returns}; inspect function body for exact row shape`

  return [
    `| ${tick}${call.name}${tick} | ${callers.split(', ').map(caller => `${tick}${caller}${tick}`).join(', ')} | ${tick}${call.args.join(', ') || '—'}${tick} | ${tick}${definition.sqlSignature}${tick} → ${tick}${definition.returns}${tick} | ${expectedShape} | ${roleRules.join(' ')} | ${tick}authenticated${tick} EXECUTE; PUBLIC/anon revoked | ${tick}${definition.file}:${definition.line}${tick} | MATCH |`
  ].join('')
})
const frontendNames = new Set(calls.map(call => call.name))
const internalRows = [...definitions.values()]
  .filter(definition => !frontendNames.has(definition.name))
  .map(definition => {
    const access = definition.authenticatedGrant
      ? 'Authenticated EXECUTE (policy/helper function); PUBLIC/anon revoked.'
      : definition.authenticatedRevoked
        ? 'PUBLIC/anon/authenticated revoked; internal-only.'
        : 'PUBLIC/anon revoked; inspect explicit ACL before deployment.'
    return `| \`${definition.sqlSignature}\` | \`${definition.returns}\` | \`${definition.file}:${definition.line}\` | ${access} | No frontend RPC caller; helper/trigger only. |`
  })

const doc = `# Supabase frontend RPC inventory

Generated from the centralized remote adapter and the six additive migrations. The SQL line is the authoritative function declaration/body. Payload field names are harvested from the function's JSON builders; branches may return null, empty JSON arrays, or error exceptions as documented in the body.

**Scope:** Every literal RPC call in ${tick}src/lib/remoteBackend.js${tick} used by the pages Overview, Sales, Payments, Shops, Inventory, Returns, Expenses, Invoices, Reports, Team, Settings, Authentication, and Profile. All business RPC calls are centralized there. ${tick}App-backup.jsx${tick} is an untouched backup and is excluded. Direct Supabase Auth, profile SELECT, and Storage calls are not PostgreSQL RPCs and are separately noted below.

**Local audit result:** ${calls.length} frontend RPC calls; ${definitions.size} ${tick}api_*${tick} SQL definitions across six migrations; all frontend argument names/types matched and each called function has an exact authenticated EXECUTE grant plus PUBLIC/anon revoke. This is repository evidence only; it does not prove deployment to a remote project or current PostgREST schema cache.

| RPC | Frontend caller(s) | Frontend argument names | SQL definition and return type | Expected return structure | Role / authorization rules | EXECUTE rights | Migration presence | Signature |
|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## SQL API helpers and trigger functions not called by the frontend

These 11 definitions are included to make the migration surface complete. Eight are internal/trigger-only and explicitly revoked from authenticated; three authorization helpers are granted to authenticated for use in policies/functions, not invoked as frontend workflows. Every definition explicitly revokes PUBLIC/anon execution.

| SQL function signature | Returns | Migration definition | EXECUTE status | Frontend exposure |
|---|---|---|---|---|
${internalRows.join('\n')}

## Auth/profile calls that are not RPCs

| Operation | Frontend file | Backend object | Notes |
|---|---|---|---|
| Sign in, sign up, restore session, sign out, auth event subscription | ${tick}src/lib/remoteBackend.js${tick}; pages ${tick}src/pages/Auth.jsx${tick} and app shell | Supabase Auth endpoints | Auth connectivity is separately checked at ${tick}/auth/v1/health${tick}. |
| Load current profile | ${tick}src/lib/remoteBackend.js${tick}; app shell and profile/team screens | ${tick}public.profiles${tick} SELECT by user id | Depends on existing profile RLS/read grants; not changed by these business migrations. |
| Upload profile image | ${tick}src/lib/remoteBackend.js${tick}; ${tick}src/pages/Profile.jsx${tick} | Storage bucket ${tick}profile-picture${tick} | Requires existing bucket/object policies; no Storage changes are included. |

## Findings for reported calls

- ${tick}api_credit_status()${tick} is declared parameterless and returns JSONB; frontend sends no arguments. It is revoked from PUBLIC/anon and granted to authenticated.
- ${tick}api_sales_list(p_from date, p_to date, p_limit integer)${tick} returns JSONB; frontend sends exactly ${tick}p_from${tick}, ${tick}p_to${tick}, and ${tick}p_limit${tick} (including nullable date values). Exact authenticated grant exists.
- ${tick}api_payments_list(p_from date, p_to date, p_limit integer)${tick} returns JSONB; frontend sends exactly ${tick}p_from${tick}, ${tick}p_to${tick}, and ${tick}p_limit${tick}. Exact authenticated grant exists.
- No duplicate function or corrective SQL was added: the checked-in signatures and grants already match. A remote “not found in schema cache” is therefore consistent with missing/unapplied migrations, wrong project URL, stale PostgREST schema cache, or a combination. These possibilities cannot be distinguished without approved read-only remote metadata access.

## Deployment sequence (owner approval required)

1. Do not run any SQL against staging/production as part of this code change. First make an owner-approved, read-only metadata inventory of the intended isolated Supabase project: ${tick}current_database()${tick}/project ref, migration history, ${tick}pg_proc${tick} signatures/argument names, ${tick}proacl${tick} grants, profile/Auth trigger objects, existing policies, and Storage buckets/policies. Never expose secrets or profile/user data.
2. Reconcile existing objects and migration history with all six files: ${tick}20261118000100_business_schema.sql${tick} through ${tick}20261118000600_business_dashboard_team_rpcs.sql${tick}. Do not blindly run the Phase 1 draft files or replace existing profiles, Auth triggers, users, or Storage objects. Resolve object collisions and get owner/security review before applying.
3. Take and verify a project backup; rehearse the reconciled migration set on an isolated non-production project. Apply in numeric order using the approved Supabase migration workflow. Verify RLS, function owners/${tick}search_path${tick}, exact argument names, authenticated grants, and role behavior after each migration.
4. Reload the PostgREST schema cache after all DDL: execute ${tick}NOTIFY pgrst, 'reload schema';${tick} in the approved project SQL editor (or the Supabase-supported schema reload mechanism). This notification alone does not create missing functions or grant permissions.
5. Verify from the client using an approved authenticated test account: call ${tick}api_credit_status${tick}, date-filtered sales/payments, then every other inventory-listed API for the corresponding role. Confirm the project URL/ref is the intended target, inspect browser network responses, and ensure no silent demo fallback.
6. Only after owner acceptance should the same reviewed package be promoted through the project's approved release process with a rollback plan. Cloud deployment remains unverified by this audit.

## Browser page coverage

The audit must record Playwright coverage for each listed screen. Local demo verifies UI workflows only; it does not validate the deployed SQL API. See the audit PDF for the exact run/results and any runtime/network limitations.
`

writeFileSync('docs/SUPABASE_RPC_INVENTORY.md', doc)
console.log(`Wrote docs/SUPABASE_RPC_INVENTORY.md (${calls.length} RPC calls)`)
