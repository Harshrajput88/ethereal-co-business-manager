import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migrationsDir = join(root, 'supabase', 'migrations')

function splitSqlArguments(source) {
  const parts = []
  let current = ''
  let depth = 0
  let quote = false
  for (const char of source) {
    if (char === "'") quote = !quote
    if (!quote && char === '(') depth += 1
    if (!quote && char === ')') depth -= 1
    if (char === ',' && !quote && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function findClosingParen(source, openIndex) {
  let depth = 1
  let quote = false
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === "'" && source[index - 1] !== '\\') quote = !quote
    if (quote) continue
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (depth === 0) return index
  }
  return -1
}

function parseFunctionDefinitions(files) {
  const definitions = new Map()
  for (const file of files) {
    const source = readFileSync(join(migrationsDir, file), 'utf8')
    const pattern = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(api_[a-z0-9_]+)\s*\(/gi
    for (const match of source.matchAll(pattern)) {
      const openIndex = match.index + match[0].lastIndexOf('(')
      const closeIndex = findClosingParen(source, openIndex)
      if (closeIndex < 0) continue
      const argumentsSql = source.slice(openIndex + 1, closeIndex)
      const following = source.slice(closeIndex + 1)
      const returns = following.match(/^\s*RETURNS\s+([^\n]+)/i)?.[1]?.trim() || ''
      const signature = splitSqlArguments(argumentsSql).map(argument => {
        const parsed = argument.match(/^(p_[a-z0-9_]+)\s+([a-z0-9_.]+(?:\[\])?)/i)
        return parsed ? { name: parsed[1], type: parsed[2].toLowerCase() } : null
      })
      const bodyStart = following.indexOf('AS $function$')
      const bodyEnd = bodyStart >= 0 ? following.indexOf('$function$;', bodyStart + 12) : -1
      const body = bodyStart >= 0 && bodyEnd >= 0 ? following.slice(bodyStart, bodyEnd) : ''
      const argTypes = signature.map(argument => argument?.type || '').join(', ')
      const grantPattern = new RegExp(
        `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${match[1]}\\s*\\(\\s*${argTypes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)\\s+TO\\s+authenticated\\s*;`,
        'i'
      )
      const revokePattern = new RegExp(
        `REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${match[1]}\\s*\\(\\s*${argTypes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)\\s+FROM\\s+PUBLIC\\s*,\\s*anon(?:\\s*,\\s*authenticated)?\\s*;`,
        'i'
      )
      const authenticatedRevokedPattern = new RegExp(
        `REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${match[1]}\\s*\\(\\s*${argTypes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)\\s+FROM\\s+PUBLIC\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`,
        'i'
      )
      definitions.set(match[1], {
        name: match[1],
        file,
        line: source.slice(0, match.index).split('\n').length,
        signature,
        returns,
        body,
        source,
        authenticatedGrant: grantPattern.test(source),
        publicAnonRevoked: revokePattern.test(source),
        authenticatedRevoked: authenticatedRevokedPattern.test(source),
        sqlSignature: `${match[1]}(${signature.map(argument => `${argument.name} ${argument.type}`).join(', ')})`
      })
    }
  }
  return definitions
}

function parseFrontendCalls() {
  const source = readFileSync(join(root, 'src', 'lib', 'remoteBackend.js'), 'utf8')
  const calls = []
  const pattern = /rpc\('([^']+)'\s*(?:,\s*\{([\s\S]*?)\}\s*)?\)/g
  for (const match of source.matchAll(pattern)) {
    const args = [...(match[2] || '').matchAll(/\b(p_[a-z0-9_]+)\s*:/gi)].map(item => item[1])
    calls.push({ name: match[1], args, line: source.slice(0, match.index).split('\n').length })
  }
  return calls
}

function methodNameAt(source, index) {
  const before = source.slice(0, index)
  return [...before.matchAll(/async function ([a-zA-Z0-9_]+)\s*\(/g)].at(-1)?.[1] || ''
}

function findCallers(calls) {
  const files = []
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'App-backup.jsx') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(jsx?|mjs)$/.test(entry.name) && !path.endsWith('remoteBackend.js')) files.push(path)
    }
  }
  walk(join(root, 'src'))
  const callersByMethod = new Map()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\bapi\s*\.\s*([a-zA-Z0-9_]+)\s*\(/g)) {
      const callers = callersByMethod.get(match[1]) || new Set()
      callers.add(file.replace(`${root}\\`, '').replace(`${root}/`, '').replaceAll('\\', '/'))
      callersByMethod.set(match[1], callers)
    }
  }
  return calls.map(call => {
    const remoteSource = readFileSync(join(root, 'src', 'lib', 'remoteBackend.js'), 'utf8')
    const method = methodNameAt(remoteSource, remoteSource.indexOf(`rpc('${call.name}'`))
    return { ...call, method, callers: [...(callersByMethod.get(method) || [])] }
  })
}

export function auditRpcContracts() {
  const migrationFiles = readdirSync(migrationsDir)
    .filter(file => /^20261118.*\.sql$/.test(file))
    .sort()
  const definitions = parseFunctionDefinitions(migrationFiles)
  const calls = findCallers(parseFrontendCalls())
  const errors = []
  for (const call of calls) {
    const definition = definitions.get(call.name)
    if (!definition) {
      errors.push(`${call.name}: frontend call has no definition in the nine-file 20261118 release set`)
      continue
    }
    const expected = definition.signature.map(argument => argument?.name)
    if (expected.includes(null)) {
      errors.push(`${call.name}: SQL argument signature could not be parsed`)
    } else if (expected.join(',') !== call.args.join(',')) {
      errors.push(`${call.name}: frontend args [${call.args.join(', ')}] do not match SQL args [${expected.join(', ')}]`)
    }
    // Owner bootstrap is intentionally unavailable to browser roles after migration 008.
    // Every other frontend RPC must retain its exact authenticated EXECUTE grant.
    if (!definition.authenticatedGrant && !definition.authenticatedRevoked) {
      errors.push(`${call.name}: missing exact authenticated EXECUTE grant or explicit authenticated revoke`)
    }
    if (!definition.publicAnonRevoked) errors.push(`${call.name}: missing exact PUBLIC/anon EXECUTE revoke`)
  }
  for (const definition of definitions.values()) {
    if (!definition.publicAnonRevoked) {
      errors.push(`${definition.name}: PUBLIC/anon execution is not explicitly revoked`)
    }
  }
  return { migrationFiles, definitions, calls, errors }
}
