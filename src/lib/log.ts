import { db } from '@/lib/supabase-server';

export type LogCategory = 'ai_call' | 'event_skip' | 'stripe_webhook' | 'domain_verification' | 'admin_impersonate' | 'admin_action';
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Best-effort structured log row in Supabase. Never throws — a logging
 * failure must never affect the request it's describing, so callers can
 * fire this without wrapping it in their own try/catch.
 */
export async function logEvent(
  category: LogCategory,
  level: LogLevel,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const { error } = await db.from('logs').insert({ category, level, message, metadata: metadata ?? null });
    if (error) console.error('[logEvent] insert failed:', error.message);
  } catch (err) {
    console.error('[logEvent] insert threw:', err);
  }
}
