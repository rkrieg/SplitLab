import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { uploadHtml } from '@/lib/storage';
import crypto from 'crypto';
import { z } from 'zod';

/** Redistribute weights equally across a test's non-archived variants (sums to 100). */
async function redistributeActiveWeights(testId: string) {
  const { data: active } = await db
    .from('test_variants')
    .select('id')
    .eq('test_id', testId)
    .is('archived_at', null)
    .order('created_at', { ascending: true });
  if (!active || active.length === 0) return;
  const equalWeight = Math.floor(100 / active.length);
  let remainder = 100 - equalWeight * active.length;
  for (const v of active) {
    const w = equalWeight + (remainder-- > 0 ? 1 : 0);
    await db.from('test_variants').update({ traffic_weight: w }).eq('id', v.id);
  }
}

const goalSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(['form_submit', 'button_click', 'url_reached', 'call_click']),
  selector: z.string().max(500).nullable().optional(),
  url_pattern: z.string().max(500).nullable().optional(),
  is_primary: z.boolean(),
  variant_id: z.string().uuid().nullable().optional(),
});

const weightSchema = z.object({
  id: z.string().uuid(),
  traffic_weight: z.number().int().min(0).max(100),
});

const variantUpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  redirect_url: z.string().url().nullable().optional(),
  proxy_mode: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  url_path: z.string().min(1).max(500).optional(),
  status: z.enum(['draft', 'active', 'paused', 'completed']).optional(),
  head_scripts: z.string().nullable().optional(),
  goals: z.array(goalSchema).optional(),
  weights: z.array(weightSchema).optional(),
  variant_updates: z.array(variantUpdateSchema).optional(),
  delete_variant_id: z.string().uuid().optional(),
  duplicate_variant_id: z.string().uuid().optional(),
  archive_variant_id: z.string().uuid().optional(),
  unarchive_variant_id: z.string().uuid().optional(),
});

// TODO (post-trial): Add ownership check — verify the test's workspace belongs to the
// requesting user before allowing GET/PATCH/DELETE. Currently any authenticated user
// can access any test by UUID. Low immediate risk (UUIDs are unguessable) but should
// be locked down the same way workspace routes are.

