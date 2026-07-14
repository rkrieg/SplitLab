import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { uploadImage } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (session.user.role !== 'admin') {
    const ownerPlan = await resolveOwnerPlan(page.workspace_id);
    if (!PLAN_LIMITS[ownerPlan]?.aiPages) {
      return NextResponse.json(
        { error: 'AI page editing requires an Agency or Scale plan. Please upgrade to use this feature.', limitError: true },
        { status: 403 }
      );
    }
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) return NextResponse.json({ error: 'file is required' }, { status: 400 });

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: 'Unsupported image type. Use JPEG, PNG, WebP, GIF, or SVG.' }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'Image must be under 5MB' }, { status: 400 });
    }

    const ext = file.name.split('.').pop() ?? 'jpg';
    const arrayBuffer = await file.arrayBuffer();
    const url = await uploadImage(params.id, arrayBuffer, file.type, ext);

    return NextResponse.json({ url });
  } catch (err) {
    console.error('[pages/upload-chat-image]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
