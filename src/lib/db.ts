import { Pool } from 'pg';
import fsSync from 'fs';
import pathMod from 'path';
import type { TableSchema } from '@/types/database';

// Serialize plain objects/arrays to JSON strings so pg sends them as valid JSON
// for json/jsonb columns. Primitives, null, and Date are passed through unchanged.
function serializeForPg(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (val instanceof Date) return val;
  if (typeof val === 'object') return JSON.stringify(val);
  return val;
}

let _pool: Pool | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  return _pool;
}

// ─── Relationship schema ──────────────────────────────────────────────────────
// Describes how tables relate so nested selects can be built with subqueries.
type RelType = 'has_many' | 'belongs_to';
interface RelDef { table: string; fk: string; ref: string; type: RelType }

const RELATIONS: Record<string, Record<string, RelDef>> = {
  clients: {
    workspaces: { table: 'workspaces', fk: 'client_id', ref: 'id', type: 'has_many' },
  },
  workspaces: {
    clients: { table: 'clients', fk: 'id', ref: 'client_id', type: 'belongs_to' },
    domains: { table: 'domains', fk: 'workspace_id', ref: 'id', type: 'has_many' },
    tests: { table: 'tests', fk: 'workspace_id', ref: 'id', type: 'has_many' },
    pages: { table: 'pages', fk: 'workspace_id', ref: 'id', type: 'has_many' },
    scripts: { table: 'scripts', fk: 'workspace_id', ref: 'id', type: 'has_many' },
    workspace_members: { table: 'workspace_members', fk: 'workspace_id', ref: 'id', type: 'has_many' },
  },
  workspace_members: {
    users: { table: 'users', fk: 'id', ref: 'user_id', type: 'belongs_to' },
    workspaces: { table: 'workspaces', fk: 'id', ref: 'workspace_id', type: 'belongs_to' },
  },
  tests: {
    workspaces: { table: 'workspaces', fk: 'id', ref: 'workspace_id', type: 'belongs_to' },
    test_variants: { table: 'test_variants', fk: 'test_id', ref: 'id', type: 'has_many' },
    conversion_goals: { table: 'conversion_goals', fk: 'test_id', ref: 'id', type: 'has_many' },
  },
  test_variants: {
    tests: { table: 'tests', fk: 'id', ref: 'test_id', type: 'belongs_to' },
    pages: { table: 'pages', fk: 'id', ref: 'page_id', type: 'belongs_to' },
  },
  pages: {
    workspaces: { table: 'workspaces', fk: 'id', ref: 'workspace_id', type: 'belongs_to' },
  },
  variant_pages: {
    test_variants: { table: 'test_variants', fk: 'id', ref: 'variant_id', type: 'belongs_to' },
  },
  events: {
    tests: { table: 'tests', fk: 'id', ref: 'test_id', type: 'belongs_to' },
    test_variants: { table: 'test_variants', fk: 'id', ref: 'variant_id', type: 'belongs_to' },
    conversion_goals: { table: 'conversion_goals', fk: 'id', ref: 'goal_id', type: 'belongs_to' },
  },
  scripts: {
    workspaces: { table: 'workspaces', fk: 'id', ref: 'workspace_id', type: 'belongs_to' },
  },
  users: {},
  domains: {
    workspaces: { table: 'workspaces', fk: 'id', ref: 'workspace_id', type: 'belongs_to' },
  },
  conversion_goals: {
    tests: { table: 'tests', fk: 'id', ref: 'test_id', type: 'belongs_to' },
  },
  scraped_pages: {},
  page_performance: {
    pages: { table: 'pages', fk: 'id', ref: 'page_id', type: 'belongs_to' },
  },
  invite_tokens: {
    users: { table: 'users', fk: 'id', ref: 'user_id', type: 'belongs_to' },
  },
};

// ─── Select string parser ─────────────────────────────────────────────────────
interface SelectNode {
  columns: string[];
  isWildcard: boolean;
  relations: Record<string, SelectNode>;
}

function splitTopLevel(str: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; }
    else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseSelect(selectStr: string): SelectNode {
  const columns: string[] = [];
  const relations: Record<string, SelectNode> = {};
  for (const part of splitTopLevel(selectStr.trim())) {
    const p = part.trim();
    const pi = p.indexOf('(');
    if (pi === -1) {
      columns.push(p);
    } else {
      const relName = p.slice(0, pi).trim();
      const inner = p.slice(pi + 1, p.lastIndexOf(')')).trim();
      relations[relName] = parseSelect(inner);
    }
  }
  return { columns, isWildcard: columns.includes('*') || columns.length === 0, relations };
}

