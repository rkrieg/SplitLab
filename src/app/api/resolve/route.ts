import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';

function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function GET(request: NextRequest) {
  const headers = corsHeaders(request);
  const vid = request.nextUrl.searchParams.get('vid');
  if (!vid) {
    return NextResponse.json({ error: 'vid is required' }, { status: 400, headers });
  }

  const { data, error } = await db
    .from('test_variants')
    .select('id, test_id')
    .eq('id', vid)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Variant not found' }, { status: 404, headers });
  }

  return NextResponse.json({ testId: data.test_id, variantId: data.id }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { headers: corsHeaders(request) });
}