function fullTestSelect() {
  return '*, test_variants(*, pages(id, name)), conversion_goals(*)';
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await db
    .from('tests')
    .select(fullTestSelect())
    .eq('id', params.id)
    .single();

  if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: testMeta } = await db.from('tests').select('workspace_id, url_path, status').eq('id', params.id).single();
  if (!testMeta) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const wsRole = await resolveWorkspaceRole(testMeta.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const body = await request.json();
    const { goals, weights, variant_updates, delete_variant_id, duplicate_variant_id, archive_variant_id, unarchive_variant_id, ...testFields } = updateSchema.parse(body);

    // Block duplicate active url_path within the same workspace when this update
    // would result in an active test (activation or path change while active)
    const nextStatus = testFields.status ?? testMeta.status;
    const nextPath = testFields.url_path ?? testMeta.url_path;
    if (nextStatus === 'active' && (testFields.status !== undefined || testFields.url_path !== undefined)) {
      const { data: pathConflict } = await db
        .from('tests')
        .select('id, name')
        .eq('workspace_id', testMeta.workspace_id)
        .eq('url_path', nextPath)
        .eq('status', 'active')
        .neq('id', params.id)
        .limit(1)
        .maybeSingle();

      if (pathConflict) {
        return NextResponse.json(
          { error: `Another active test "${pathConflict.name}" is already running on path "${nextPath}". Pause it first.` },
          { status: 409 }
        );
      }
    }

    // Update test fields if any provided
    if (Object.keys(testFields).length > 0) {
      const { error } = await db
        .from('tests')
        .update(testFields)
        .eq('id', params.id);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Update variant weights if provided
    if (weights) {
      const totalWeight = weights.reduce((s, w) => s + w.traffic_weight, 0);
      if (totalWeight !== 100) {
        return NextResponse.json({ error: 'Weights must sum to 100' }, { status: 400 });
      }
      for (const w of weights) {
        const { error: wErr } = await db
          .from('test_variants')
          .update({ traffic_weight: w.traffic_weight })
          .eq('id', w.id)
          .eq('test_id', params.id);
        if (wErr) return NextResponse.json({ error: wErr.message }, { status: 500 });
      }
    }

    // Update variant fields (name, redirect_url, proxy_mode) if provided
    if (variant_updates) {
      // Fetch current redirect_urls so we can detect URL changes
      const variantIds = variant_updates.map((vu) => vu.id);
      const { data: currentVariants } = await db
        .from('test_variants')
        .select('id, redirect_url')
        .in('id', variantIds)
        .eq('test_id', params.id);
      const currentUrlMap = new Map((currentVariants ?? []).map((v) => [v.id, v.redirect_url]));

      const urlChangedIds: string[] = [];

      for (const vu of variant_updates) {
        const updateFields: Record<string, unknown> = {};
        if (vu.name !== undefined) updateFields.name = vu.name;
        if (vu.redirect_url !== undefined) updateFields.redirect_url = vu.redirect_url;
        if (vu.proxy_mode !== undefined) updateFields.proxy_mode = vu.proxy_mode;
        if (Object.keys(updateFields).length > 0) {
          const { error: vuErr } = await db
            .from('test_variants')
            .update(updateFields)
            .eq('id', vu.id)
            .eq('test_id', params.id);
          if (vuErr) return NextResponse.json({ error: vuErr.message }, { status: 500 });
        }

        // Track variants whose URL actually changed
        if (
          vu.redirect_url !== undefined &&
          (vu.redirect_url ?? '') !== (currentUrlMap.get(vu.id) ?? '')
        ) {
          urlChangedIds.push(vu.id);
        }
      }

      // Clear scan_results for any variant whose URL changed
      if (urlChangedIds.length > 0) {
        const { data: testRow } = await db
          .from('tests')
          .select('scan_results')
          .eq('id', params.id)
          .single();
        const existingScans = testRow?.scan_results as { variants?: { variant_id: string }[] } | null;
        if (existingScans?.variants?.some((v) => urlChangedIds.includes(v.variant_id))) {
          const pruned = { variants: existingScans.variants.filter((v) => !urlChangedIds.includes(v.variant_id)) };
          await db.from('tests').update({ scan_results: pruned }).eq('id', params.id);
        }
      }
    }

    // Delete variant if requested
    if (delete_variant_id) {
      const { data: allVariants } = await db
        .from('test_variants')
        .select('id, page_id')
        .eq('test_id', params.id);

      if (!allVariants || allVariants.length <= 1) {
        return NextResponse.json(
          { error: 'Cannot delete the last variant' },
          { status: 400 },
        );
      }

      const target = allVariants.find((v) => v.id === delete_variant_id);
      if (!target) {
        return NextResponse.json({ error: 'Variant not found' }, { status: 404 });
      }

      // Soft-delete the linked HTML page when no other variant still uses it
      // (matches whole-test delete; UTM rules live on the page and go with it)
      if (target.page_id) {
        const pageStillUsed = allVariants.some(
          (v) => v.id !== delete_variant_id && v.page_id === target.page_id,
        );
        if (!pageStillUsed) {
          await db
            .from('pages')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', target.page_id)
            .is('deleted_at', null);
        }
      }

      const { error: delErr } = await db
        .from('test_variants')
        .delete()
        .eq('id', delete_variant_id)
        .eq('test_id', params.id);
      if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

      // Remove deleted variant's entry from scan_results JSONB
      const { data: testRow } = await db
        .from('tests')
        .select('scan_results')
        .eq('id', params.id)
        .single();
      const existingScans = (testRow?.scan_results as { variants?: { variant_id: string }[] } | null);
      if (existingScans?.variants?.some(v => v.variant_id === delete_variant_id)) {
        const pruned = { variants: existingScans.variants.filter(v => v.variant_id !== delete_variant_id) };
        await db.from('tests').update({ scan_results: pruned }).eq('id', params.id);
      }

      // Redistribute weights equally among remaining variants
      const { data: remaining } = await db
        .from('test_variants')
        .select('id')
        .eq('test_id', params.id)
        .order('created_at', { ascending: true });

      if (remaining && remaining.length > 0) {
        const equalWeight = Math.floor(100 / remaining.length);
        let remainder = 100 - equalWeight * remaining.length;
        for (const v of remaining) {
          const w = equalWeight + (remainder-- > 0 ? 1 : 0);
          await db.from('test_variants').update({ traffic_weight: w }).eq('id', v.id);
        }
      }
    }

    // Archive a variant: pull it out of the live split (weight 0) but keep its
    // history. Remaining active variants absorb its traffic. A test must
    // always keep at least one active variant — same invariant as delete.
    if (archive_variant_id) {
      const { data: activeVariants } = await db
        .from('test_variants')
        .select('id')
        .eq('test_id', params.id)
        .is('archived_at', null);

      const remainingActive = (activeVariants ?? []).filter((v) => v.id !== archive_variant_id).length;
      if (remainingActive === 0) {
        return NextResponse.json(
          { error: 'Cannot archive the last active variant — a test must always have at least one live.' },
          { status: 400 },
        );
      }

      const { error } = await db
        .from('test_variants')
        .update({ archived_at: new Date().toISOString(), traffic_weight: 0 })
        .eq('id', archive_variant_id)
        .eq('test_id', params.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      await redistributeActiveWeights(params.id);
    }

    // Restore an archived variant back into the active split.
    if (unarchive_variant_id) {
      const { error } = await db
        .from('test_variants')
        .update({ archived_at: null })
        .eq('id', unarchive_variant_id)
        .eq('test_id', params.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      await redistributeActiveWeights(params.id);
    }

    // Duplicate a variant. HTML/page-backed variants get a fresh page + stored
    // HTML copy; redirect variants just copy the URL. New copy starts at weight
    // 0 so it doesn't disturb the current split until the user weights it.
    if (duplicate_variant_id) {
      const { data: src } = await db
        .from('test_variants')
        .select('name, redirect_url, page_id, proxy_mode')
        .eq('id', duplicate_variant_id)
        .eq('test_id', params.id)
        .single();

      if (src) {
        let newPageId: string | null = null;
        if (src.page_id) {
          const { data: srcPage } = await db
            .from('pages')
            .select('workspace_id, html_content')
            .eq('id', src.page_id)
            .single();
          if (srcPage?.html_content) {
            const fileName = `${srcPage.workspace_id}/${crypto.randomUUID()}.html`;
            const htmlUrl = await uploadHtml(fileName, srcPage.html_content);
            const { data: newPage } = await db
              .from('pages')
              .insert({
                workspace_id: srcPage.workspace_id,
                name: `${src.name} (copy)`,
                html_url: htmlUrl,
                html_content: srcPage.html_content,
              })
              .select('id')
              .single();
            newPageId = newPage?.id ?? null;
          }
        }

        const { error: dupErr } = await db.from('test_variants').insert({
          test_id: params.id,
          name: `${src.name} (copy)`,
          redirect_url: newPageId ? null : src.redirect_url,
          page_id: newPageId,
          proxy_mode: newPageId ? false : src.proxy_mode,
          traffic_weight: 0,
          is_control: false,
        });
        if (dupErr) return NextResponse.json({ error: dupErr.message }, { status: 500 });
      }
    }

    // Upsert goals — preserve existing UUIDs so historical events stay linked
    if (goals) {
      const incomingIds = goals.filter((g) => g.id).map((g) => g.id as string);

      // Delete goals removed by the user
      if (incomingIds.length > 0) {
        await db.from('conversion_goals')
          .delete()
          .eq('test_id', params.id)
          .not('id', 'in', `(${incomingIds.map((id) => `"${id}"`).join(',')})`);
      } else {
        await db.from('conversion_goals').delete().eq('test_id', params.id);
      }

      for (const g of goals) {
        if (g.id) {
          // Existing goal — update in place, UUID preserved
          const { error: uErr } = await db.from('conversion_goals')
            .update({ name: g.name, type: g.type, selector: g.selector || null, url_pattern: g.url_pattern || null, is_primary: g.is_primary, variant_id: g.variant_id ?? null })
            .eq('id', g.id)
            .eq('test_id', params.id);
          if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
        } else {
          // New goal — insert with fresh UUID
          const { error: iErr } = await db.from('conversion_goals')
            .insert({ test_id: params.id, name: g.name, type: g.type, selector: g.selector || null, url_pattern: g.url_pattern || null, is_primary: g.is_primary, variant_id: g.variant_id ?? null });
          if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 });
        }
      }
    }

    // Return full test with relations
    const { data: updated, error: fetchError } = await db
      .from('tests')
      .select(fullTestSelect())
      .eq('id', params.id)
      .single();

    if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: testMeta } = await db.from('tests').select('workspace_id').eq('id', params.id).single();
  if (!testMeta) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const wsRole = await resolveWorkspaceRole(testMeta.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Archive pages linked to this test's variants before deleting
  const { data: variants } = await db
    .from('test_variants')
    .select('page_id')
    .eq('test_id', params.id)
    .not('page_id', 'is', null);

  const pageIds = Array.from(new Set((variants || []).map((v) => v.page_id).filter(Boolean)));
  if (pageIds.length > 0) {
    await db.from('pages').update({ deleted_at: new Date().toISOString() }).in('id', pageIds);
  }

  const { error } = await db.from('tests').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
