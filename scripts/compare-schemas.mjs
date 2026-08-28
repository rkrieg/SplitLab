#!/usr/bin/env node
/**
 * Diffs the schema of two databases (staging vs prod) so drift is visible.
 *
 * Read-only: it queries catalog tables only, never table data.
 *
 *   A_URL="postgresql://..." B_URL="postgresql://..." node scripts/compare-schemas.mjs
 *   node scripts/compare-schemas.mjs --a-label staging --b-label prod
 *
 * URLs come from A_URL / B_URL, else DATABASE_URL / PROD_DATABASE_URL in .env.local.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

/** Reads one key out of .env.local / .env. Commented-out lines are ignored. */
function envFileUrl(key) {
  for (const file of ['.env.local', '.env']) {
    const p = path.join(ROOT, file)
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      // Leading whitespace is tolerated (the file has picked some up more than once);
      // a leading # still means commented out, since \s does not match it.
      const m = line.match(new RegExp(`^\\s*${key}=(.*)$`))
      if (m) return m[1].trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '')
    }
  }
  return null
}

function findPsql() {
  const candidates = [process.env.PSQL, 'psql']
  for (const v of ['17', '16', '15', '14']) candidates.push(`C:\\Program Files\\PostgreSQL\\${v}\\bin\\psql.exe`)
  for (const c of candidates) {
    if (!c) continue
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch {}
  }
  throw new Error('psql not found. Set PSQL=/path/to/psql.exe')
}

// Everything that defines the shape of the schema. Names AND definitions, so a
// column that changed type or a function whose body drifted both show up.
const SCHEMA_SQL = `
select json_build_object(
  'ref', (select current_setting('server_version')),
  'tables', (select coalesce(json_agg(tablename order by tablename), '[]'::json)
             from pg_tables where schemaname='public'),
  'columns', (select coalesce(json_agg(
                table_name||'.'||column_name||' '||data_type||
                case when is_nullable='YES' then ' null' else ' not null' end
                order by table_name, column_name), '[]'::json)
              from information_schema.columns where table_schema='public'),
  'indexes', (select coalesce(json_agg(indexdef order by indexdef), '[]'::json)
              from pg_indexes where schemaname='public'),
  'constraints', (select coalesce(json_agg(c.conrelid::regclass::text||': '||pg_get_constraintdef(c.oid)
                    order by c.conrelid::regclass::text, pg_get_constraintdef(c.oid)), '[]'::json)
                  from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public'),
  'functions', (select coalesce(json_agg(p.proname||'/'||md5(pg_get_functiondef(p.oid)) order by p.proname), '[]'::json)
                from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.prokind='f'),
  'triggers', (select coalesce(json_agg(tgname order by tgname), '[]'::json)
               from pg_trigger where not tgisinternal),
  'has_ledger', (select to_regclass('supabase_migrations.schema_migrations') is not null)
)::text;
`

// Must be a separate round trip: Postgres plans the whole statement, so naming the
// ledger table inside the query above would error out on a DB that has never had it.
const LEDGER_SQL = 'select version from supabase_migrations.schema_migrations order by version'

function fetchSchema(url, label) {
  const run = (sql) => {
    try {
      return execFileSync(findPsql(), [url, '-At', '-c', sql], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch (e) {
      // Keep the connection string (and its password) out of the error.
      throw new Error(`${label}: psql failed — ` + String(e.stderr || e.message).trim().split(/\r?\n/)[0])
    }
  }
  const schema = JSON.parse(run(SCHEMA_SQL).trim())
  schema.ledger =
    schema.has_ledger === 't' || schema.has_ledger === true
      ? run(LEDGER_SQL).split(/\r?\n/).filter(Boolean)
      : ['(no ledger table)']
  return schema
}

function main() {
  const aLabel = arg('a-label', 'A')
  const bLabel = arg('b-label', 'B')
  const aUrl = process.env.A_URL || envFileUrl('DATABASE_URL')
  const bUrl = process.env.B_URL || envFileUrl('PROD_DATABASE_URL')

  if (!aUrl || !bUrl) {
    console.error(`Missing ${!aUrl ? 'side A' : 'side B'} connection string.\n`)
    console.error('  A (staging) <- A_URL, else DATABASE_URL in .env.local')
    console.error('  B (prod)    <- B_URL, else PROD_DATABASE_URL in .env.local\n')
    console.error('So add this line to .env.local:')
    console.error('  PROD_DATABASE_URL=postgresql://postgres.XXXX:PASSWORD@aws-0-....pooler.supabase.com:5432/postgres')
    process.exit(1)
  }

  const a = fetchSchema(aUrl, aLabel)
  const b = fetchSchema(bUrl, bLabel)

  const categories = ['tables', 'columns', 'indexes', 'constraints', 'functions', 'triggers', 'ledger']
  let differences = 0

  for (const cat of categories) {
    const av = new Set(a[cat] || [])
    const bv = new Set(b[cat] || [])
    const onlyA = [...av].filter((x) => !bv.has(x))
    const onlyB = [...bv].filter((x) => !av.has(x))
    if (!onlyA.length && !onlyB.length) {
      console.log(`${cat}: identical (${av.size})`)
      continue
    }
    differences += onlyA.length + onlyB.length
    console.log(`\n${cat.toUpperCase()} differs:`)
    for (const x of onlyA) console.log(`  only in ${aLabel}: ${x}`)
    for (const x of onlyB) console.log(`  only in ${bLabel}: ${x}`)
  }

  console.log(
    differences === 0
      ? `\nThe two schemas are identical.`
      : `\n${differences} difference(s). Anything "only in ${aLabel}" is a migration ${bLabel} has not had yet.`
  )
  process.exit(differences === 0 ? 0 : 1)
}

main()
