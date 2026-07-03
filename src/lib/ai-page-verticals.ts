/**
 * Single source of truth for AI page verticals — value, display label, and
 * badge color. Consumed by:
 *  - AIPagesClient.tsx (create modal dropdown + list table badges)
 *  - AIBuilderClient.tsx (builder header badge)
 *  - /api/pages/generate (server-side validation of the incoming `vertical`)
 *
 * Previously these three places each kept their own copy of the label list,
 * which drifted (the builder still only knew about 3 verticals after the
 * create modal already had a fourth). Import from here instead of adding a
 * new local copy.
 *
 * `value` strings are never renamed once shipped — they're stored on existing
 * `pages` rows in the DB. `lead_gen`/`saas`/`local` are the original three;
 * everything else is additive.
 */

export interface VerticalDef {
  value: string;
  label: string;
  colorClass: string;
}

export const VERTICALS: VerticalDef[] = [
  { value: 'lead_gen', label: 'Lead Gen', colorClass: 'bg-purple-500/10 text-purple-400 border-purple-500/20' },
  { value: 'saas', label: 'SaaS', colorClass: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
  { value: 'local', label: 'Local Services', colorClass: 'bg-green-500/10 text-green-400 border-green-500/20' },
  { value: 'ecommerce', label: 'E-commerce', colorClass: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  { value: 'real_estate', label: 'Real Estate', colorClass: 'bg-teal-500/10 text-teal-400 border-teal-500/20' },
  { value: 'healthcare_wellness', label: 'Healthcare & Wellness', colorClass: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' },
  { value: 'legal', label: 'Legal', colorClass: 'bg-slate-500/10 text-slate-400 border-slate-500/20' },
  { value: 'financial_services', label: 'Financial Services', colorClass: 'bg-sky-500/10 text-sky-400 border-sky-500/20' },
  { value: 'education_coaching', label: 'Education & Coaching', colorClass: 'bg-violet-500/10 text-violet-400 border-violet-500/20' },
  { value: 'events_webinars', label: 'Events & Webinars', colorClass: 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20' },
  { value: 'hospitality_travel', label: 'Hospitality & Travel', colorClass: 'bg-orange-500/10 text-orange-400 border-orange-500/20' },
  { value: 'fitness_beauty', label: 'Fitness & Beauty', colorClass: 'bg-rose-500/10 text-rose-400 border-rose-500/20' },
  { value: 'sales_info_product', label: 'Sales / Info Product', colorClass: 'bg-lime-500/10 text-lime-400 border-lime-500/20' },
  { value: 'nonprofit', label: 'Nonprofit', colorClass: 'bg-pink-500/10 text-pink-400 border-pink-500/20' },
  { value: 'other', label: 'Other', colorClass: 'bg-gray-500/10 text-gray-400 border-gray-500/20' },
];

export const VERTICAL_VALUES: string[] = VERTICALS.map(v => v.value);
export const VERTICAL_LABELS: Record<string, string> = Object.fromEntries(VERTICALS.map(v => [v.value, v.label]));
export const VERTICAL_COLORS: Record<string, string> = Object.fromEntries(VERTICALS.map(v => [v.value, v.colorClass]));
