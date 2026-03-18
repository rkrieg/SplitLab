import type { UnsplashImage, Vertical } from '@/types/page-builder';

const VERTICAL_KEYWORDS: Record<Vertical, string[]> = {
  legal: ['law office', 'legal consultation', 'courtroom', 'justice'],
  real_estate_financial: ['modern home', 'real estate', 'luxury property', 'financial planning'],
  saas: ['technology', 'software dashboard', 'team collaboration', 'modern workspace'],
  local_services: ['local business', 'home repair', 'plumber electrician', 'service professional'],
};

export async function searchImages(
  query: string,
  vertical: Vertical,
  count = 8
): Promise<UnsplashImage[]> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) {
    console.warn('[unsplash] UNSPLASH_ACCESS_KEY not set, returning empty images');
    return [];
  }

  const baseTerms = VERTICAL_KEYWORDS[vertical] || [];
  const combinedQuery = `${query} ${baseTerms[0] || ''}`.trim();

  try {
    const params = new URLSearchParams({
      query: combinedQuery,
      per_page: String(count),
      orientation: 'landscape',
    });

    const res = await fetch(
      `https://api.unsplash.com/search/photos?${params}`,
      { headers: { Authorization: `Client-ID ${accessKey}` } }
    );

    if (!res.ok) {
      console.error('[unsplash] API error:', res.status, await res.text());
      return [];
    }

    const data = await res.json();
    return (data.results || []).map((photo: Record<string, unknown>) => ({
      url: (photo.urls as Record<string, string>).regular,
      alt: (photo.alt_description as string) || combinedQuery,
      credit: `Photo by ${(photo.user as Record<string, string>).name} on Unsplash`,
    }));
  } catch (err) {
    console.error('[unsplash] fetch error:', err);
    return [];
  }
}
