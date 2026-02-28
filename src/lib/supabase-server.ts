import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _db: SupabaseClient | null = null;

// Server-only client (service role — bypasses RLS).
// Lazily initialized so builds don't fail without env vars.
export function getDb(): SupabaseClient {
  if (_db) return _db;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing Supabase environment variables. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    );
  }

  _db = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _db;
}

// Convenience proxy — behaves exactly like the old `db` singleton
// but creates the client on first access.
export const db = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getDb();
    const value = (client as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
