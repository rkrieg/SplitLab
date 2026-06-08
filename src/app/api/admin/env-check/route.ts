import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

interface EnvVar {
  key: string;
  set: boolean;
  valid: boolean;
  hint?: string;
  redacted?: string;
}

function check(key: string, validator?: (v: string) => boolean, hint?: string): EnvVar {
  const val = process.env[key];
  if (!val) return { key, set: false, valid: false, hint: hint ?? 'Not set' };
  const valid = validator ? validator(val) : true;
  const redacted = val.length > 8 ? val.slice(0, 4) + '…' + val.slice(-4) : '***';
  return { key, set: true, valid, hint: valid ? undefined : hint, redacted };
}

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Live Supabase connectivity test
  let supabaseOk = false;
  let supabaseError: string | null = null;
  try {
    const { error } = await db.from('users').select('id', { count: 'exact', head: true });
    supabaseOk = !error;
    if (error) supabaseError = error.message;
  } catch (e) {
    supabaseError = e instanceof Error ? e.message : 'Unknown error';
  }

  const groups = {
    core: [
      check('NEXT_PUBLIC_SUPABASE_URL', (v) => v.startsWith('https://'), 'Must start with https://'),
      check('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
      check('SUPABASE_SERVICE_ROLE_KEY'),
      check('NEXTAUTH_SECRET', (v) => v.length >= 32, 'Should be at least 32 characters'),
      check('NEXT_PUBLIC_APP_URL', (v) => v.startsWith('https://'), 'Must start with https://'),
      check('APP_HOSTNAME'),
    ],
    storage: [
      check('SUPABASE_STORAGE_BUCKET'),
    ],
    email: [
      check('RESEND_API_KEY', (v) => v.startsWith('re_'), 'Should start with re_'),
      check('RESEND_FROM_EMAIL', (v) => v.includes('@'), 'Must be a valid email address'),
    ],
    ai: [
      check('ANTHROPIC_API_KEY', (v) => v.startsWith('sk-ant-'), 'Should start with sk-ant-'),
    ],
    stripe: [
      check('STRIPE_SECRET_KEY', (v) => v.startsWith('sk_'), 'Should start with sk_'),
      check('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', (v) => v.startsWith('pk_'), 'Should start with pk_'),
      check('STRIPE_WEBHOOK_SECRET', (v) => v.startsWith('whsec_'), 'Should start with whsec_'),
      check('STRIPE_PRICE_PRO', (v) => v.startsWith('price_'), 'Should start with price_'),
      check('STRIPE_PRICE_AGENCY', (v) => v.startsWith('price_'), 'Should start with price_'),
      check('STRIPE_PRICE_SCALE', (v) => v.startsWith('price_'), 'Should start with price_'),
    ],
    domains: [
      check('VERCEL_API_TOKEN'),
      check('VERCEL_PROJECT_ID'),
      check('CNAME_TARGET'),
      check('VERCEL_A_RECORD'),
    ],
    hubspot: [
      check('HUBSPOT_CLIENT_ID'),
      check('HUBSPOT_CLIENT_SECRET'),
      check('HUBSPOT_REDIRECT_URI', (v) => v.startsWith('https://'), 'Must start with https://'),
    ],
    optional: [
      check('CANONICAL_HOST'),
      check('BOOTSTRAP_ADMIN_EMAIL'),
      check('BOOTSTRAP_ADMIN_PASSWORD'),
      check('BOOTSTRAP_ADMIN_NAME'),
    ],
  };

  const allVars = Object.values(groups).flat();
  const summary = {
    total: allVars.length,
    set: allVars.filter((v) => v.set).length,
    valid: allVars.filter((v) => v.valid).length,
    missing: allVars.filter((v) => !v.set).map((v) => v.key),
    invalid: allVars.filter((v) => v.set && !v.valid).map((v) => v.key),
  };

  return NextResponse.json({
    supabase: { ok: supabaseOk, error: supabaseError },
    summary,
    groups,
  });
}
