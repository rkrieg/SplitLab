import { db } from '@/lib/supabase-server';
import { savePageSkills } from '@/lib/skills/persistence';
import { updatePageDraftOrLive } from '@/lib/services/pages';
import { describeAssetPlacement } from '@/lib/asset-placement';
import type { SSEEvent } from '@/lib/sse';

/**
 * A page build that outlives the tab that asked for it.
 *
 * The build used to run inside the request the browser was streaming, and the
 * browser saved the result when it finished. Leaving the page therefore threw
 * the whole thing away. Now the route starts a row here, answers with its id,
 * and does the work in the background; the tab only reads this table.
 */

export type BuildDoneEvent = Extract<SSEEvent, { type: 'done' }>;

/** The finished event plus the chat line that goes with it. */
export type BuildResult = BuildDoneEvent & {
  assistant_reply: string;
  assistant_note?: string;
};

/**
 * 'saving' is the window between a build claiming its own job and the page
 * actually being written. It exists because claiming as 'done' first told the
 * watching tab "your page is ready" while pages.html_url was still null — and
 * if the save then threw, the failure had nowhere to land, because failBuild
 * only moves a build that is still in flight.
 */
export type BuildStatus = 'running' | 'saving' | 'done' | 'error';

/** Statuses that mean a build is still in flight and must not be duplicated. */
const LIVE_STATUSES: BuildStatus[] = ['running', 'saving'];

/**
 * How long a build may live before we call it dead.
 *
 * maxDuration on the build route is 800s and covers the background work too, so
 * nothing can still be running past this. This is the ceiling on a build's age;
 * BUILD_HEARTBEAT_MS below catches the ones that die long before reaching it.
 */
export const BUILD_MAX_MS = 800_000 + 60_000;

/**
 * How long a live build may go silent.
 *
 * The age ceiling above only catches a build that ran its full course. One
 * killed early — the function dropped, a deploy mid-run — would otherwise sit
 * at "running" for the whole 860s, during which findActiveBuild hands back the
 * corpse, a new build is refused as already_running, and a returning tab
 * reattaches to a spinner that will never move.
 *
 * Every event append bumps updated_at, and the longest legitimate quiet stretch
 * is a model call with nothing to report — well inside five minutes.
 */
export const BUILD_HEARTBEAT_MS = 300_000;

export function isStale(row: { created_at: string; updated_at?: string | null; status: BuildStatus }): boolean {
  if (!LIVE_STATUSES.includes(row.status)) return false;
  const now = Date.now();
  if (now - new Date(row.created_at).getTime() > BUILD_MAX_MS) return true;
  return !!row.updated_at && now - new Date(row.updated_at).getTime() > BUILD_HEARTBEAT_MS;
}

/**
 * The build already running for this page, if there is one.
 *
 * Used both to stop a second click starting a duplicate run, and to let a
 * returning tab find the build it walked away from.
 */
export async function findActiveBuild(
  pageId: string,
): Promise<{ id: string; status: BuildStatus; created_at: string; updated_at: string } | null> {
  const { data } = await db
    .from('page_builds')
    .select('id, status, created_at, updated_at')
    .eq('page_id', pageId)
    .in('status', LIVE_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1);

  const row = data?.[0] as
    | { id: string; status: BuildStatus; created_at: string; updated_at: string }
    | undefined;
  if (!row) return null;
  if (isStale(row)) {
    await failBuild(row.id, 'This build ran out of time and was stopped.');
    return null;
  }
  return row;
}

/**
 * Start a build, or join the one already going.
 *
 * The caller checks findActiveBuild first, but check-then-act loses a race two
 * tabs (or a double click) can genuinely run: both see nothing and both start.
 * A partial unique index on page_id over the live statuses settles it in the
 * database — the loser lands here on a duplicate-key error and joins instead.
 */
