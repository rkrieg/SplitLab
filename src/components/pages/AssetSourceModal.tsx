'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Search, Loader2, AlertTriangle, ImageOff } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import toast from 'react-hot-toast';

interface ResolvedAsset {
  url: string;
  name: string;
  thumbnailUrl: string | null;
  bytes: number | null;
  modifiedAt: string | null;
  path: string;
}

export interface ImportedAsset {
  url: string;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  pageId: string | null;
  workspaceId: string;
  /** Fires with the re-hosted images once the import finishes. */
  onImported: (assets: ImportedAsset[]) => void;
  /** Images already attached — counts against the cap. */
  alreadyAttached?: number;
  /**
   * Link detected in the user's own prompt. When set, the modal opens with it
   * filled in and looks inside immediately — the user already pasted this link
   * once, in their brief, and making them paste it again to prove they meant it
   * is the exact friction this feature exists to remove.
   */
  initialLink?: string | null;
  /**
   * How many images this composer can actually use.
   *
   * Not one number for the whole app: the create composer feeds the schema
   * step, which can place a whole library of named URLs, while the edit
   * composer goes through the follow-up route's per-image vision routing,
   * which is hard-capped at MAX_ATTACHMENTS. Offering 20 where only 3 will be
   * read would silently drop 17.
   */
  selectionCap: number;
}

