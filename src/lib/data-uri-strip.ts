// Inline base64 images (data: URIs) routinely dwarf the actual markup — a
// handful of embedded photos can turn a normal page into a multi-megabyte
// prompt that blows the model's context window (seen in practice: a 2.2MB
// page with base64 images → 2M+ tokens, rejected outright by the API).
// None of that image DATA is something a model needs to read to find field/
// section locations or to route/patch an edit — it only ever needs the
// surrounding tag — so every data: URI is swapped for a short placeholder
// before HTML/schema is ever sent to the AI, and the real bytes are restored
// afterward wherever the result is persisted or returned to the client.
const DATA_URI_RE = /data:[^\s"')]+/g;

export function extractDataUris(html: string): { html: string; map: Map<string, string> } {
  const map = new Map<string, string>();
  let i = 0;
  const swapped = html.replace(DATA_URI_RE, (match) => {
    const placeholder = `SL_DATAURI_${i++}_PLACEHOLDER`;
    map.set(placeholder, match);
    return placeholder;
  });
  return { html: swapped, map };
}

export function restoreDataUris(html: string, map: Map<string, string>): string {
  let result = html;
  map.forEach((original, placeholder) => {
    result = result.split(placeholder).join(original);
  });
  return result;
}

export function restoreDataUrisInValue(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => restoreDataUrisInValue(v, map));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = restoreDataUrisInValue(v, map);
    return out;
  }
  return value;
}
