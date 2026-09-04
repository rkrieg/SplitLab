import type { MetadataRoute } from 'next';

const SITE = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

// AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, etc.) match the
// '*' rule, so they're explicitly allowed to read the public marketing pages —
// which is what we want for LLM discoverability. Only auth-walled app paths are
// disallowed.
//
// /api/assets/ must stay Allow'd: Haiku captions Drive images by fetching our
// signed proxy URLs. Anthropic respects robots.txt, and a blanket /api/
// Disallow makes every caption fail with "URL is disallowed by robots.txt"
// (described: 0). Longest-prefix match keeps the rest of /api/ closed.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/api/assets/'],
        disallow: [
          '/api/',
          '/dashboard',
          '/admin',
          '/clients',
          '/billing',
          '/settings',
          '/team',
          '/affiliates',
          '/welcome',
          '/login',
        ],
      },
    ],
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
