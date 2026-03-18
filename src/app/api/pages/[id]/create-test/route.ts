import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'admin' && session.user.role !== 'manager')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pageId = params.id;

  const { data: page, error } = await db
    .from('pages')
    .select('*')
    .eq('id', pageId)
    .single();

  if (error || !page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  if (!page.published_url) {
    return NextResponse.json({ error: 'Page must be published first' }, { status: 400 });
  }

  // Create a test in the workspace
  const testId = crypto.randomUUID();
  const { error: testErr } = await db.from('tests').insert({
    id: testId,
    workspace_id: page.workspace_id,
    name: `A/B Test: ${page.name}`,
    url_path: `/${pageId}`,
    status: 'draft',
  });

  if (testErr) {
    return NextResponse.json({ error: testErr.message }, { status: 500 });
  }

  // Add published page as control variant
  const { error: variantErr } = await db.from('test_variants').insert({
    test_id: testId,
    name: 'Control (AI Page)',
    page_id: pageId,
    traffic_weight: 100,
    is_control: true,
  });

  if (variantErr) {
    return NextResponse.json({ error: variantErr.message }, { status: 500 });
  }

  return NextResponse.json({
    test_id: testId,
    page_id: pageId,
  });
}
