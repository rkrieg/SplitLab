import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { uploadHtml, downloadHtml } from '@/lib/storage';

export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'admin' && session.user.role !== 'manager')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pageId = params.id;
  const { section_id, instructions } = await request.json();

  if (!section_id || !instructions) {
    return NextResponse.json({ error: 'section_id and instructions required' }, { status: 400 });
  }

  const { data: page, error } = await db
    .from('pages')
    .select('*')
    .eq('id', pageId)
    .single();

  if (error || !page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  // Get current HTML
  let html: string;
  if (page.html_content) {
    html = page.html_content;
  } else {
    html = await downloadHtml(page.html_url);
  }

  // Extract the target section
  const sectionRegex = new RegExp(
    `(<[^>]+data-sl-section=["']${section_id}["'][^>]*>)([\\s\\S]*?)(<\\/(?:section|div|aside|header|footer)>)`,
    'i'
  );
  const match = html.match(sectionRegex);

  if (!match) {
    return NextResponse.json({ error: `Section "${section_id}" not found` }, { status: 404 });
  }

  const [fullMatch, openTag, sectionContent, closeTag] = match;

  // Ask Claude Sonnet to rewrite just this section
  const response = await ask(
    `You are rewriting a section of an HTML landing page. Keep the same HTML structure and data attributes, but update the content based on the instructions.

## Current Section
${openTag}${sectionContent}${closeTag}

## Instructions
${instructions}

## Rules
1. Keep all data-sl-section and data-sl-editable attributes
2. Keep the same HTML tag structure
3. Only change text content and potentially add/remove elements
4. Keep all CSS classes
5. Output ONLY the rewritten section HTML (including the opening and closing tags)
6. No markdown code fences`,
    {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 4096,
    }
  );

  let newSection = response.trim();
  if (newSection.startsWith('```')) {
    newSection = newSection.replace(/^```html?\n?/, '').replace(/\n?```$/, '');
  }

  // Replace section in HTML
  const updatedHtml = html.replace(fullMatch, newSection);
  const newVersion = (page.version || 1) + 1;
  const storagePath = `pages/${page.workspace_id}/${pageId}.html`;
  const publicUrl = await uploadHtml(storagePath, updatedHtml);

  await db.from('pages').update({
    html_url: publicUrl,
    html_content: updatedHtml.length < 500_000 ? updatedHtml : null,
    version: newVersion,
  }).eq('id', pageId);

  return NextResponse.json({
    page_id: pageId,
    version: newVersion,
    section_id,
  });
}
