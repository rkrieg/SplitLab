# AI Page Generation — Test Prompts

For testing locally against dev env APIs (`npm run dev`, hits real Anthropic/OpenAI + dev Supabase via `.env.local`). Covers initial generation plus every follow-up branch: scoped image patch, full structural rewrite, competitor scrape, image-URL embed, named-section text edit, color/style preference override.

## Build with AI (initial generation) — run each as a fresh page

**1. Standard product/e-commerce (baseline)**
```
A pre-order landing page for "Nightset", a blackout shade that mounts over existing blinds. Target price $59, $10 refundable deposit to reserve. Use a warm amber accent color, dark moody hero. Include FAQ and a comparison table vs regular blackout curtains.
```

**2. SaaS / service business (tests non-physical-product schema handling)**
```
A landing page for "Ledgerly", an AI bookkeeping tool for freelancers. Free 14-day trial, no credit card required. Clean, trustworthy blue/white design. Include a pricing section with 3 tiers and a testimonials section.
```

**3. Compliance-heavy niche (tests legal/regulatory language handling)**
```
A lead-gen page for a CBD gummy brand launching soon. Founders get first access. Include a refund policy section, use "reserve" language everywhere instead of "buy" or "order", and repeat "fully refundable" near every payment touchpoint to stay compliant with ad platform policies.
```

**4. Explicit brand/style/icon preferences (tests priority-over-schema-defaults rule)**
```
A landing page for "Terra Roast", a small-batch coffee subscription. Use an earthy green and cream color palette, a hand-drawn/organic icon style (not generic flat icons), and a serif logo wordmark. Emphasize sustainability and direct-trade sourcing.
```

**5. Ambiguous/no explicit business name (tests name-resolution forcing)**
```
Build a landing page for a mobile dog-grooming service that comes to your house. $20 off first booking. Should feel friendly and trustworthy, not corporate.
```

## Edit with AI (follow-up) — run against any generated page above

**6. Scoped image generation only (tests the new fast scoped-patch path)**
```
Generate a new logo for the hero section and replace the current one.
```

**7. Ambiguous "new vs replace" phrasing (tests the disambiguation fix)**
```
Create a new hero background image and replace the current one with it.
```

**8. Named-section plain text edit (tests named-section override, should NOT trigger full rewrite)**
```
In the hero section, change the headline to "Wake up in total darkness, guaranteed."
```

**9. Uploaded/attached image swap (tests it's classified as scoped, not structural)**
*(attach an image file to the message)*
```
Use this image as the hero background instead of the current one.
```

**10. Plain image URL mentioned in prompt (tests Content-Type based classification, not full scrape)**
```
Set the process section image to this: https://picsum.photos/800/600
```

**11. Competitor URL mention (tests scrape-and-rebuild path, should NOT trigger on plain image links)**
```
Rebuild this page to match the style and structure of https://stripe.com/pricing
```

**12. Full structural rewrite (tests fallback to full-page path)**
```
Completely restructure this page — remove the comparison table, add a video testimonial section, add a 3-step "How it Works" section with icons, and move the FAQ above the reserve form.
```

**13. Multiple sections needing generated images (tests 1-3 section scoped-patch limit / fallback boundary)**
```
Generate new images for the hero, the process section, and the before/after section.
```

**14. Background-tone contrast check (tests per-section background-tone detection for generated logos)**
```
Generate a new logo for the footer and replace it — the footer background is nearly black, make sure the logo is visible against it.
```

**15. Low-confidence routing stress test (vague instruction, no section named)**
```
Make it feel more premium.
```

## Coverage notes

Run 6–15 against each of the 5 base pages for full cross-coverage. At minimum, run the full follow-up set once against page #1 and once against page #3 (compliance case — highest-risk for copy generation) to exercise every branch that changed recently.
