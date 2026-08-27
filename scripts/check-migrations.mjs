#!/usr/bin/env node
/**
 * Reports which files in supabase/migrations/ are actually applied to the live DB.
 *
 * The ledger (supabase_migrations.schema_migrations, created by 066) records what was
 * run from here on, and is reported at the top. It is only a record of what someone
 * said they ran, though, so the real check is fingerprinting: reading the objects each
 * migration creates or drops, then asking the live schema whether they exist.
 *
 * Two things keep that honest:
 *  - statements are read in order, so a file that creates and then drops the same
 *    object is judged on its final state;
 *  - a signal that a LATER migration reverses (005 creates a table, 025 drops it) is
 *    marked superseded and excluded from scoring instead of counted as a failure.
 *
 *   node scripts/check-migrations.mjs           # summary
 *   node scripts/check-migrations.mjs --details # per-signal breakdown
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations')
const DETAILS = process.argv.includes('--details')

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  for (const file of ['.env.local', '.env']) {
    const p = path.join(ROOT, file)
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL=(.*)$/)
      // .env.local currently has a stray space inside the URL; strip all whitespace.
      if (m) return m[1].trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '')
    }
  }
  throw new Error('DATABASE_URL not found in env or .env.local')
}

function findPsql() {
  const candidates = [process.env.PSQL, 'psql']
  for (const v of ['17', '16', '15', '14']) {
    candidates.push('C:\\Program Files\\PostgreSQL\\' + v + '\\bin\\psql.exe')
  }
  for (const c of candidates) {
    if (!c) continue
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch {}
  }
  throw new Error('psql not found. Set PSQL=/path/to/psql.exe')
}

const INVENTORY_SQL = `
select json_build_object(
  'ledger', (select to_regclass('supabase_migrations.schema_migrations')::text),
  -- Public tables go in bare, anything outside it stays schema-qualified, so that
  -- 066's supabase_migrations.schema_migrations is checkable like any other table.
  'tables', (select coalesce(json_agg(case when schemaname = 'public' then tablename
                                           else schemaname || '.' || tablename end), '[]'::json)
             from pg_tables where schemaname in ('public', 'supabase_migrations')),
  'columns', (select coalesce(json_agg(table_name || '.' || column_name), '[]'::json)
              from information_schema.columns where table_schema='public'),
  'nullable', (select coalesce(json_object_agg(table_name || '.' || column_name, is_nullable = 'YES'), '{}'::json)
               from information_schema.columns where table_schema='public'),
  'indexes', (select coalesce(json_agg(indexname), '[]'::json) from pg_indexes where schemaname='public'),
  'indexdefs', (select coalesce(json_agg(indexdef), '[]'::json) from pg_indexes where schemaname='public'),
  'functions', (select coalesce(json_agg(distinct p.proname), '[]'::json)
                from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
  'triggers', (select coalesce(json_agg(distinct t.tgname), '[]'::json)
               from pg_trigger t where not t.tgisinternal),
  'types', (select coalesce(json_agg(distinct t.typname), '[]'::json)
            from pg_type t join pg_namespace n on n.oid=t.typnamespace
            where n.nspname='public' and t.typtype in ('e','d','c')),
  'constraints', (select coalesce(json_object_agg(c.conname, pg_get_constraintdef(c.oid)), '{}'::json)
                  from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public'),
  'funcdefs', (select coalesce(json_agg(pg_get_functiondef(p.oid)), '[]'::json)
               from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.prokind='f'),
  'policies', (select coalesce(json_agg(policyname), '[]'::json) from pg_policies where schemaname='public')
)::text;
`

function psqlQuery(sql) {
  try {
    return execFileSync(findPsql(), [loadDatabaseUrl(), '-At', '-c', sql], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (e) {
    // Never let the connection string (it carries the DB password) reach the log.
    throw new Error('psql failed: ' + String(e.stderr || '').trim().split(/\r?\n/)[0])
  }
}

function fetchInventory() {
  const inv = JSON.parse(psqlQuery(INVENTORY_SQL).trim())
  // Separate round trip: Postgres plans the whole statement, so a reference to the
  // ledger table would error out the inventory query on projects that never had it.
  inv.ledger_rows = inv.ledger
    ? psqlQuery('select version from supabase_migrations.schema_migrations order by version')
        .split(/\r?\n/)
        .filter(Boolean)
    : null
  return inv
}

// --- SQL reading -------------------------------------------------------------

const ident = '(?:"[^"]+"|[a-zA-Z_][\\w$]*)'
const clean = (s) => s.replace(/"/g, '').replace(/^public\./i, '').toLowerCase()
const re = (p) => new RegExp(p, 'gi')

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Split on semicolons, skipping ones inside quotes or $$ function bodies. */
function splitStatements(sql) {
  const out = []
  let buf = ''
  let i = 0
  while (i < sql.length) {
    const rest = sql.slice(i)
    const dollar = rest.match(/^\$([A-Za-z_]\w*)?\$/)
    if (dollar) {
      const tag = dollar[0]
      const end = sql.indexOf(tag, i + tag.length)
      const stop = end === -1 ? sql.length : end + tag.length
      buf += sql.slice(i, stop)
      i = stop
      continue
    }
    const ch = sql[i]
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2
          else break
        } else j++
      }
      buf += sql.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === ';') {
      out.push(buf)
      buf = ''
      i++
      continue
    }
    buf += ch
    i++
  }
  if (buf.trim()) out.push(buf)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Objects a single statement asserts into (or out of) existence, in order. */