export async function startBuild(
  pageId: string,
  workspaceId: string,
): Promise<{ id: string; joined: boolean } | null> {
  const { data, error } = await db
    .from('page_builds')
    .insert({ page_id: pageId, workspace_id: workspaceId, status: 'running' })
    .select('id')
    .single();

  if (!error && data) return { id: (data as { id: string }).id, joined: false };

  // 23505 = unique_violation: another request started one between our check and
  // this insert.
  if (error?.code === '23505') {
    const existing = await findActiveBuild(pageId);
    if (existing) return { id: existing.id, joined: true };
  }

  console.error('[page-builds] could not start build', error?.message);
  return null;
}

/**
 * Batched, atomic append.
 *
 * Events are appended by a SQL function (`events || $1`) rather than read here
 * and written back, so overlapping appends cannot drop each other. They are
 * also batched — one real build emitted ~250 events, and a round trip each
 * would cost more than the work between them. Nothing is dropped, only grouped.
 */
export function createBuildEmitter(buildId: string) {
  let buffer: SSEEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  // Says "still here" on a fixed clock, so silence really does mean death.
  //
  // Progress events are emitted at <!-- STATUS --> markers, and the stretch
  // before the first one (the <head> and stylesheet the model writes up front)
  // is silent for a minute and a half on a real page — close enough to the
  // staleness threshold that a heavier style block would cross it. A build
  // wrongly called dead lets a retry start a second one against the same page,
  // which is a far worse outcome than a stuck spinner.
  const heartbeat = setInterval(() => {
    // Awaited inside an async IIFE, not `void`-ed: a supabase query builder is
    // a lazy thenable and sends nothing until something calls .then(), so
    // `void db.from(...)` builds a request and drops it. Silently. This ran as
    // dead code once already, and a heartbeat that does not beat is worse than
    // none — it makes the staleness check confident about a lie.
    void (async () => {
      const { error } = await db
        .from('page_builds')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', buildId)
        .eq('status', 'running');
      if (error) console.error('[page-builds] heartbeat failed', error.message);
    })();
  }, 30_000);

  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return chain;

    const batch = buffer;
    buffer = [];
    chain = chain.then(async () => {
      const { error } = await db.rpc('append_build_events', { p_build_id: buildId, p_events: batch });
      if (error) console.error('[page-builds] event append failed', error.message);
    });
    return chain;
  }

  return {
    stop() {
      clearInterval(heartbeat);
    },
    emit(event: SSEEvent) {
      buffer.push(event);
      if (buffer.length >= 25) {
        void flush();
        return;
      }
      if (!timer) timer = setTimeout(() => { void flush(); }, 1_000);
    },
    flush,
  };
}

export async function failBuild(buildId: string, message: string): Promise<void> {
  // Only a running build can fail. Without this guard a staleness check racing
  // a build that just finished would overwrite done + result with an error,
  // and which one won would come down to write order.
  const { error } = await db
    .from('page_builds')
    .update({ status: 'error', error: message, updated_at: new Date().toISOString() })
    .eq('id', buildId)
    .in('status', LIVE_STATUSES);
  if (error) console.error('[page-builds] could not record failure', error.message);
}

/**
 * The chat line that used to be written in the browser after the stream closed.
 *
 * It lives here now because the browser may be long gone by the time a build
 * finishes — and because a reattaching tab must read back the same sentence the
 * live one showed, rather than compose its own version of it.
 */
export function composeAssistantReply(done: BuildDoneEvent): { reply: string; note?: string } {
  const placementNote =
    typeof done.imported_assets === 'number' && typeof done.placed_assets === 'number'
      ? describeAssetPlacement({
          imported: done.imported_assets,
          placed: done.placed_assets,
          unusedNames: done.unused_asset_names ?? [],
        })
      : null;

  const tail =
    (done.broken_assets && done.broken_assets > 0
      ? ` ${done.broken_assets} image URL(s) couldn't be loaded and were left as they were.`
      : '') + (placementNote ? ` ${placementNote}` : '');

  const reply = done.unmet_requirements
    ? `Your page is built, but not everything landed — ${done.unmet_requirements}. Tell me to fix it and I'll take another pass.${tail}`
    : `Your page is ready! Click any text in the preview to edit it, or ask me to make changes.${tail}`;

  return { reply, ...(done.notes ? { note: done.notes } : {}) };
}

