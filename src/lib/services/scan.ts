import { db } from '@/lib/supabase-server';
import { scanHtmlElements, ScanElement } from '@/lib/html-scan';

export interface VariantScan {
  variant_id: string;
  variant_name: string;
  scanned_at: string;
  elements: ScanElement[];
}

/**
 * Regenerates one variant's entry in tests.scan_results from its current
 * HTML — the auto-scan hook. Called from every write path that changes a
 * variant-linked page's live HTML (see html-scan.ts for what it can and
 * can't see). Replaces that variant's whole elements array rather than
 * merging, since this is a full rescan of fresh content, not the live
 * scanner's incremental multi-step-form accumulation.
 */
export async function rescanVariantHtml(testId: string, variantId: string, variantName: string, html: string): Promise<void> {
  const elements = scanHtmlElements(html);

  const { data: testRow } = await db.from('tests').select('scan_results').eq('id', testId).single();
  const existing = testRow?.scan_results as { variants?: VariantScan[] } | null;
  const variants = existing?.variants ? [...existing.variants] : [];

  const entry: VariantScan = { variant_id: variantId, variant_name: variantName, scanned_at: new Date().toISOString(), elements };
  const idx = variants.findIndex((v) => v.variant_id === variantId);
  if (idx >= 0) variants[idx] = entry;
  else variants.push(entry);

  await db.from('tests').update({ scan_results: { variants } }).eq('id', testId);
}