// ─── SQL builder for nested relation subqueries ───────────────────────────────
function buildRelSubquery(
  relTable: string,
  node: SelectNode,
  alias: string,
  parentAlias: string,
  rel: RelDef
): string {
  const tableRels = RELATIONS[relTable] || {};
  const nestedExprs: string[] = [];

  for (const [nestedName, nestedNode] of Object.entries(node.relations)) {
    const nestedRel = tableRels[nestedName];
    if (!nestedRel) continue;
    const nestedAlias = `${alias}_${nestedName}`;
    const nestedSql = buildRelSubquery(nestedRel.table, nestedNode, nestedAlias, alias, nestedRel);
    nestedExprs.push(`jsonb_build_object('${nestedName}', ${nestedSql})`);
  }

  // Build row expression (base columns + nested merges)
  let rowExpr: string;
  if (node.isWildcard) {
    if (nestedExprs.length > 0) {
      rowExpr = `to_jsonb(row_to_json("${alias}".*))`;
      for (const ne of nestedExprs) rowExpr = `(${rowExpr} || ${ne})`;
    } else {
      rowExpr = `row_to_json("${alias}".*)`;
    }
  } else {
    const colPairs = node.columns.map(c => `'${c}', "${alias}"."${c}"`).join(', ');
    const allPairs = [
      colPairs,
      ...Object.entries(node.relations).map(([n]) => {
        const nr = tableRels[n];
        if (!nr) return '';
        const na = `${alias}_${n}`;
        const ns = buildRelSubquery(nr.table, node.relations[n], na, alias, nr);
        return `'${n}', (${ns})`;
      }).filter(Boolean),
    ].filter(Boolean).join(', ');
    rowExpr = `json_build_object(${allPairs})`;
  }

  if (rel.type === 'has_many') {
    return `(SELECT COALESCE(json_agg(${rowExpr}), '[]'::json) FROM "${relTable}" "${alias}" WHERE "${alias}"."${rel.fk}" = "${parentAlias}"."${rel.ref}")`;
  } else {
    // belongs_to: WHERE child_table.fk = parent_table.ref
    // e.g. WHERE clients.id = workspaces.client_id
    return `(SELECT ${rowExpr} FROM "${relTable}" "${alias}" WHERE "${alias}"."${rel.fk}" = "${parentAlias}"."${rel.ref}" LIMIT 1)`;
  }
}

function buildMainSelectCols(table: string, node: SelectNode, mainAlias: string): string {
  const parts: string[] = [];
  if (node.isWildcard) parts.push(`"${mainAlias}".*`);
  else parts.push(...node.columns.map(c => `"${mainAlias}"."${c}"`));

  const tableRels = RELATIONS[table] || {};
  for (const [relName, relNode] of Object.entries(node.relations)) {
    const rel = tableRels[relName];
    if (!rel) continue;
    const alias = `_${relName}`;
    const subSql = buildRelSubquery(rel.table, relNode, alias, mainAlias, rel);
    parts.push(`${subSql} AS "${relName}"`);
  }
  return parts.join(', ');
}

// ─── QueryBuilder ─────────────────────────────────────────────────────────────
type DbResult<T = unknown> = { data: T | null; error: { message: string } | null; count?: number | null };

// TRow  = the shape of one row from this table
// TResult = the shape of the resolved `data` value:
//           defaults to TRow[] for normal queries,
//           becomes TRow after .single() / .maybeSingle()
class QueryBuilder<TRow = unknown, TResult = TRow[]> {
  private _table: string;
  private _selectStr = '*';
  private _selectOpts: { count?: 'exact'; head?: boolean } = {};
  private _conditions: string[] = [];
  private _params: unknown[] = [];
  private _orderBy: string[] = [];
  private _limitVal?: number;
  private _offsetVal?: number;
  private _single = false;
  private _maybeSingle = false;
  private _insertData?: Record<string, unknown> | Record<string, unknown>[];
  private _updateData?: Record<string, unknown>;
  private _upsertData?: Record<string, unknown>;
  private _upsertConflict?: string;
  private _isDelete = false;
  private _returnSelect?: string;

