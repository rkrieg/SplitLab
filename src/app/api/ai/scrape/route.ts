import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export async function POST() {
  return NextResponse.json({ error: 'This endpoint is being rebuilt.' }, { status: 503 });
}
