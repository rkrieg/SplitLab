// Single source of truth for the "system fields" HubSpot mapping exposes
// alongside a test's captured form fields. Previously duplicated separately
// in src/lib/integrations/hubspot.ts AND src/app/(dashboard)/.../AnalyticsClient.tsx
// — the two copies had already drifted (client component's copy was missing
// gclid/fbclid). Isomorphic (no server-only imports) so both a server module
// and a 'use client' component can import it directly.
export interface SystemFieldDef {
  key: string;
  label: string;
}

export const HUBSPOT_SYSTEM_FIELDS: SystemFieldDef[] = [
  { key: 'ip_address', label: 'IP Address' },
  { key: 'variant', label: 'Page Variant' },
  { key: 'submitted_at', label: 'Submission Date' },
  { key: 'utm_source', label: 'UTM Source' },
  { key: 'utm_medium', label: 'UTM Medium' },
  { key: 'utm_campaign', label: 'UTM Campaign' },
  { key: 'utm_content', label: 'UTM Content' },
  { key: 'utm_term', label: 'UTM Term' },
  { key: 'gclid', label: 'GCLID' },
  { key: 'fbclid', label: 'FBCLID' },
];
