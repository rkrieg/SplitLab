import { NextResponse } from 'next/server';
export async function PUT() {
  return NextResponse.json({ error: 'This endpoint is being rebuilt.' }, { status: 503 });
}
