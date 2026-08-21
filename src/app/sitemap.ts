import type { MetadataRoute } from 'next';

const SITE = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

// Public, indexable pages. Add /blog, /compare/*, /guides/* here as content ships
// (or switch to a DB/filesystem-driven list once there are many).
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const entries: { path: string; priority: number; freq: 'weekly' | 'monthly' }[] = [
    { path: '', priority: 1.0, freq: 'weekly' },
    { path: '/affiliate', priority: 0.6, freq: 'monthly' },
    { path: '/contact', priority: 0.4, freq: 'monthly' },
    { path: '/privacy', priority: 0.3, freq: 'monthly' },
    { path: '/terms', priority: 0.3, freq: 'monthly' },
  ];
  return entries.map((e) => ({
    url: `${SITE}${e.path}`,
    lastModified: now,
    changeFrequency: e.freq,
    priority: e.priority,
  }));
}
