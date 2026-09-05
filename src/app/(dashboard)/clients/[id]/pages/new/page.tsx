import { redirect } from 'next/navigation';

/**
 * Dead entry point, kept as a redirect.
 *
 * This route rendered the builder with no page row behind it, so `pageId` was
 * null and `runBuild` returned immediately — the user got a working-looking
 * screen where Generate did nothing at all, silently. Nothing links here any
 * more; the real flow creates the page row first (see AIPagesClient) and opens
 * /ai-pages/new?page_id=…
 *
 * Redirecting rather than deleting because the URL is out there — old tabs and
 * bookmarks land somewhere useful instead of a 404.
 */
export default function LegacyAIBuilderRoute({ params }: { params: { id: string } }) {
  redirect(`/clients/${params.id}/ai-pages`);
}
