import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function GET(request: NextRequest) {
  const vid = request.nextUrl.searchParams.get('vid');
  if (!vid) {
    return NextResponse.json({ error: 'vid is required' }, { status: 400, headers: CORS_HEADERS });
  }

  const { data, error } = await db
    .from('test_variants')
    .select('id, test_id')
    .eq('id', vid)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Variant not found' }, { status: 404, headers: CORS_HEADERS });
  }

  return NextResponse.json({ testId: data.test_id, variantId: data.id }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { headers: CORS_HEADERS });
}
