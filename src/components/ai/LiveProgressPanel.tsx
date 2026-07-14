'use client';

import { Check, Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SSEEvent } from '@/lib/sse';

interface Props {
  events: SSEEvent[];
  isComplete?: boolean;
}

export function LiveProgressPanel({ events, isComplete = false }: Props) {
  const errorEvent = events.find(e => e.type === 'error');
  const isDone = isComplete || events.some(e => e.type === 'done');

  if (errorEvent) {
    return (
      <div className="flex items-center gap-2 text-xs text-red-400">
        <span className="w-4 h-4 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center text-[9px] flex-shrink-0">✕</span>
        {errorEvent.message}
      </div>
    );
  }

  // Collect image URLs in order
  const imageUrls = events.filter(e => e.type === 'image_ready').map(e => (e as { type: 'image_ready'; url: string }).url);

  // Track which status event index is the most recent
  const statusEvents = events.filter(e => e.type === 'status');
  const lastStatusIdx = statusEvents.length - 1;

  // Find the index of the "Building HTML..." status event (to indent section_status under it)
  const buildingHtmlStatusIdx = statusEvents.findLastIndex(e =>
    (e as { type: 'status'; message: string }).message === 'Building HTML...'
  );
  const sectionEvents = buildingHtmlStatusIdx >= 0
    ? events.filter(e => e.type === 'section_status')
    : [];
  const lastSectionIdx = sectionEvents.length - 1;

  // Find thinking event
  const thinkingEvent = events.find(e => e.type === 'thinking') as { type: 'thinking'; message: string } | undefined;

  return (
    <div className="space-y-1.5 min-w-[190px]">
      {/* Render status steps + interleaved thinking/images in event order */}
      {(() => {
        let statusRenderedCount = 0;
        let imagesRendered = false;
        let thinkingRendered = false;

        return events.map((event, i) => {
          if (event.type === 'status') {
            const idx = statusRenderedCount++;
            const isActive = idx === lastStatusIdx && !isDone;
            const isBuildHtml = (event as { type: 'status'; message: string }).message === 'Building HTML...';

            return (
              <div key={i}>
                <div className={cn(
                  'flex items-center gap-2 text-xs',
                  isActive ? 'text-slate-200' : 'text-slate-500 dark:text-slate-500'
                )}>
                  {isDone || !isActive ? (
                    <Check size={11} className="text-green-500 flex-shrink-0" />
                  ) : (
                    <Loader2 size={11} className="animate-spin text-indigo-400 flex-shrink-0" />
                  )}
                  <span>{(event as { type: 'status'; message: string }).message}</span>
                </div>

                {/* Section status items indented under "Building HTML..." */}
                {isBuildHtml && sectionEvents.length > 0 && (
                  <div className="ml-[19px] mt-1 space-y-0.5">
                    {sectionEvents.map((s, si) => {
                      const isLastSection = si === lastSectionIdx && !isDone;
                      return (
                        <div
                          key={si}
                          className={cn(
                            'flex items-center gap-1.5 text-[11px]',
                            isLastSection ? 'text-indigo-400' : 'text-slate-600'
                          )}
                        >
                          {isLastSection ? (
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0 animate-pulse" />
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-600 flex-shrink-0" />
                          )}
                          {(s as { type: 'section_status'; message: string }).message}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          if (event.type === 'thinking' && !thinkingRendered) {
            thinkingRendered = true;
            return (
              <div key={i} className="flex items-start gap-1.5 pl-0.5">
                <Sparkles size={10} className="text-indigo-400 flex-shrink-0 mt-0.5" />
                <span className="text-[11px] text-slate-400 italic leading-relaxed">
                  &ldquo;{(event as { type: 'thinking'; message: string }).message}&rdquo;
                </span>
              </div>
            );
          }

          // Render the image strip after the LAST image_ready event
          if (event.type === 'image_ready' && !imagesRendered) {
            const isLastImage = !events.slice(i + 1).some(e => e.type === 'image_ready');
            if (isLastImage) {
              imagesRendered = true;
              return (
                <div key={i} className="flex gap-1.5 flex-wrap pl-0.5 pt-0.5">
                  {imageUrls.map((url, ui) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={ui}
                      src={url}
                      alt=""
                      className="w-12 h-12 rounded-md object-cover border border-slate-700 opacity-0 animate-fade-in"
                      style={{ animationDelay: `${ui * 80}ms`, animationFillMode: 'forwards' }}
                    />
                  ))}
                </div>
              );
            }
            return null;
          }

          // Skip section_status (rendered inline under Building HTML above)
          // Skip done/error (handled outside the loop)
          return null;
        });
      })()}

      {/* Thinking shown at bottom if no status events yet (style patch — thinking arrives first) */}
      {thinkingEvent && statusEvents.length === 0 && (
        <div className="flex items-start gap-1.5 pl-0.5">
          <Sparkles size={10} className="text-indigo-400 flex-shrink-0 mt-0.5" />
          <span className="text-[11px] text-slate-400 italic leading-relaxed">
            &ldquo;{thinkingEvent.message}&rdquo;
          </span>
        </div>
      )}

      {/* Done state */}
      {isDone && (
        <div className="flex items-center gap-1.5 text-xs text-green-400 pt-0.5">
          <Check size={11} />
          Done
        </div>
      )}
    </div>
  );
}
