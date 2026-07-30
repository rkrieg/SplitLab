/**
 * Glowing/pulsing indicator for "new auto-detected UTM traffic available".
 * See docs/utm-personalization-v2-automation.md — this is the only
 * notification surface for the auto-detection flow (no dashboard-wide
 * notification center); it sits on the UTM Personalization entry point for
 * the specific page/variant that has something pending.
 */
export default function DetectionDot() {
  return (
    <span className="relative inline-flex h-2.5 w-2.5" title="New UTM traffic detected">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-indigo-500" />
    </span>
  );
}
