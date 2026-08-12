/**
 * Shared result type for service-layer functions used by both the existing
 * HTTP routes and the MCP tool handlers. Returning a discriminated result
 * instead of throwing means both callers map it to their own response shape
 * (NextResponse vs. an MCP tool result) without duplicating try/catch logic,
 * and it's structurally impossible for a caller to "forget" to check an
 * error — TypeScript won't let you read `.data` without narrowing `ok` first.
 */
export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; limitError?: boolean };

export function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

export function fail(status: number, error: string, opts?: { limitError?: boolean }): ServiceResult<never> {
  return { ok: false, status, error, ...(opts?.limitError ? { limitError: true } : {}) };
}
