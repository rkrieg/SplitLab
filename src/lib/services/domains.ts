import { db } from '@/lib/supabase-server';
import { addDomainToVercel, removeDomainFromVercel, getDomainStatus } from '@/lib/vercel';
import { resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { CNAME_TARGET, VERCEL_A_RECORD } from '@/lib/constants';
import { logEvent } from '@/lib/log';
import { ok, fail, ServiceResult } from './types';

/**
 * Extracted from GET/POST/DELETE /api/workspaces/[id]/domains
 * (src/app/api/workspaces/[id]/domains/route.ts) so that route and MCP's
 * domain tools share one implementation — same pattern as pages.ts/tests.ts.
 *
 * The route's `syncDns` passive-health-check branch (GET ?syncDns=1, which
 * opportunistically flips already-verified domains back to unverified on
 * drift) is deliberately NOT ported here — it's a dashboard-load-time
 * side effect, not a distinct action a caller asks for, so it stays
 * HTTP-route-only. listDomains() below is the plain list only.
 *
 * update_domain (swap the domain string in place) is also NOT extracted —
 * it removes+re-adds the domain in Vercel and resets verification, the
 * riskiest of the four operations and not part of what was asked for this
 * pass. Left in the HTTP route only; can be added later as its own tool.
 */

/**
 * Mirrors DomainsClient.tsx's getDomainName()/isRootDomain() + CNAME/A-record
 * display logic exactly, so MCP callers get the SAME routing instructions
 * the dashboard always shows — not just the conditional ownership TXT record
 * from vercel_verification. cname_target is never actually populated by any
 * write path (confirmed: always inserted as null), so, same as the
 * dashboard, this falls back to the static CNAME_TARGET/VERCEL_A_RECORD env
 * constants. This is the record that actually routes traffic; the TXT one
 * (when present) only proves ownership — a domain can have a "verified"
 * TXT and still be misconfigured if this one was never added.
 *
 * root_domain_alternative is an ALTERNATIVE to primary, not an addition —
 * matches the dashboard's own copy verbatim ("Some registrars don't support
 * CNAME on root domains. Use an A record instead"). A root/apex domain
 * cannot have both a CNAME and an A record on the same name at once (that's
 * invalid DNS, not just a SplitLab rule) — callers must present this as
 * "use ONE of these," never as a two-item add-both checklist.
 */
export interface DnsInstruction { type: 'CNAME' | 'A'; name: string; value: string }
export interface DnsInstructions { primary: DnsInstruction; root_domain_alternative?: DnsInstruction }

export function buildDnsInstructions(domain: string, cnameTarget: string | null): DnsInstructions {
  const parts = domain.split('.');
  const isRoot = parts.length <= 2;
  const dnsName = isRoot ? '@' : parts.slice(0, -2).join('.');

  const primary: DnsInstruction = { type: 'CNAME', name: dnsName, value: cnameTarget || CNAME_TARGET };
  if (!isRoot) return { primary };

  return { primary, root_domain_alternative: { type: 'A', name: '@', value: VERCEL_A_RECORD } };
}

export async function listDomains(workspaceId: string): Promise<ServiceResult<unknown[]>> {
  const { data, error } = await db
    .from('domains')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  if (error) return fail(500, error.message);
  return ok(data ?? []);
}

/**
 * Plan-limit check matches the route's exactly: owner's plan (via
 * resolveOwnerPlan — same helper requireAiPagesPlan in mcp/route.ts already
 * uses), admins bypass entirely.
 */
export async function addDomain(workspaceId: string, domain: string, actorRole: string): Promise<ServiceResult<unknown>> {
  // Same bounds the HTTP route's zod schema enforces (addSchema) — the MCP
  // tool has no schema-level validation of its own, so check here to fail
  // with a clear message instead of a raw Vercel API error.
  if (domain.length < 3 || domain.length > 255) {
    return fail(400, 'domain must be between 3 and 255 characters');
  }

  if (actorRole !== 'admin') {
    const plan = await resolveOwnerPlan(workspaceId);
    const limit = PLAN_LIMITS[plan]?.domains ?? 0;

    if (limit === 0) {
      return fail(403, 'Your plan does not include custom domains. Please upgrade to add a domain.', { limitError: true });
    }

    if (isFinite(limit)) {
      const { count } = await db
        .from('domains')
        .select('*', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId);

      if ((count ?? 0) >= limit) {
        return fail(403, `You have reached the domain limit (${limit}) for your plan. Please upgrade to add more domains.`, { limitError: true });
      }
    }
  }

  const vercelResult = await addDomainToVercel(domain);

  const { data: created, error } = await db
    .from('domains')
    .insert({
      workspace_id: workspaceId,
      domain,
      cname_target: null,
      vercel_verification: vercelResult.verification?.length ? vercelResult.verification : null,
    })
    .select()
    .single();

  if (error) return fail(500, error.message);
  return ok(created);
}

/**
 * Hits Vercel's POST /verify (the 50/hr-quota endpoint) via getDomainStatus.
 * Callers (the MCP tool handler) are responsible for not looping this.
 */
export async function verifyDomain(workspaceId: string, domainId: string): Promise<ServiceResult<unknown>> {
  const { data: domain } = await db
    .from('domains')
    .select('domain')
    .eq('id', domainId)
    .eq('workspace_id', workspaceId)
    .single();

  if (!domain) return fail(404, 'Domain not found');

  const status = await getDomainStatus(domain.domain);

  if (status.verified) {
    await db
      .from('domains')
      .update({ verified: true, verified_at: new Date().toISOString() })
      .eq('id', domainId);
  } else {
    const update: { verified: boolean; vercel_verification?: typeof status.vercel_verification } = {
      verified: false,
    };
    if (status.vercel_verification?.length) {
      update.vercel_verification = status.vercel_verification;
    }
    await db.from('domains').update(update).eq('id', domainId);
  }

  await logEvent('domain_verification', status.verified ? 'info' : 'warn', 'verify attempted', {
    domain: domain.domain, domainId, workspaceId, verified: status.verified,
  });

  return ok({ domain: domain.domain, verified: status.verified, status });
}

export async function deleteDomain(workspaceId: string, domainId: string): Promise<ServiceResult<{ success: true }>> {
  const { data: domain } = await db
    .from('domains')
    .select('domain')
    .eq('id', domainId)
    .eq('workspace_id', workspaceId)
    .single();

  if (!domain) return fail(404, 'Domain not found');

  await removeDomainFromVercel(domain.domain);

  const { error } = await db.from('domains').delete().eq('id', domainId);
  if (error) return fail(500, error.message);
  return ok({ success: true });
}
