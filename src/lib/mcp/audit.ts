import { db } from '@/lib/supabase-server';
import type { McpPrincipal } from './auth';

/**
 * Logs every MCP-originated write. Best-effort — a logging failure must
 * never block or fail the actual tool call. Backs a future "edited via AI"
 * indicator; storage is added now (Phase 0) since retrofitting after
 * MCP-originated rows already exist is riskier than adding it upfront.
 */
export async function logMcpAction(
  principal: McpPrincipal,
  toolName: string,
  outcome: { status: 'ok' | 'error'; targetTable?: string; targetId?: string; errorMessage?: string }
): Promise<void> {
  try {
    await db.from('mcp_audit_log').insert({
      token_id: principal.tokenId,
      user_id: principal.id,
      tool_name: toolName,
      target_table: outcome.targetTable ?? null,
      target_id: outcome.targetId ?? null,
      status: outcome.status,
      error_message: outcome.errorMessage ?? null,
    });
  } catch {
    // Never let audit logging break a tool call.
  }
}
