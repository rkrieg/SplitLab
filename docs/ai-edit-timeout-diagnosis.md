# Why "Edit using AI" is slow / times out — plain-English diagnosis

**Status: diagnosed, not fixed yet.** This is a write-up of what we found while
reproducing a client-reported crash/timeout on the "Edit using AI" feature for
raw HTML test variants. No code fix has been made yet — this doc is the
"here's what's actually happening" note.

## The complaint

Client reported the AI edit crashed / Vercel said the request timed out
(`Vercel Runtime Timeout Error: Task timed out after 300 seconds`) on
production, on a real client landing page.

## What we did to check it

We pulled a real client page's HTML (`docs/tester26.html` — a client's oil &
gas investor landing page, big and heavy: huge inline `<style>` block, a
scroll-driven ROI calculator with its own JS, 3 testimonial cards, a founder
quote block, and a popup contact form) and tested it locally with prompts
that match what real users type, and turned on detailed timing logs for every
AI call so we could see exactly where time was going.

## What we actually tested

Prompt: **"Add a pricing/investment tiers section after the What You Get
section"**

This is a small, simple ask — just insert one new section. On another AI
website builder (Lovable), the same kind of ask took about **1 minute**.

## What happened on our side — timed, step by step

| Step | What it's doing | Time it took |
|---|---|---|
| Prepping the page for AI editing (one-time, happens when you first open the AI editor) | Reads the whole page and tags every editable field | **70 seconds** |
| Deciding how big a change this is ("routing") | A cheap/fast AI call tries to figure out if this is a small 1-3 section tweak or something bigger | 1.4 seconds — but it **guessed wrong (low confidence)**, which matters a lot (see below) |
| Re-classifying the whole request | Because the quick guess above wasn't confident, the system falls back to a much bigger, slower AI call that re-reads the ENTIRE page and decides again | **57 seconds** |
| Rebuilding the whole page | Once it decides "yes, this is a structural change," it asks the AI to **regenerate the entire page from scratch** — the whole CSS, every section, the calculator, the popup form, all of it — not just add the one new section | **Still running when we stopped watching** — well past a minute, trending toward the same multi-minute range that causes the 300-second timeout in production |

**Total: multiple minutes for what should have been a small, single-section
addition** — and this is the same mechanism that can blow past the 300-second
limit on production and crash with a timeout error, especially on a page this
complex.

## The actual problem, in plain words

For a request like "add a section," the system *should* be able to just slot
the new section in and leave everything else untouched — cheap and fast, in
seconds.

Instead, because the quick first guess wasn't confident enough, the system
falls back to a much more expensive path that:
1. Re-reads and re-classifies the **entire page** from scratch (57 seconds
   here), then
2. **Throws away nothing and rebuilds the whole page's HTML from scratch**
   (the CSS, every section, the calculator widget, the popup form — all of
   it) instead of just inserting the one new section.

Step 2 is the expensive one. The page-rebuilding AI call doesn't know how to
"just add a section" — every time it runs, it redesigns the *whole page* from
a text description, section by section, from zero. For a big, real,
already-designed client page like this one (lots of custom CSS, a calculator,
a popup form), regenerating the *entire thing* from scratch is a multi-minute
job no matter what — which is exactly why it can hit the 300-second Vercel
timeout and crash.

Lovable did the same kind of request in ~1 minute, which strongly suggests
their system is smart enough to just insert the new section without
re-generating the whole page around it — i.e. they treat "add a section" as
a small, scoped patch, not a full-page rebuild.

## Bottom line

- It's not really "hanging" or broken — it's doing a legitimately huge amount
  of unnecessary work for a simple ask.
