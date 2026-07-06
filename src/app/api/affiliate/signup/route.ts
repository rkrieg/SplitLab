import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { generateReferralCode } from '@/lib/affiliate';
import { signAffiliateToken, AFFILIATE_COOKIE, affiliateCookieOptions } from '@/lib/affiliate-auth';

export const dynamic = 'force-dynamic';

const schema = z.object({
  name:         z.string().min(1, 'Name is required').max(255),
  email:        z.string().email('Invalid email address'),
  password:     z.string().min(8, 'Password must be at least 8 characters'),
  payout_email: z.string().email().optional().or(z.literal('')),
});

export async function POST(request: NextRequest) {
  try {
    const data = schema.parse(await request.json());
    const email = data.email.toLowerCase();

    const { data: existing } = await db
      .from('affiliates')
      .select('id')
      .eq('email', email)
      .single();
    if (existing) {
      return NextResponse.json({ error: 'An affiliate account with this email already exists' }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    // Generate a unique referral code (retry on the rare collision)
    let referralCode = generateReferralCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: clash } = await db
        .from('affiliates')
        .select('id')
        .eq('referral_code', referralCode)
        .single();
      if (!clash) break;
      referralCode = generateReferralCode();
    }

    const { data: affiliate, error } = await db
      .from('affiliates')
      .insert({
        name:          data.name,
        email,
        password_hash: passwordHash,
        referral_code: referralCode,
        payout_email:  data.payout_email || null,
      } as never)
      .select('id')
      .single();

    if (error || !affiliate) {
      return NextResponse.json({ error: error?.message || 'Failed to create affiliate' }, { status: 500 });
    }

    const res = NextResponse.json({ ok: true, referral_code: referralCode }, { status: 201 });
    res.cookies.set(AFFILIATE_COOKIE, signAffiliateToken(affiliate.id), affiliateCookieOptions);
    return res;
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0]?.message || 'Validation failed' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
