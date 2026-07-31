// Shared helper for extracting a JSON object from an LLM text response.
//
// Prompts in this codebase instruct the model to "return ONLY valid JSON,
// no explanation" — but that's not enforced, and models sometimes prepend
// prose anyway (e.g. explaining a guardrail it applied) before the JSON
// block. Found live (2026-07-31): a generateHeroOverrides() response
// started with "I can't add a '10% discount' claim..." before its ```json
// fence, which broke the old `text.replace(/^```.../)` cleanup — that only
// strips a fence at the very start of the string, so prose-before-JSON
// passed straight through to JSON.parse() and threw.
//
// This instead looks for a fenced ```json``` block ANYWHERE in the text
// first (handles prose-before-JSON), then falls back to slicing from the
// first `{` to the last `}` (handles unfenced JSON with stray prose around
// it), rather than assuming the whole string is clean JSON.
export function extractJsonFromText(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) return fenced[1].trim();

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) return text.slice(first, last + 1);

  return text.trim();
}
