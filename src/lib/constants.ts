// Server-side env constants — import only in server components, API routes, and middleware.
// Client components receive these as props from their server component parent.

/** Hostname used to distinguish the app itself from custom client domains. */
export const APP_HOSTNAME = process.env.APP_HOSTNAME ?? 'trysplitlab.com';

/** CNAME value clients should point their domain to. */
export const CNAME_TARGET = process.env.CNAME_TARGET ?? 'cname.vercel-dns.com';

/** A record IP for registrars that don't support CNAME on root domains. */
export const VERCEL_A_RECORD = process.env.VERCEL_A_RECORD ?? '216.150.1.1';
