import { redirect } from 'next/navigation';

/**
 * Dead entry point, kept as a redirect. Same story as ../../new/page.tsx: it
 * mounted the builder with no page row, so Generate was a silent no-op.
 */
export default function LegacyAICreateRoute({ params }: { params: { id: string } }) {
  redirect(`/clients/${params.id}/ai-pages`);
}
