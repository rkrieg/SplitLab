import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
import { db } from '@/lib/supabase-server';
import bcrypt from 'bcryptjs';

/**
 * GET /api/bootstrap
 * Creates the first admin user if no users exist.
 * Remove or disable this route after initial setup.
 */
export async function GET() {
  const { count } = await db
    .from('users')
    .select('*', { count: 'exact', head: true });

  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { message: 'Bootstrap skipped — users already exist.' },
      { status: 200 }
    );
  }

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = process.env.BOOTSTRAP_ADMIN_NAME || 'Admin';

  if (!email || !password) {
    return NextResponse.json(
      { error: 'BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set' },
      { status: 400 }
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const { data, error } = await db
    .from('users')
    .insert({ name, email: email.toLowerCase(), password_hash: passwordHash, role: 'admin' })
    .select('id, name, email, role')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    message: 'Admin user created successfully. Please delete or disable this route.',
    user: data,
  });
}