function statementSignals(stmt) {
  const sig = []
  const add = (kind, name, expect = 'present', extra) => sig.push({ kind, name, expect, ...extra })
  let m

  if ((m = stmt.match(new RegExp(`^create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(${ident}(?:\\.${ident})?)`, 'i'))))
    add('table', clean(m[1]))
  if ((m = stmt.match(new RegExp(`^drop\\s+table\\s+(?:if\\s+exists\\s+)?(${ident}(?:\\.${ident})?)`, 'i'))))
    add('table', clean(m[1]), 'absent')

  if ((m = stmt.match(new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(${ident}(?:\\.${ident})?)([\\s\\S]*)$`, 'i')))) {
    const table = clean(m[1])
    const body = m[2]
    for (const c of body.matchAll(re(`add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?(${ident})`)))
      add('column', `${table}.${clean(c[1])}`)
    for (const c of body.matchAll(re(`drop\\s+column\\s+(?:if\\s+exists\\s+)?(${ident})`)))
      add('column', `${table}.${clean(c[1])}`, 'absent')
    for (const c of body.matchAll(re(`add\\s+constraint\\s+(${ident})`))) add('constraint', clean(c[1]))
    for (const c of body.matchAll(re(`drop\\s+constraint\\s+(?:if\\s+exists\\s+)?(${ident})`)))
      add('constraint', clean(c[1]), 'absent')
    for (const c of body.matchAll(re(`alter\\s+column\\s+(${ident})\\s+drop\\s+not\\s+null`)))
      add('nullable', `${table}.${clean(c[1])}`)
    for (const c of body.matchAll(re(`alter\\s+column\\s+(${ident})\\s+set\\s+not\\s+null`)))
      add('nullable', `${table}.${clean(c[1])}`, 'absent')
  }

  // Named index, then the unnamed `create index on t(cols)` form Postgres auto-names.
  if ((m = stmt.match(new RegExp(`^create\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?(${ident})\\s+on\\s+(${ident}(?:\\.${ident})?)`, 'i'))) && clean(m[1]) !== 'on')
    add('index', clean(m[1]), 'present', { on: clean(m[2]) })
  else if ((m = stmt.match(new RegExp(`^create\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?on\\s+(${ident}(?:\\.${ident})?)\\s*\\(([^)]*)\\)`, 'i'))))
    add('index_on', `${clean(m[1])}(${m[2].replace(/\s+/g, '').toLowerCase()})`)
  if ((m = stmt.match(new RegExp(`^drop\\s+index\\s+(?:if\\s+exists\\s+)?(${ident}(?:\\.${ident})?)`, 'i'))))
    add('index', clean(m[1]), 'absent')

  if ((m = stmt.match(new RegExp(`^create\\s+(?:or\\s+replace\\s+)?function\\s+(${ident}(?:\\.${ident})?)`, 'i'))))
    add('function', clean(m[1]))
  if ((m = stmt.match(new RegExp(`^drop\\s+function\\s+(?:if\\s+exists\\s+)?(${ident}(?:\\.${ident})?)`, 'i'))))
    add('function', clean(m[1]), 'absent')

  if ((m = stmt.match(new RegExp(`^create\\s+(?:or\\s+replace\\s+)?trigger\\s+(${ident})[\\s\\S]*?\\son\\s+(${ident}(?:\\.${ident})?)`, 'i'))))
    add('trigger', clean(m[1]), 'present', { on: clean(m[2]) })
  if ((m = stmt.match(new RegExp(`^drop\\s+trigger\\s+(?:if\\s+exists\\s+)?(${ident})`, 'i')))) add('trigger', clean(m[1]), 'absent')
  if ((m = stmt.match(new RegExp(`^create\\s+type\\s+(${ident}(?:\\.${ident})?)`, 'i')))) add('type', clean(m[1]))
  if ((m = stmt.match(new RegExp(`^create\\s+policy\\s+"?([^"\\n]+?)"?\\s+on\\s+(${ident}(?:\\.${ident})?)`, 'i'))))
    add('policy', m[1].trim().toLowerCase(), 'present', { on: clean(m[2]) })

  return sig
}