function formatBytes(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line per skipped file, so nothing a user ticked disappears silently. */
function describeFailures(failed: { name: string; reason: string }[]): string {
  return failed.map((f) => `• ${f.name} — ${f.reason}`).join('\n');
}

export default function AssetSourceModal({
  open,
  onClose,
  pageId,
  workspaceId,
  onImported,
  alreadyAttached = 0,
  selectionCap,
  initialLink = null,
}: Props) {
  const [link, setLink] = useState('');
  const [looking, setLooking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [assets, setAssets] = useState<ResolvedAsset[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [truncated, setTruncated] = useState(false);
  // The size ceiling the import step enforces. Files above it are shown but
  // can't be ticked — letting someone select one only to be told afterwards
  // that we refused it is worse than greying it out up front.
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Thumbnails come from the source, not our storage, so some will 403 or
  // hotlink-block. A broken <img> in a picker grid reads as "this file is
  // broken" when the file is fine — show a neutral tile instead.
  const [brokenThumbs, setBrokenThumbs] = useState<Set<string>>(new Set());

  // Autofill + auto-search when opened with a link found in the prompt.
  // lookRef, not handleLook, so this doesn't re-fire on every keystroke — the
  // handler is recreated each render and would be a new dependency every time.
  const lookRef = useRef<((raw: string) => void) | null>(null);
  useEffect(() => {
    if (!open || !initialLink) return;
    setLink(initialLink);
    lookRef.current?.(initialLink);
  }, [open, initialLink]);

  // Reset everything on close so reopening never shows the last folder's grid.
  useEffect(() => {
    if (open) return;
    setLink('');
    setAssets(null);
    setSelected(new Set());
    setTruncated(false);
    setMaxBytes(null);
    setError(null);
    setBrokenThumbs(new Set());
    setLooking(false);
    setImporting(false);
  }, [open]);

  const remaining = Math.max(0, selectionCap - alreadyAttached);
  const overCap = selected.size > remaining;

  const grouped = useMemo(() => {
    if (!assets) return [];
    const byPath = new Map<string, ResolvedAsset[]>();
    for (const asset of assets) {
      const key = asset.path || '';
      if (!byPath.has(key)) byPath.set(key, []);
      byPath.get(key)!.push(asset);
    }
    return Array.from(byPath.entries());
  }, [assets]);

  async function handleLook(e: React.FormEvent) {
    e.preventDefault();
    await runLook(link);
  }

  async function runLook(raw: string) {
    if (!raw.trim() || looking) return;
    setLooking(true);
    setError(null);
    setAssets(null);
    setBrokenThumbs(new Set());
    try {
      const res = await fetch('/api/asset-sources/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: raw.trim(), workspace_id: workspaceId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Couldn't read that link.");
        return;
      }
      if (data.error) {
        setError(data.error);
        return;
      }
      const found: ResolvedAsset[] = data.assets ?? [];
      setAssets(found);
      // The server preselects against ITS default cap. Re-trim to this
      // composer's cap so the grid never opens already over the limit with
      // the Add button disabled and no explanation.
      const serverPicked: string[] = data.preselected ?? [];
      const room = Math.max(0, selectionCap - alreadyAttached);
      setSelected(new Set<string>(serverPicked.slice(0, room)));
      setTruncated(!!data.truncated);
      setMaxBytes(typeof data.maxBytes === 'number' ? data.maxBytes : null);
    } catch {
      setError("Couldn't read that link. Check your connection and try again.");
    } finally {
      setLooking(false);
    }
  }

  lookRef.current = (raw: string) => { void runLook(raw); };

  /**
   * Vector files can be placed on the page but not LOOKED at — the vision API
   * takes JPEG/PNG/GIF/WebP only. Surfaced in the UI because the fix is
   * something only the user can do: name the file so its filename says what it
   * is, or say where it goes in the prompt.
   */
  function isVector(asset: ResolvedAsset): boolean {
    return /\.(svgz?|avif|tiff?|bmp)(?:\?|#|$)/i.test(asset.url);
  }

  function tooBig(asset: ResolvedAsset): boolean {
    return !!maxBytes && !!asset.bytes && asset.bytes > maxBytes;
  }

  function toggle(url: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  async function handleImport() {
    if (!assets || selected.size === 0 || importing) return;
    if (!pageId) {
      toast.error('Give the page a name first, then add images from a link.');
      return;
    }
    setImporting(true);
    try {
      const chosen = assets.filter(a => selected.has(a.url));
      const res = await fetch(`/api/pages/${pageId}/import-assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assets: chosen.map(a => ({ url: a.url, name: a.name })) }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Couldn't add those images.");
        return;
      }
      const imported: ImportedAsset[] = data.imported ?? [];
      const failed: { name: string; reason: string }[] = data.failed ?? [];

      if (imported.length > 0) onImported(imported);

      if (imported.length > 0 && failed.length === 0) {
        toast.success(`Added ${imported.length} image${imported.length === 1 ? '' : 's'}.`);
      } else if (imported.length > 0) {
        // Long, and every skipped file named: a skip means an image the user
        // ticked is NOT on the page. A 2s toast that names only the first one
        // sends them off to build with a hole they never saw.
        toast.error(
          `Added ${imported.length} image${imported.length === 1 ? '' : 's'}, but ${failed.length} couldn't be added:\n` +
            describeFailures(failed),
          { duration: 12000, style: { whiteSpace: 'pre-line' } },
        );
      } else {
        toast.error(
          `None of those images could be added:\n` + describeFailures(failed),
          { duration: 12000, style: { whiteSpace: 'pre-line' } },
        );
        return;
      }
      onClose();
    } catch {
      toast.error("Couldn't add those images. Please try again.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add images from a link"
      description="Paste a Google Drive folder, a shared image, or any web page. We'll show you what's in there."
      size="xl"
    >
      <div className="space-y-4">
        <form onSubmit={handleLook} className="flex items-center gap-2">
          <div className="relative flex-1">
            <Link2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={link}
              onChange={e => setLink(e.target.value)}
              placeholder="https://drive.google.com/drive/folders/…"
              className="input-base pl-9"
              autoFocus
            />
          </div>
          <Button type="submit" loading={looking} disabled={!link.trim()}>
            {!looking && <Search size={14} />}
            Look inside
          </Button>
        </form>

        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          Drive folders need to be shared as <span className="font-medium">Anyone with the link</span>, otherwise we can&apos;t see inside.
        </p>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900">
            <AlertTriangle size={14} className="text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {looking && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500 dark:text-slate-400">
            <Loader2 size={15} className="animate-spin" />
            Looking through that link…
          </div>
        )}

        {assets && assets.length === 0 && !error && (
          <div className="text-center py-10">
            <ImageOff size={22} className="mx-auto text-slate-300 dark:text-slate-600 mb-2" />
            <p className="text-sm text-slate-500 dark:text-slate-400">No images in there.</p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
              If it&apos;s a Drive folder, check it&apos;s shared with anyone who has the link.
            </p>
          </div>
        )}

        {assets && assets.length > 0 && (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-slate-600 dark:text-slate-300">
                Found <span className="font-semibold">{assets.length}</span> image{assets.length === 1 ? '' : 's'}.{' '}
                {assets.length > remaining
                  ? `We ticked ${selected.size} to get you started — untick any you don't want.`
                  : 'All of them are ticked. Untick anything you don’t want.'}
              </p>
              <div className="flex items-center gap-3 text-[11px]">
                <button
                  type="button"
                  onClick={() => setSelected(new Set(assets.filter(a => !tooBig(a)).slice(0, remaining).map(a => a.url)))}
                  className="text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  Select first {Math.min(remaining, assets.length)}
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="text-slate-500 dark:text-slate-400 hover:underline"
                >
                  Clear
                </button>
              </div>
            </div>

            {remaining === 0 && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                You&apos;ve already got {alreadyAttached} image{alreadyAttached === 1 ? '' : 's'} on this message, which is all we can use here. Remove one first to swap in something from this folder.
              </p>
            )}

            {assets.some(isVector) && (
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900">
                <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400 mt-px shrink-0">SVG</span>
                <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
                  The files marked <span className="font-semibold">SVG</span> get used on the page, but the AI can&apos;t look at them — it goes by the filename. If one is a logo, make sure it&apos;s named like a logo (<span className="font-mono">logo.svg</span>), or just say where it goes in your prompt.
                </p>
              </div>
            )}

            {truncated && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                That folder is big, so we stopped after the first {assets.length}. If what you need isn&apos;t here, link a subfolder instead.
              </p>
            )}

            <div className="max-h-[46vh] overflow-y-auto pr-1 space-y-4">
              {grouped.map(([path, items]) => (
                <div key={path || '__root'}>
                  {path && (
                    <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 mb-1.5">{path}</p>
                  )}
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                    {items.map((asset: ResolvedAsset) => {
                      const isSelected = selected.has(asset.url);
                      const size = formatBytes(asset.bytes);
                      const oversized = tooBig(asset);
                      return (
                        <button
                          key={asset.url}
                          type="button"
                          disabled={oversized}
                          onClick={() => toggle(asset.url)}
                          className={cn(
                            'group relative aspect-square rounded-lg overflow-hidden border-2 text-left transition-all',
                            oversized
                              ? 'border-slate-200 dark:border-slate-700 opacity-40 cursor-not-allowed'
                              : isSelected
                              ? 'border-indigo-500 ring-2 ring-indigo-500/25'
                              : 'border-slate-200 dark:border-slate-700 opacity-60 hover:opacity-100'
                          )}
                          title={oversized ? `${asset.name} — too big to use (over ${formatBytes(maxBytes)})` : asset.name}
                        >
                          {asset.thumbnailUrl && !brokenThumbs.has(asset.url) ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              src={asset.thumbnailUrl}
                              alt=""
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              className="w-full h-full object-cover"
                              onError={() => setBrokenThumbs(prev => new Set(prev).add(asset.url))}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-slate-100 dark:bg-slate-800">
                              <ImageOff size={16} className="text-slate-400 dark:text-slate-600" />
                            </div>
                          )}

                          {oversized && (
                            <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/75 text-white text-[8px] font-medium">
                              too big
                            </span>
                          )}
                          {!oversized && isVector(asset) && (
                            <span className="absolute top-1 right-1 px-1 py-0.5 rounded bg-amber-500/90 text-white text-[8px] font-semibold">
                              SVG
                            </span>
                          )}

                          <span
                            className={cn(
                              'absolute top-1 left-1 w-4 h-4 rounded-full border flex items-center justify-center text-[9px] font-bold',
                              oversized
                                ? 'hidden'
                                : isSelected
                                ? 'bg-indigo-600 border-indigo-600 text-white'
                                : 'bg-white/80 dark:bg-slate-900/80 border-slate-300 dark:border-slate-600 text-transparent'
                            )}
                          >
                            ✓
                          </span>

                          <span className="absolute inset-x-0 bottom-0 px-1.5 py-1 bg-gradient-to-t from-black/80 to-transparent">
                            <span className="block text-[9px] text-white truncate">{asset.name}</span>
                            {size && <span className="block text-[9px] text-white/60">{size}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-200 dark:border-slate-700">
              <p className={cn('text-xs', overCap ? 'text-red-500' : 'text-slate-500 dark:text-slate-400')}>
                {selected.size} selected
                {overCap && ` — that's more than we can use. Pick ${remaining} or fewer.`}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={onClose} disabled={importing}>Cancel</Button>
                <Button onClick={handleImport} loading={importing} disabled={selected.size === 0 || overCap}>
                  Add {selected.size > 0 ? selected.size : ''} to this page
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
