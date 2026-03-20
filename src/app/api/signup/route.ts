import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const signupSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const data = signupSchema.parse(body);

    const { data: existing } = await db
      .from('users')
      .select('id')
      .eq('email', data.email.toLowerCase())
      .single();

    if (existing) {
      return NextResponse.json(
        { error: 'An account with this email already exists' },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    const { data: user, error } = await db
      .from('users')
      .insert({
        name: data.name,
        email: data.email.toLowerCase(),
        password_hash: passwordHash,
        role: 'viewer',
      })
      .select('id, name, email, role, status, created_at')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(user, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.errors[0]?.message || 'Validation failed' },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