/**
 * Save the finished build against the page, then close the job.
 *
 * Everything here used to be a PATCH the browser sent after the stream closed —
 * the single point at which a whole build could be lost.
 */
/** updatePageDraftOrLive, with a throw turned into the same shape as a failure. */
async function saveOrFail(
  ...args: Parameters<typeof updatePageDraftOrLive>
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await updatePageDraftOrLive(...args);
    return res.ok ? { ok: true } : { ok: false, error: String(res.error) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function completeBuild(args: {
  buildId: string;
  pageId: string;
  done: BuildDoneEvent;
  userPrompt: string;
  history: { role: string; content: string; image_urls?: string[] }[];
  imageUrls: string[];
  skills: string[];
  style: string | null;
}): Promise<void> {
  const { buildId, pageId, done, userPrompt, history, imageUrls, skills, style } = args;
  const { reply, note } = composeAssistantReply(done);

  // Claim the job FIRST, but claim it as 'saving', not as 'done'.
  //
  // Claiming is what stops a build that has already been declared dead from
  // overwriting a page that now belongs to a newer run. Claiming as 'done' also
  // told the watching tab the page was ready while html_url was still null, and
  // left a failed save with nowhere to report itself. 'saving' claims the row
  // without making either promise.
  const { data: claimed, error: jobError } = await db
    .from('page_builds')
    .update({ status: 'saving', updated_at: new Date().toISOString() })
    .eq('id', buildId)
    .eq('status', 'running')
    .select('id');

  if (jobError) console.error('[page-builds] could not claim build', jobError.message);
  if (!claimed || claimed.length === 0) {
    console.error('[page-builds] build was already closed elsewhere; not writing the page', { buildId, pageId });
    return;
  }

  // Attachments belong to the turn that carried them — the last user entry.
  const historyWithImages =
    imageUrls.length > 0
      ? history.map((entry, i) =>
          i === history.length - 2 && entry.role === 'user' ? { ...entry, image_urls: imageUrls } : entry,
        )
      : history;

  // Through the service, not a bare update.
  //
  // Replacing a page's HTML is never just a column write: it clears
  // field_selectors_json, drops the page's personalization rules, and rescans
  // the linked test variant so UTM Personalization has elements to map. The
  // browser PATCH this replaced went through that path. A page created from
  // PagesClient already has a draft test with it as Control, so the variant is
  // linked before the first build finishes and the rescan is live from the
  // start — skipping it left scan_results empty with nothing to map.
  const { data: pageMeta } = await db
    .from('pages')
    .select('html_url, schema_json')
    .eq('id', pageId)
    .single();

  const saved = await saveOrFail(
    pageId,
    (pageMeta as { html_url: string | null; schema_json: Record<string, unknown> | null } | null) ??
      { html_url: null, schema_json: null },
    {
      prompt: userPrompt,
      slug: done.slug,
      html_url: done.html_url,
      schema_json: done.schema_json as Record<string, unknown> | undefined,
      conversation_json: [
        ...historyWithImages,
        { role: 'assistant', content: reply, ...(note ? { note } : {}) },
      ],
    },
  );

  // A save that failed must end as a failure. Reporting done over an unsaved
  // page is what sends the user back to "your last build didn't finish" after
  // being told it was ready.
  if (!saved.ok) {
    console.error('[page-builds] page not saved', saved.error);
    await failBuild(buildId, 'The page was built but could not be saved. Nothing is lost — try again.');
    return;
  }

  // Separate, non-fatal write — its columns arrive in migration 062, so a
  // missing one must not lose the build that just succeeded.
  await savePageSkills(pageId, { skills, style });

  const result: BuildResult = {
    ...done,
    assistant_reply: reply,
    ...(note ? { assistant_note: note } : {}),
  };
  const { error: doneError } = await db
    .from('page_builds')
    .update({ status: 'done', result, updated_at: new Date().toISOString() })
    .eq('id', buildId)
    .eq('status', 'saving');
  if (doneError) console.error('[page-builds] could not close build', doneError.message);
}
