import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * One-time setup: adds invite_token and invite_expires_at columns to users table.
 * Safe to run multiple times — uses IF NOT EXISTS pattern via raw SQL.
 */
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  // Check if columns already exist by trying to select them
  const { error: checkErr } = await db
    .from('users')
    .select('invite_token')
    .limit(1);

  if (!checkErr) {
    return NextResponse.json({ message: 'Schema already up to date' });
  }

  // Columns don't exist — add them using individual inserts to a temp approach
  // Since we can't run raw SQL via PostgREST, we'll use the Supabase management API
  // Instead, let's use a workaround: create a simple RPC function

  // Actually, the simplest approach: just create the invite_tokens table via PostgREST
  // We can't alter tables via REST API. Let the admin run the SQL manually.
  return NextResponse.json({
    message: 'Please run the following SQL in Supabase SQL Editor (Dashboard > SQL Editor):',
    sql: `
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_invite_token ON users(invite_token) WHERE invite_token IS NOT NULL;
    `.trim(),
  });
}
