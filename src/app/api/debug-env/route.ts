import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';

export async function GET() {
  // Look up the page being edited by ID
  const { data: byId } = await db
    .from('pages')
    .select('id, name, slug, is_published, published_url, html_content')
    .eq('id', 'b74e2c8e-01e2-4e31-a9c2-ddb77c4569f4')
    .single();

  // Look up what's at slug 50bcff43
  const { data: bySlug } = await db
    .from('pages')
    .select('id, name, slug, is_published, published_url, html_content')
    .eq('slug', '50bcff43-9692-4b06-a9ba-18af19a0bd43')
    .single();

  return NextResponse.json({
    page_by_id: {
      id: byId?.id,
      name: byId?.name,
      slug: byId?.slug,
      published_url: byId?.published_url,
      html_content_length: byId?.html_content ? (byId.html_content as string).length : null,
    },
    page_by_slug_50bcff43: {
      id: bySlug?.id,
      name: bySlug?.name,
      slug: bySlug?.slug,
      published_url: bySlug?.published_url,
      html_content_length: bySlug?.html_content ? (bySlug.html_content as string).length : null,
    },
  });
}
