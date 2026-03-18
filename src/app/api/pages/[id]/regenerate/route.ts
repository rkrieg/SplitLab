import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { buildPageGenerationPrompt } from '@/lib/page-builder-prompts';
import { scorePage } from '@/lib/page-quality';
import { uploadHtml } from '@/lib/storage';
import { searchImages } from '@/lib/unsplash';
import type { Vertical } from '@/types/page-builder';

export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'admin' && session.user.role !== 'manager')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pageId = params.id;
  const { instructions } = await request.json();

  const { data: page, error } = await db
    .from('pages')
    .select('*')
    .eq('id', pageId)
    .single();

  if (error || !page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  const vertical = (page.vertical || 'local_services') as Vertical;
  const combinedPrompt = instructions
    ? `${page.prompt}\n\nAdditional instructions: ${instructions}`
    : page.prompt;

  const imageUrls = await searchImages(combinedPrompt, vertical);

  const { system, user } = buildPageGenerationPrompt({
    userPrompt: combinedPrompt,
    vertical,
    brandSettings: page.brand_settings,
    imageUrls,
  });

  const html = await ask(user, {
    system,
    model: 'claude-opus-4-20250514',
    maxTokens: 16384,
  });

  let finalHtml = html.trim();
  if (finalHtml.startsWith('```')) {
    finalHtml = finalHtml.replace(/^```html?\n?/, '').replace(/\n?```$/, '');
  }

  const quality = scorePage(finalHtml, vertical);
  const newVersion = (page.version || 1) + 1;
  const storagePath = `pages/${page.workspace_id}/${pageId}.html`;
  const publicUrl = await uploadHtml(storagePath, finalHtml);

  await db.from('pages').update({
    html_url: publicUrl,
    html_content: finalHtml.length < 500_000 ? finalHtml : null,
    quality_score: quality.score,
    quality_details: quality.details,
    version: newVersion,
  }).eq('id', pageId);

  return NextResponse.json({
    page_id: pageId,
    version: newVersion,
    quality_score: quality.score,
  });
}