- The system already *has* a fast path for small changes ("scoped patch") —
  it's just not being used here because the confidence check failed even
  though this was a genuinely simple, well-scoped instruction ("add a section
  after X").
- The real fix (not done yet) is likely about improving how confidently we
  detect "this is a small, scoped change" so simple asks like this stop
  falling back into the expensive full-page-rebuild path — not about making
  the full-page rebuild itself faster.

## Extra finding: this problem is specific to "Edit using AI" on raw/manual pages

Brand-new AI-generated pages (created via `generate` → `build`) are **not**
affected by this — every time their HTML is built or rebuilt, the same system
prompt forces every section to be wrapped in an `<!-- SL:name -->` marker, so
these markers are always reliably present.

The gap only exists for raw/manual HTML pages (like `tester26.html` —
hand-coded or scraped pages, which is exactly what "Edit using AI" exists to
handle). These pages only get markers from a one-time "prep" step
(`schema-from-html`) that runs the first time someone opens the AI editor for
them, and that step can leave some sections unmarked if its matching isn't
perfect. A page can also lose markers later if someone hand-edits the raw
HTML through the old "Edit HTML" CodeMirror modal, since that editor is
free-text with no marker enforcement.

Either way — missing/incomplete markers on a page is exactly what forces
`follow-up` into the expensive full-page path even for requests that should
be simple scoped edits.

## Fix plan (not yet built — todo list)

### Phase 1 — Make `schema-from-html`'s section-tagging reliable (prerequisite for everything below)

Originally we considered adding a separate "check and repair markers" step
inside the `follow-up` route itself. Simpler and better: fix it at the
source, in `schema-from-html`, since that's the one place responsible for
tagging sections in the first place — and it already runs, fully gated,
before a user can even submit a follow-up prompt (`AIBuilderClient` fires it
on mount and disables the send button until it finishes). So there's no need
to duplicate the check downstream.

1. [ ] Raise the section-match bar inside `schema-from-html` — sections
   should be tagged with close to 100% coverage, not just clear the current
   30% hard-fail floor (that floor was meant as a "something is badly broken"
   tripwire, not a target). Fields (individual text/image bits) can stay
   best-effort — sections are what matter for the new scoped operations below.
2. [ ] If a section fails to match on the first pass, retry just that section
   with a more forgiving matching strategy before giving up on it, within the
   same call — avoid a second AI round-trip if possible.
3. [ ] If some sections still can't be matched after that, keep logging it
   clearly (already does this via `console.warn`) — this becomes the signal
   Phase 3's fallback relies on: if a scoped operation can't find its target
   section's marker, it simply falls through to the existing full-page path.
   No extra "repair" infrastructure needed for that check.
4. [x] Confirmed (no code change needed): `AIBuilderClient`'s existing mount
   effect already re-fires `schema-from-html` whenever it sees `html_url` but
   no `schema_json` — so a page that loses its markers after a manual raw-HTML
   edit (which nulls `schema_json`) automatically gets re-tagged the next time
   the AI editor is opened for it. This case is already handled for free.

### Phase 2 — New scoped operations (the actual speed fix)

5. [ ] **Remove-section op**: routing identifies target section confidently
   → delete its `<!-- SL:name -->...<!-- /SL:name -->` span + drop its key
   from `schema_json`. No AI generation call needed.
6. [ ] **Reorder-sections op**: routing identifies the sections to move →
   extract both spans via the depth-aware span-finder (reuse from
   `schema-from-html`) → swap their positions in the HTML string. No AI
   generation call needed.
7. [ ] **Insert-section op**:
   - a. Extend the cheap Haiku routing call to also return an anchor section
     name + `before`/`after` (or a sensible default position if the user
     didn't specify one).
   - b. New scoped call: give the AI only the anchor section's HTML + the
     page's design tokens (`:root` CSS vars) + the instruction → get back one
     new section, pre-wrapped in its own deduped `<!-- SL:name -->`.
   - c. Splice the new section into the HTML at the anchor point.
   - d. Derive the new section's `schema_json` fields from its `data-field`
     attributes (a small, local version of the field-list technique
     `schema-from-html` already uses, just for one section instead of the
     whole page) so WYSIWYG click-to-edit works on it too.
8. [ ] **Edit/redesign an existing section** — mostly already works via the
   existing scoped-patch mechanism; just verify/tighten routing so a
   single-named-section redesign request reliably classifies as `patch`, not
   `structural`.

### Phase 3 — Fallback safety net (don't regress existing behavior)

9. [ ] Keep today's full-page rebuild as the last resort: if the
   target/anchor section's marker can't be confidently found, or the request
   is genuinely whole-page/vague ("make it feel more premium," "make it look
   more modern"), fall back to the existing full-page path unchanged.

### Phase 4 — Verify

10. [ ] Re-run the same test prompts used in this diagnosis
    (`tester26.html`: "add a pricing section after What You Get," "remove the
    ROI calculator," "move testimonials above stats-proof," "redesign the
    stats section") and confirm each now takes seconds instead of minutes,
    using the `ai-client` timing logs to prove which path was taken.
11. [ ] Confirm the two intentionally-excluded whole-page prompts ("make this
    page feel more premium," "make it look more modern") still correctly fall
    through to the full rebuild.
