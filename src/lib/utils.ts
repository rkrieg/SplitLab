import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

export function generateId(): string {
  return Math.random().toString(36).slice(2, 11);
}

/**
 * Deterministically assign a variant for a visitor using SHA-256
 * hashing so the same visitor always gets the same variant.
 */
export async function assignVariant<T extends { traffic_weight: number }>(
  sessionId: string,
  testId: string,
  variants: T[]
): Promise<T> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${sessionId}:${testId}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashBytes = new Uint8Array(hashBuffer);

  // Build a 32-bit integer from the first 4 bytes
  const hashInt =
    (hashBytes[0] << 24) |
    (hashBytes[1] << 16) |
    (hashBytes[2] << 8) |
    hashBytes[3];
  const absHash = Math.abs(hashInt);

  const totalWeight = variants.reduce((sum, v) => sum + v.traffic_weight, 0);
  const bucket = absHash % totalWeight;

  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.traffic_weight;
    if (bucket < cumulative) return variant;
  }
  return variants[0];
}