  constructor(table: string) { this._table = table; }

  private _nextParam(val: unknown): string {
    this._params.push(val);
    return `$${this._params.length}`;
  }

  select(cols = '*', opts: { count?: 'exact'; head?: boolean } = {}) {
    this._selectStr = cols;
    this._selectOpts = opts;
    return this;
  }
  eq(col: string, val: unknown)   { this._conditions.push(`"${col}" = ${this._nextParam(val)}`); return this; }
  neq(col: string, val: unknown)  { this._conditions.push(`"${col}" != ${this._nextParam(val)}`); return this; }
  gte(col: string, val: unknown)  { this._conditions.push(`"${col}" >= ${this._nextParam(val)}`); return this; }
  lte(col: string, val: unknown)  { this._conditions.push(`"${col}" <= ${this._nextParam(val)}`); return this; }
  gt(col: string, val: unknown)   { this._conditions.push(`"${col}" > ${this._nextParam(val)}`); return this; }
  lt(col: string, val: unknown)   { this._conditions.push(`"${col}" < ${this._nextParam(val)}`); return this; }
  is(col: string, val: unknown)   {
    this._conditions.push(val === null ? `"${col}" IS NULL` : `"${col}" IS ${val}`);
    return this;
  }
  in(col: string, vals: unknown[]) {
    const placeholders = vals.map(v => this._nextParam(v)).join(', ');
    this._conditions.push(`"${col}" IN (${placeholders})`);
    return this;
  }
  ilike(col: string, pattern: string) {
    this._conditions.push(`"${col}" ILIKE ${this._nextParam(pattern)}`);
    return this;
  }
  or(filter: string) {
    // Basic OR support: "col.eq.val,col2.eq.val2"
    const parts = filter.split(',').map(f => {
      const [col, op, ...rest] = f.trim().split('.');
      const val = rest.join('.');
      if (op === 'eq') return `"${col}" = ${this._nextParam(val)}`;
      if (op === 'ilike') return `"${col}" ILIKE ${this._nextParam(val)}`;
      if (op === 'neq') return `"${col}" != ${this._nextParam(val)}`;
      return `"${col}" = ${this._nextParam(val)}`;
    });
    this._conditions.push(`(${parts.join(' OR ')})`);
    return this;
  }
  not(col: string, op: string, val: unknown) {
    if (op === 'is') this._conditions.push(`"${col}" IS NOT ${val}`);
    else this._conditions.push(`NOT "${col}" = ${this._nextParam(val)}`);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this._orderBy.push(`"${col}" ${opts?.ascending === false ? 'DESC' : 'ASC'}`);
    return this;
  }
  limit(n: number) { this._limitVal = n; return this; }
  range(from: number, to: number) { this._offsetVal = from; this._limitVal = to - from + 1; return this; }
  single(): QueryBuilder<TRow, TRow> {
    this._single = true;
    this._limitVal = 1;
    return this as unknown as QueryBuilder<TRow, TRow>;
  }
  maybeSingle(): QueryBuilder<TRow, TRow> {
    this._maybeSingle = true;
    this._limitVal = 1;
    return this as unknown as QueryBuilder<TRow, TRow>;
  }

  insert(data: Record<string, unknown> | Record<string, unknown>[]) {
    this._insertData = data;
    return this;
  }
  update(data: Record<string, unknown>) { this._updateData = data; return this; }
  upsert(data: Record<string, unknown>, opts?: { onConflict?: string }) {
    this._upsertData = data;
    this._upsertConflict = opts?.onConflict;
    return this;
  }
  delete() { this._isDelete = true; return this; }

  // After insert/update/delete, optionally specify columns to return
  // (called as .select() with no args = RETURNING *)
  // We detect this via the returnSelect flag.

  then(
    resolve: (val: DbResult<TResult>) => unknown,
    reject: (err: unknown) => unknown
  ) {
    return this._execute().then(
      (result) => resolve(result as unknown as DbResult<TResult>),
      reject
    );
  }

