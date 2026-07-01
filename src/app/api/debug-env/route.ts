import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';

export async function GET() {
  const { data: page } = await db
    .from('pages')
    .select('html_content')
    .eq('id', 'b74e2c8e-01e2-4e31-a9c2-ddb77c4569f4')
    .single();

  const html = page?.html_content as string | null;

  // Return first 3000 chars so we can see the nav/logo section
  return NextResponse.json({ snippet: html?.slice(0, 3000) });
}
