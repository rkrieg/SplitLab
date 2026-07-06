import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { signAffiliateToken, AFFILIATE_COOKIE, affiliateCookieOptions } from '@/lib/affiliate-auth';

export const dynamic = 'force-dynamic';

const schema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const data = schema.parse(await request.json());
    const email = data.email.toLowerCase();

    const { data: affiliate } = await db
      .from('affiliates')
      .select('id, password_hash, status')
      .eq('email', email)
      .single();

    // Generic error to avoid leaking which emails are registered
    if (!affiliate || !(await bcrypt.compare(data.password, affiliate.password_hash))) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }
    if (affiliate.status !== 'active') {
      return NextResponse.json({ error: 'This affiliate account is suspended' }, { status: 403 });
    }

    const res = NextResponse.json({ ok: true });
    res.cookies.set(AFFILIATE_COOKIE, signAffiliateToken(affiliate.id), affiliateCookieOptions);
    return res;
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