  private async _execute(): Promise<DbResult<unknown>> {
    const pool = getPool();
    try {
      // ── INSERT ──
      if (this._insertData !== undefined) {
        const rows = Array.isArray(this._insertData) ? this._insertData : [this._insertData];
        const cols = Object.keys(rows[0]);
        const vals: unknown[] = [];
        const rowPlaceholders = rows.map(row => {
          const placeholders = cols.map(c => { vals.push(serializeForPg(row[c])); return `$${vals.length}`; });
          return `(${placeholders.join(', ')})`;
        });
        const hasRelations = this._selectStr.includes('(');
        // Simple column list with no relations → use in RETURNING directly
        const returning = (!hasRelations && this._selectStr && this._selectStr !== '*')
          ? `RETURNING ${this._selectStr.split(',').map(c => `"${c.trim()}"`).join(', ')}`
          : 'RETURNING *';
        const sql = `INSERT INTO "${this._table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES ${rowPlaceholders.join(', ')} ${returning}`;
        const res = await pool.query(sql, vals);
        // If relations requested, do a followup SELECT by id
        if (hasRelations && (this._single || this._maybeSingle)) {
          const insertedId = res.rows[0]?.id;
          if (insertedId) {
            const followup = new QueryBuilder(this._table);
            followup._selectStr = this._selectStr;
            followup._conditions.push(`"_t"."id" = ${followup._nextParam(insertedId)}`);
            followup._single = true;
            return followup._execute();
          }
        }
        const data = this._single || this._maybeSingle ? (res.rows[0] ?? null) : res.rows;
        return { data: data as unknown, error: null };
      }

      // ── UPSERT ──
      if (this._upsertData !== undefined) {
        const cols = Object.keys(this._upsertData);
        const vals: unknown[] = cols.map(c => serializeForPg(this._upsertData![c]));
        const placeholders = cols.map((_, i) => `$${i + 1}`);
        const conflictCol = this._upsertConflict || cols[0];
        const updates = cols.filter(c => c !== conflictCol).map((c, i) => `"${c}" = EXCLUDED."${c}"`);
        const returning = this._selectStr && this._selectStr !== '*'
          ? `RETURNING ${this._selectStr.split(',').map(c => `"${c.trim()}"`).join(', ')}`
          : 'RETURNING *';
        const sql = `INSERT INTO "${this._table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT ("${conflictCol}") DO UPDATE SET ${updates.join(', ')} ${returning}`;
        const res = await pool.query(sql, vals);
        const data = this._single || this._maybeSingle ? (res.rows[0] ?? null) : res.rows;
        return { data: data as unknown, error: null };
      }

      // ── UPDATE ──
      if (this._updateData !== undefined) {
        const params: unknown[] = [];
        const sets = Object.entries(this._updateData).map(([k, v]) => {
          params.push(serializeForPg(v)); return `"${k}" = $${params.length}`;
        });
        const where = this._conditions.length > 0
          ? `WHERE ${this._conditions.map(c => this._shiftCondition(c, params.length)).join(' AND ')}`
          : '';
        // Re-add condition params
        const allParams = [...params, ...this._params];
        const hasRelations = this._selectStr.includes('(');
        const returningCols = (!hasRelations && this._selectStr && this._selectStr !== '*')
          ? this._selectStr.split(',').map(c => `"${c.trim()}"`).join(', ')
          : '*';
        const sql = `UPDATE "${this._table}" SET ${sets.join(', ')} ${where} RETURNING ${returningCols}`;
        const res = await pool.query(sql, allParams);
        const data = this._single || this._maybeSingle ? (res.rows[0] ?? null) : res.rows;
        return { data: data as unknown, error: null };
      }

      // ── DELETE ──
      if (this._isDelete) {
        const where = this._conditions.length > 0 ? `WHERE ${this._conditions.join(' AND ')}` : '';
        const sql = `DELETE FROM "${this._table}" ${where}`;
        await pool.query(sql, this._params);
        return { data: null, error: null };
      }

      // ── SELECT ──
      const { count, head } = this._selectOpts;
      if (count === 'exact' && head) {
        const where = this._conditions.length > 0 ? `WHERE ${this._conditions.join(' AND ')}` : '';
        const sql = `SELECT COUNT(*) FROM "${this._table}" ${where}`;
        const res = await pool.query(sql, this._params);
        return { data: null, error: null, count: parseInt(res.rows[0].count, 10) };
      }

      const node = parseSelect(this._selectStr);
      const mainAlias = `_t`;
      const selectCols = buildMainSelectCols(this._table, node, mainAlias);
      const where = this._conditions.length > 0 ? `WHERE ${this._conditions.join(' AND ')}` : '';
      const orderBy = this._orderBy.length > 0 ? `ORDER BY ${this._orderBy.join(', ')}` : '';
      const limit = this._limitVal !== undefined ? `LIMIT ${this._limitVal}` : '';
      const offset = this._offsetVal !== undefined ? `OFFSET ${this._offsetVal}` : '';

      const sql = `SELECT ${selectCols} FROM "${this._table}" "${mainAlias}" ${where} ${orderBy} ${limit} ${offset}`.trim();
      const res = await pool.query(sql, this._params);

      if (this._single) {
        if (res.rows.length === 0) return { data: null, error: { message: 'Row not found' } };
        return { data: res.rows[0] as unknown, error: null };
      }
      if (this._maybeSingle) {
        return { data: (res.rows[0] ?? null) as unknown, error: null };
      }
      return { data: res.rows as unknown, error: null };

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[db] query error on "${this._table}":`, msg);
      return { data: null, error: { message: msg } };
    }
  }

  // When chaining UPDATE conditions, condition strings have already been built
  // with param indices from this._params. We need to shift them for the update
  // case where SET params come first.
  private _shiftCondition(condition: string, offset: number): string {
    return condition.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + offset}`);
  }
}

