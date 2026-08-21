import type { MetadataRoute } from 'next';

const SITE = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

// AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, etc.) match the
// '*' rule, so they're explicitly allowed to read the public marketing pages —
// which is what we want for LLM discoverability. Only auth-walled app paths are
// disallowed.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
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