/** Signals for a whole file, later statements overriding earlier ones. */
function fileSignals(sql) {
  const byKey = new Map()
  for (const stmt of splitStatements(stripComments(sql))) {
    for (const s of statementSignals(stmt)) byKey.set(`${s.kind}::${s.name}`, s)
  }
  return [...byKey.values()]
}

// Existence cannot date a CREATE OR REPLACE body or a constraint re-added under its
// old name, so for those the live *definition* is compared instead of the mere name.
function definitionChecks(sql, inv) {
  const out = []
  // Both sides get comments stripped: pg_get_functiondef keeps the -- comments that
  // stripComments() already removed from the file copy, and they are not a difference.
  const norm = (s) => stripComments(s).replace(/\s+/g, ' ').trim().toLowerCase()

  for (const stmt of splitStatements(stripComments(sql))) {
    let m = stmt.match(new RegExp(`^create\\s+(?:or\\s+replace\\s+)?function\\s+(${ident})`, 'i'))
    if (m) {
      const name = clean(m[1])
      const body = stmt.match(/\$([A-Za-z_]\w*)?\$([\s\S]*?)\$\1?\$/)
      if (!body) continue
      const live = (inv.funcdefs || []).filter((d) => norm(d).includes(`function public.${name}(`))
      out.push({
        object: `function:${name}`,
        what: `function ${name} body`,
        ok: live.some((d) => norm(d).includes(norm(body[2]))),
        detail: live.length ? 'live body differs from this file' : 'no such function in DB',
      })
      continue
    }

    m = stmt.match(new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?${ident}[\\s\\S]*?add\\s+constraint\\s+(${ident})([\\s\\S]*)$`, 'i'))
    if (m) {
      const name = clean(m[1])
      const literals = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1])
      if (!literals.length) continue
      const live = inv.constraints[name] || inv.constraints[m[1].replace(/"/g, '')]
      const absent = live ? literals.filter((l) => !live.includes(`'${l}'`)) : literals
      out.push({
        object: `constraint:${name}`,
        what: `constraint ${name} allows [${literals.join(', ')}]`,
        ok: Boolean(live) && absent.length === 0,
        detail: live ? `live constraint is missing: ${absent.map((l) => `'${l}'`).join(', ')}` : 'constraint not in DB',
      })
    }
  }
  return out
}

// --- comparison --------------------------------------------------------------

function indexOnExists(inv, name) {
  const m = name.match(/^(.*)\((.*)\)$/)
  if (!m) return false
  const [, table, cols] = m
  return (inv.indexdefs || []).some((def) => {
    const d = def.toLowerCase()
    const dm = d.match(/on\s+(?:public\.)?("?[\w$]+"?)\s+using\s+\w+\s*\(([^)]*)\)/)
    return dm && clean(dm[1]) === table && dm[2].replace(/\s+/g, '') === cols
  })
}

function exists(inv, kind, name) {
  if (kind === 'index_on') return indexOnExists(inv, name)
  if (kind === 'nullable') return inv.nullable[name] === true
  const sets = {
    table: inv.tables,
    column: inv.columns,
    index: inv.indexes,
    function: inv.functions,
    trigger: inv.triggers,
    type: inv.types,
    policy: inv.policies,
    constraint: Object.keys(inv.constraints || {}),
  }
  return (sets[kind] || []).map((x) => String(x).toLowerCase()).includes(name)
}

/**
 * Once 066 has run, the ledger answers "what was applied?" directly. It is still only
 * a record of what someone *said* they ran, so the fingerprint pass below stays the
 * real check — this just reports where the two disagree.
 */
function reportLedger(inv, files) {
  if (!inv.ledger) {
    console.log('LEDGER: absent — run 066_migration_ledger.sql to start recording. Using schema fingerprinting.\n')
    return
  }
  const versionOf = (f) => (f.match(/^(\d+)_/) || [])[1]
  const onDisk = new Set(files.map(versionOf).filter(Boolean))
  const recorded = new Set(inv.ledger_rows)
  const unrecorded = [...onDisk].filter((v) => !recorded.has(v)).sort()
  const orphaned = [...recorded].filter((v) => !onDisk.has(v)).sort()

  console.log(`LEDGER: ${recorded.size} versions recorded (${[...recorded].sort()[0]}..${[...recorded].sort().pop()})`)
  if (unrecorded.length) console.log(`  files with NO ledger row (likely never run): ${unrecorded.join(', ')}`)
  if (orphaned.length) console.log(`  ledger rows with no file on this branch: ${orphaned.join(', ')}`)
  if (!unrecorded.length && !orphaned.length) console.log('  ledger and migrations folder agree.')
  console.log('')
}

function main() {
  const inv = fetchInventory()
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  const parsed = files.map((file) => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    return { file, sql, signals: fileSignals(sql), defs: definitionChecks(sql, inv) }
  })

  // A signal a later migration reverses proves nothing about this one, so drop it.
  // DROP TABLE also takes that table's indexes, triggers and policies with it.
  for (let i = 0; i < parsed.length; i++) {
    for (const s of parsed[i].signals) {
      const later = parsed.slice(i + 1)
      const reversed = later.find((f) =>
        f.signals.some((l) => l.kind === s.kind && l.name === s.name && l.expect !== s.expect)
      )
      const host = s.on || (['column', 'nullable'].includes(s.kind) ? s.name.split('.')[0] : null)
      const hostDropped =
        s.expect === 'present' && host
          ? later.find((f) => f.signals.some((l) => l.kind === 'table' && l.name === host && l.expect === 'absent'))
          : undefined
      s.supersededBy = (reversed || hostDropped)?.file
    }
  }

  // A later migration that redefines the same function or constraint is the one the
  // live definition should match, so earlier files stop being judged on it.
  for (let i = 0; i < parsed.length; i++) {
    const later = parsed.slice(i + 1)
    parsed[i].defs = parsed[i].defs.filter((d) => !later.some((f) => f.defs.some((l) => l.object === d.object)))
  }

  console.log(
    `DB objects seen: ${inv.tables.length} tables, ${inv.columns.length} columns, ` +
      `${inv.indexes.length} indexes, ${inv.functions.length} functions\n`
  )
  reportLedger(inv, files)

  const buckets = { MISSING: [], PARTIAL: [], STALE: [], UNKNOWN: [], APPLIED: [] }

  for (const entry of parsed) {
    const live = entry.signals.filter((s) => !s.supersededBy)
    const results = live.map((s) => ({ ...s, ok: exists(inv, s.kind, s.name) === (s.expect === 'present') }))
    if (!results.length) {
      const why = entry.signals.length
        ? `every object it touches was later reversed by ${[...new Set(entry.signals.map((s) => s.supersededBy))].join(', ')}`
        : 'no DDL signals this script can check (data-only migration?)'
      buckets.UNKNOWN.push({ ...entry, results, why })
      continue
    }
    const good = results.filter((r) => r.ok).length
    const staleDefs = entry.defs.filter((d) => !d.ok)
    const status =
      good !== results.length ? (good === 0 ? 'MISSING' : 'PARTIAL') : staleDefs.length ? 'STALE' : 'APPLIED'
    buckets[status].push({ ...entry, results })
  }

  const line = (e) => {
    const bad = (e.results || []).filter((r) => !r.ok)
    const tail = bad.length
      ? '  ->  ' + bad.map((r) => `${r.kind} ${r.name} ${r.expect === 'present' ? 'MISSING' : 'still present'}`).join(', ')
      : ''
    const stale = (e.defs || []).filter((d) => !d.ok)
    const staleTail = stale.length ? '  [!] ' + stale.map((d) => `${d.what}: ${d.detail}`).join('; ') : ''
    return `  ${e.file}${tail}${staleTail}${e.why ? '  ->  ' + e.why : ''}`
  }

  for (const key of ['MISSING', 'PARTIAL', 'STALE', 'UNKNOWN', 'APPLIED']) {
    console.log(`${key} (${buckets[key].length})`)
    for (const e of buckets[key]) {
      console.log(line(e))
      if (DETAILS) {
        for (const r of e.signals) {
          if (r.supersededBy) console.log(`      skip ${r.kind} ${r.name} (reversed by ${r.supersededBy})`)
        }
        for (const r of e.results) console.log(`      ${r.ok ? 'ok  ' : 'FAIL'} ${r.kind} ${r.name} (expect ${r.expect})`)
        for (const d of e.defs) console.log(`      ${d.ok ? 'ok  ' : 'FAIL'} ${d.what}`)
      }
    }
    console.log('')
  }
}

main()
