import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { isStale, failBuild, staleMessage, type BuildStatus, type BuildKind } from '@/lib/page-builds';
import type { SSEEvent } from '@/lib/sse';

export const dynamic = 'force-dynamic';

/**
 * What a build is doing, for a tab that is watching it — or one that has just
 * come back to find out what happened while it was away.
 *
 * `after` is how many events the caller has already seen, so a poll returns
 * only what is new rather than the whole log each time.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { jobId: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: job } = await db
    .from('page_builds')
    .select('id, page_id, workspace_id, status, kind, events, result, error, created_at, updated_at')
    .eq('id', params.jobId)
    .single();

  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const row = job as {
    id: string;
    page_id: string;
    workspace_id: string;
    status: BuildStatus;
    kind: BuildKind;
    events: SSEEvent[] | null;
    result: unknown;
    error: string | null;
    created_at: string;
    updated_at: string;
  };

  const wsRole = await resolveWorkspaceRole(row.workspace_id, session.user.id, session.user.role);
  if (!wsRole) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // A build killed at the platform's duration cap cannot mark its own row, so
  // the verdict is reached here instead. Without this a build that died mid-run
  // sits at "running" forever — the same frozen spinner, one layer down.
  if (isStale(row)) {
    // No "try again" here: this string is also the stored reason, and the
    // builder appends its own "send it again" sentence when it shows it.
    // Worded from the row's kind — a user waiting on an edit should not be
    // told a "build" was stopped.
    const message = staleMessage(row.kind);
    await failBuild(row.id, message);
    return NextResponse.json({
      status: 'error',
      page_id: row.page_id,
      events: [],
      total_events: row.events?.length ?? 0,
      error: message,
    });
  }

  const after = Number(request.nextUrl.searchParams.get('after') ?? 0);
  const events = row.events ?? [];
  const from = Number.isFinite(after) && after > 0 ? after : 0;

  return NextResponse.json({
    status: row.status,
    page_id: row.page_id,
    events: events.slice(from),
    total_events: events.length,
    ...(row.result ? { result: row.result } : {}),
    ...(row.error ? { error: row.error } : {}),
  });
}
