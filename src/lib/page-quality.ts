import type { Vertical, QualityCheck, QualityResult } from '@/types/page-builder';

export function scorePage(html: string, vertical: Vertical): QualityResult {
  const checks: QualityCheck[] = [];

  // 1. Viewport meta
  const hasViewport = /meta\s[^>]*name=["']viewport["']/i.test(html);
  checks.push({
    name: 'Viewport Meta',
    passed: hasViewport,
    score: hasViewport ? 10 : 0,
    detail: hasViewport ? 'Has viewport meta tag' : 'Missing viewport meta tag',
  });

  // 2. H1 exists
  const hasH1 = /<h1[\s>]/i.test(html);
  checks.push({
    name: 'H1 Heading',
    passed: hasH1,
    score: hasH1 ? 10 : 0,
    detail: hasH1 ? 'H1 heading found' : 'Missing H1 heading',
  });

  // 3. CTA present (button or link with action text)
  const ctaPattern = /<(button|a)\s[^>]*>.*?(get|start|call|contact|schedule|book|free|try|sign)/gi;
  const ctaMatches = html.match(ctaPattern) || [];
  const hasCta = ctaMatches.length > 0;
  checks.push({
    name: 'CTA Present',
    passed: hasCta,
    score: hasCta ? 15 : 0,
    detail: hasCta ? `${ctaMatches.length} CTA(s) found` : 'No clear CTA found',
  });

  // 4. Has form or phone number
  const hasForm = /<form[\s>]/i.test(html);
  const hasPhone = /tel:|(\(\d{3}\)\s*\d{3}[-.]?\d{4})|(\d{3}[-.]?\d{3}[-.]?\d{4})/i.test(html);
  const hasContact = hasForm || hasPhone;
  checks.push({
    name: 'Contact Method',
    passed: hasContact,
    score: hasContact ? 10 : 0,
    detail: hasForm ? 'Contact form found' : hasPhone ? 'Phone number found' : 'No form or phone number',
  });

  // 5. Social proof (testimonials, reviews, ratings)
  const socialProofPattern = /testimonial|review|rating|star|client|customer\ssay|trust/i;
  const hasSocialProof = socialProofPattern.test(html);
  checks.push({
    name: 'Social Proof',
    passed: hasSocialProof,
    score: hasSocialProof ? 10 : 0,
    detail: hasSocialProof ? 'Social proof elements found' : 'No social proof detected',
  });

  // 6. Trust signals (badges, certifications, guarantees)
  const trustPattern = /guarantee|certified|award|accredit|bbb|secure|privacy|license/i;
  const hasTrust = trustPattern.test(html);
  checks.push({
    name: 'Trust Signals',
    passed: hasTrust,
    score: hasTrust ? 10 : 0,
    detail: hasTrust ? 'Trust signals found' : 'No trust signals detected',
  });

  // 7. Responsive media queries
  const hasMediaQueries = /@media\s*\([^)]*max-width|@media\s*\([^)]*min-width/i.test(html);
  checks.push({
    name: 'Responsive Design',
    passed: hasMediaQueries,
    score: hasMediaQueries ? 10 : 0,
    detail: hasMediaQueries ? 'Responsive media queries found' : 'No responsive media queries',
  });

  // 8. Page size < 200KB
  const sizeKb = Buffer.byteLength(html, 'utf8') / 1024;
  const sizeOk = sizeKb < 200;
  checks.push({
    name: 'Page Size',
    passed: sizeOk,
    score: sizeOk ? 10 : 0,
    detail: `${Math.round(sizeKb)}KB ${sizeOk ? '(under 200KB limit)' : '(exceeds 200KB limit)'}`,
  });

  // 9. Data attributes for editing
  const hasDataAttrs = /data-sl-section/i.test(html) && /data-sl-editable/i.test(html);
  checks.push({
    name: 'Edit Attributes',
    passed: hasDataAttrs,
    score: hasDataAttrs ? 10 : 0,
    detail: hasDataAttrs ? 'SplitLab data attributes found' : 'Missing data-sl-section or data-sl-editable',
  });

  // 10. Vertical-specific checks
  const verticalCheck = checkVertical(html, vertical);
  checks.push(verticalCheck);

  const score = checks.reduce((sum, c) => sum + c.score, 0);
  return { score: Math.min(100, score), details: checks };
}

function checkVertical(html: string, vertical: Vertical): QualityCheck {
  switch (vertical) {
    case 'legal': {
      const hasDisclaimer = /disclaimer|attorney advertising|not legal advice|past results/i.test(html);
      return {
        name: 'Legal Compliance',
        passed: hasDisclaimer,
        score: hasDisclaimer ? 5 : 0,
        detail: hasDisclaimer ? 'Legal disclaimer found' : 'Missing legal disclaimer',
      };
    }
    case 'real_estate_financial': {
      const hasDisclosure = /equal housing|nmls|licensed|disclosure/i.test(html);
      return {
        name: 'Financial Disclosure',
        passed: hasDisclosure,
        score: hasDisclosure ? 5 : 0,
        detail: hasDisclosure ? 'Financial disclosure found' : 'Missing financial disclosure',
      };
    }
    case 'saas': {
      const hasPricing = /pricing|plan|month|free trial|start free/i.test(html);
      return {
        name: 'SaaS Elements',
        passed: hasPricing,
        score: hasPricing ? 5 : 0,
        detail: hasPricing ? 'Pricing/trial elements found' : 'No pricing or trial language',
      };
    }
    case 'local_services': {
      const hasLocal = /service area|near|local|city|zip|neighborhood/i.test(html);
      return {
        name: 'Local Signals',
        passed: hasLocal,
        score: hasLocal ? 5 : 0,
        detail: hasLocal ? 'Local service signals found' : 'No local service signals',
      };
    }
  }
}
