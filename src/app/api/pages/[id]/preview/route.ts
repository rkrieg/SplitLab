import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { buildUtmSwapScript } from '@/lib/utm-swap-script';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return new NextResponse(errorHtml('401', 'Unauthorized', 'You must be logged in to view this page.'), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_url, html_content, field_selectors_json')
    .eq('id', params.id)
    .single();

  if (!page) return new NextResponse(errorHtml('404', 'Not Found', 'This page does not exist.'), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole) return new NextResponse(errorHtml('403', 'Access Denied', "You don't have permission to view this page."), { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

  try {
    let html = page.html_content as string | null;

    if (!html) {
      const filePath = fileNameFromUrl(page.html_url);
      html = await downloadHtmlByPath(filePath);
    }

    // Inject UTM swap script (client-side, reads window.location.search in iframe)
    try {
      const { data: rules } = await db
        .from('personalization_rules')
        .select('match_param,match_value,is_fallback,overrides_json,conditions_json')
        .eq('page_id', params.id)
        .order('is_fallback', { ascending: true })
        .order('priority', { ascending: true });

      if (rules && rules.length > 0) {
        const fieldSelectors = (page.field_selectors_json as Record<string, { selector: string; type: 'text' | 'image'; label: string }> | null) ?? null;
        const swapScript = buildUtmSwapScript(rules, fieldSelectors);
        html = html.includes('</body')
          ? html.replace('</body>', `${swapScript}\n</body>`)
          : html + swapScript;
      }
    } catch {
      // UTM injection failure must never block preview delivery
    }

    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch {
    return new NextResponse(errorHtml('502', 'Failed to Load', 'Could not load the preview. Please try again.'), { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

function errorHtml(code: string, title: string, message: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${title}</title>
<style>
  body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{text-align:center}.code{font-size:4rem;font-weight:700;color:#3D8BDA}
  h1{margin:.5rem 0;font-size:1.25rem}p{color:#94a3b8;font-size:.875rem}
</style>
</head>
<body><div class="box"><div class="code">${code}</div><h1>${title}</h1><p>${message}</p></div></body>
</html>`;
}
