# Test Preview: Mobile/Desktop Toggle (Urgent)

## Problem
Clicking "Preview" on a test variant opens the page with no way to switch between desktop and mobile rendering. User can't tell if a variant looks broken on mobile (suspected cause of low conversion on current variant — video shows content taking up the whole mobile screen).

## Request
Add a toolbar/icon to the test variant preview, similar to what's already implemented for AI-generated pages, letting the user toggle between Desktop and Mobile views — similar to Unbounce's preview bar (shown in provided screen recording).

## Reference
- AI pages preview already has this toggle — reuse the same pattern/component if possible.
- Unbounce reference: top bar with Desktop/Mobile icons that resizes the preview viewport.

## Priority
User asked to put this in front of all other work.

## Status
Investigated. Findings:

- Reference pattern lives in `src/app/(dashboard)/clients/[id]/pages/new/AIBuilderClient.tsx`:
  - `useState<'desktop'|'mobile'>('desktop')` view mode state (no URL persistence)
  - `Monitor`/`Smartphone` lucide icons in a segmented-pill toggle
  - `ResizeObserver` on the preview wrapper computes `desktopScale = min(1, wrapperWidth / 1440)`
  - Desktop: iframe rendered at fixed 1440px width, CSS `transform: scale(desktopScale)` with `transformOrigin: top left`
  - Mobile: iframe fixed at `w-[390px]`, no scaling
- Test variant preview currently has NO in-app iframe preview at all — "Preview Test" in `AnalyticsClient.tsx` (~line 2374) just does `window.open(url, '_blank')` in a new tab. Same for per-variant `redirect_url` links (~line 2277-2340, ~2912).
- To implement: build a new iframe preview modal/panel in `AnalyticsClient.tsx` (replacing/augmenting the window.open button) and lift the view-mode state + toggle UI + scaled-iframe logic from `AIBuilderClient.tsx` wholesale.

Not yet implemented — awaiting go-ahead to build.

## To-do (simple)
- [ ] Replace "Preview Test" window.open with a modal/panel that shows the page inside the dashboard
- [ ] Add Desktop/Mobile toggle buttons (copy look from AI page builder)
- [ ] Desktop view: show page full-size, shrink to fit if panel is small
- [ ] Mobile view: show page at phone width (390px)
- [ ] Wire toggle to per-variant preview link (so each variant can be checked on both sizes)
- [ ] Test on a real variant that user said looks broken on mobile
