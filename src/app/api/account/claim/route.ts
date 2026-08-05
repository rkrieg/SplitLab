import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { slugify } from '@/lib/utils';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const claimSchema = z.object({
  plan: z.enum(['free', 'pro', 'growth', 'agency', 'scale']),
});

/**
 * POST /api/account/claim — invitee (viewer) sets up their own SplitLab account.
 * Promotes viewer → manager, creates a default owned client, keeps invited memberships.
 * Paid plans: client is created on free until Stripe webhook sets the paid plan;
 * caller should start checkout after this returns.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { plan } = claimSchema.parse(body);
    const userId = session.user.id;

    const { data: user, error: userError } = await db
      .from('users')
      .select('id, name, role, plan')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Admins never claim; managers may be idempotent if they somehow have no owned client
    if (user.role === 'admin') {
      return NextResponse.json({ error: 'Admins cannot claim an account this way' }, { status: 403 });
    }

    if (user.role !== 'viewer' && user.role !== 'manager') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Only viewers (and managers repairing a missing owned client) may claim
    if (user.role === 'manager') {
      const { data: owned } = await db
        .from('clients')
        .select('id, name, slug, owner_id')
        .eq('owner_id', userId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (owned) {
        return NextResponse.json({
          alreadyClaimed: true,
          client: owned,
          role: 'manager',
          plan: user.plan ?? 'free',
          needsCheckout: plan !== 'free',
          checkoutPlan: plan !== 'free' ? plan : null,
        });
      }
    }

    // Promote viewer → manager. Paid plan is applied by Stripe webhook after checkout;
    // free is written now. Don't overwrite an existing paid plan on re-claim.
    const nextPlan = plan === 'free' ? 'free' : (user.plan && user.plan !== 'free' ? user.plan : 'free');

    const { error: promoteError } = await db
      .from('users')
      .update({ role: 'manager', plan: nextPlan })
      .eq('id', userId);

    if (promoteError) {
      return NextResponse.json({ error: promoteError.message }, { status: 500 });
    }

    // Race guard: another claim may have created an owned client
    const { data: raced } = await db
      .from('clients')
      .select('id, name, slug, owner_id')
      .eq('owner_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (raced) {
      return NextResponse.json({
        alreadyClaimed: true,
        client: raced,
        role: 'manager',
        plan: nextPlan,
        needsCheckout: plan !== 'free',
        checkoutPlan: plan !== 'free' ? plan : null,
      });
    }

    // Create default owned client (same pattern as signup)
    const firstName = (user.name || 'My').trim().split(' ')[0];
    const clientName = `${firstName}'s Account`;
    const clientSlug = slugify(clientName) + '-' + userId.slice(0, 8);

    const { data: existingSlug } = await db
      .from('clients')
      .select('id')
      .eq('slug', clientSlug)
      .maybeSingle();

    const slug = existingSlug
      ? `${clientSlug}-${Date.now().toString(36)}`
      : clientSlug;

    const { data: client, error: clientError } = await db
      .from('clients')
      .insert({
        name: clientName,
        slug,
        owner_id: userId,
      })
      .select('id, name, slug, owner_id')
      .single();

    if (clientError || !client) {
      return NextResponse.json(
        { error: clientError?.message ?? 'Failed to create client' },
        { status: 500 }
      );
    }

    const { data: workspace } = await db
      .from('workspaces')
      .insert({
        client_id: client.id,
        name: clientName,
        slug: 'default',
      })
      .select('id')
      .single();

    if (workspace) {
      await db.from('workspace_members').insert({
        workspace_id: workspace.id,
        user_id: userId,
        role: 'manager',
      });
    }

    return NextResponse.json({
      alreadyClaimed: false,
      client,
      role: 'manager',
      plan: nextPlan,
      needsCheckout: plan !== 'free',
      checkoutPlan: plan !== 'free' ? plan : null,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.errors[0]?.message || 'Validation failed' },
        { status: 400 }
      );
    }
    console.error('[account/claim]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
