import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';

export async function GET() {
  const { data: page } = await db
    .from('pages')
    .select('html_content')
    .eq('id', 'b74e2c8e-01e2-4e31-a9c2-ddb77c4569f4')
    .single();

  const html = page?.html_content as string | null;

  // Find all src/href/url() references to spot environment-specific URLs
  const urls = html?.match(/(src|href|url\()["'\s]*([^"'\s)]+)/g)?.slice(0, 30) ?? [];

  return NextResponse.json({ urls });
}