// ─── Storage shim (replaces Supabase Storage API) ─────────────────────────────
const STORAGE_DIR = pathMod.join(process.cwd(), '.html-storage');
const LOCAL_URL_PREFIX = '/__html_storage__/';

function storagePath(bucket: string, fileName: string) {
  return pathMod.join(STORAGE_DIR, bucket, fileName);
}

function makeStorageBucket(bucket: string) {
  return {
    upload: async (fileName: string, content: string, _opts?: unknown) => {
      const fp = storagePath(bucket, fileName);
      fsSync.mkdirSync(pathMod.dirname(fp), { recursive: true });
      fsSync.writeFileSync(fp, content, 'utf-8');
      return { data: { path: fileName }, error: null };
    },
    getPublicUrl: (fileName: string) => {
      return { data: { publicUrl: `${LOCAL_URL_PREFIX}${bucket}/${fileName}` } };
    },
    download: async (fileName: string) => {
      const fp = storagePath(bucket, fileName);
      if (!fsSync.existsSync(fp)) {
        return { data: null, error: { message: `File not found: ${fileName}` } };
      }
      const content = fsSync.readFileSync(fp, 'utf-8');
      // Return a Blob-like object with a text() method
      const blob = new Blob([content], { type: 'text/html; charset=utf-8' });
      return { data: blob, error: null };
    },
    remove: async (fileNames: string[]) => {
      for (const f of fileNames) {
        const fp = storagePath(bucket, f);
        if (fsSync.existsSync(fp)) fsSync.unlinkSync(fp);
      }
      return { error: null };
    },
  };
}

const storageShim = {
  from: (bucket: string) => makeStorageBucket(bucket),
  listBuckets: async () => ({ data: [], error: null }),
  createBucket: async (_name: string, _opts?: unknown) => ({ data: null, error: null }),
};

// ─── Typed from() with overloads ─────────────────────────────────────────────
// When the table name is a known key of TableSchema, TypeScript infers the
// correct row type automatically. Unknown table names fall back to
// QueryBuilder<Record<string, unknown>>.
function from<K extends keyof TableSchema>(table: K): QueryBuilder<TableSchema[K]>;
function from(table: string): QueryBuilder<Record<string, unknown>>;
function from(table: string): QueryBuilder<unknown> {
  return new QueryBuilder(table);
}

// ─── Raw query helper ─────────────────────────────────────────────────────────
export async function rawQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const pool = getPool();
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

// ─── Transaction helper ───────────────────────────────────────────────────────
// Runs callback inside an explicit BEGIN/COMMIT transaction.
// The callback receives a query function bound to the dedicated connection.
export async function withTransaction<T>(
  callback: (query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const query = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => {
      const res = await client.query(sql, params);
      return res.rows as R[];
    };
    const result = await callback(query);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Public db proxy ──────────────────────────────────────────────────────────
export const db = {
  from,
  storage: storageShim,
};
