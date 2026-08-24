import type { MetadataRoute } from 'next';
import { ARTICLES } from '@/content/articles';
import { COMPARISONS } from '@/content/comparisons';

const SITE = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

// Public, indexable pages. Articles + comparisons are pulled from their content
// registries so new pages appear here automatically.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const staticEntries: { path: string; priority: number; freq: 'weekly' | 'monthly' }[] = [
    { path: '', priority: 1.0, freq: 'weekly' },
    { path: '/resources', priority: 0.8, freq: 'weekly' },
    { path: '/resources/glossary', priority: 0.7, freq: 'monthly' },
    { path: '/tools/ab-test-significance-calculator', priority: 0.7, freq: 'monthly' },
    { path: '/compare', priority: 0.6, freq: 'monthly' },
    { path: '/affiliate', priority: 0.6, freq: 'monthly' },
    { path: '/contact', priority: 0.4, freq: 'monthly' },
    { path: '/privacy', priority: 0.3, freq: 'monthly' },
    { path: '/terms', priority: 0.3, freq: 'monthly' },
  ];

  const staticUrls: MetadataRoute.Sitemap = staticEntries.map((e) => ({
    url: `${SITE}${e.path}`, lastModified: now, changeFrequency: e.freq, priority: e.priority,
  }));

  const articleUrls: MetadataRoute.Sitemap = ARTICLES.map((a) => ({
    url: `${SITE}/resources/${a.slug}`, lastModified: new Date(a.dateModified), changeFrequency: 'monthly', priority: 0.7,
  }));

  const compareUrls: MetadataRoute.Sitemap = COMPARISONS.map((c) => ({
    url: `${SITE}/compare/${c.slug}`, lastModified: new Date(c.dateModified), changeFrequency: 'monthly', priority: 0.7,
  }));

  return [...staticUrls, ...articleUrls, ...compareUrls];
}
