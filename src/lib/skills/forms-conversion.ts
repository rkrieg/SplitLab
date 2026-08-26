import type { Skill } from './types';
import {
  attrValue,
  fieldPurposeText,
  findFormFields,
  hasAttr,
  labelRanges,
  labelledIds,
  stripCode,
} from './check-utils';

/**
 * Form mechanics — the one conversion surface nothing else in the stack covers.
 *
 * The base prompt has exactly one form rule (16px inputs, to stop iOS zooming).
 * Everything below it — input types, autocomplete, real labels, field count —
 * was unspecified, which means it was left to chance on the single element that
 * SplitLab exists to measure. A form that leaks visitors does not fail loudly:
 * the test still records the drop-off, and the report blames the page.
 *
 * Every rule here is a markup fact, so every rule here is genuinely checkable.
 * Nothing in this skill guesses at conversion rate.
 */

/** Field purposes we can infer from naming, and what each one should be. */
const PURPOSE_RULES: { purpose: RegExp; label: string; type: string; autocomplete: string }[] = [
  { purpose: /\b(e-?mail)\b|email/i, label: 'email', type: 'email', autocomplete: 'email' },
  { purpose: /\b(phone|tel|mobile|cell)\b/i, label: 'phone', type: 'tel', autocomplete: 'tel' },
  { purpose: /\b(zip|postcode|postal)\b/i, label: 'postcode', type: 'text', autocomplete: 'postal-code' },
];

export const formsConversion: Skill = {
  id: 'forms_conversion',
  name: 'Forms & Conversion',
  description:
    'Makes the form itself convert: the right mobile keyboard per field, browser autofill, real labels, and only the fields you actually need.',
  useFor:
    'Any page whose goal is a form submission — lead gen, quote requests, demo bookings, newsletter signups.',
  notFor:
    'A page with no form at all, where the only action is a phone call or an outbound link.',
  // Off by default at the client's request. Worth knowing if that is revisited:
  // on a page with no form every check here returns null and drops out, so it
  // costs nothing on the pages it does not apply to.

  generateBlock: `## Form fields — ask for the minimum
Only request fields the business genuinely needs to make first contact. Every extra field costs completions. Name, one contact method and (where it matters) a single qualifying question is usually the whole form. Do not add company size, budget, job title, "how did you hear about us" or a message box unless the brief asks for them.
The submit button's label states what the visitor gets ("Get my free quote"), never the mechanical action ("Submit").`,

  buildBlock: `## Form mechanics
- **Correct input type on every field.** Email fields are type="email", phone fields are type="tel", number fields are type="number" with inputmode set. On a phone this is the difference between a number pad and a full QWERTY keyboard, and it is the most common reason a mobile visitor abandons a form.
- **autocomplete on every field**, using the standard tokens: name, given-name, family-name, email, tel, organization, street-address, postal-code. This is what lets a browser fill the form in one tap. A field without it cannot be autofilled at all.
- **A real <label> for every field**, either wrapping the input or linked with for="id". Placeholder text is not a label: it disappears the moment the visitor starts typing, so by field three they no longer know what they are filling in. Placeholders are for format examples only ("(555) 010-0199").
- **required on the fields that are genuinely required**, and on nothing else. The browser's own validation is free and instant; do not write JavaScript validation.
- **Keep the form short.** Five user-facing fields is the working ceiling for a landing page. If the brief demands more, the extra fields belong on the page the form submits to, not in front of the conversion.
- **The submit button says what the visitor gets** — "Get my free quote", "Book my call" — never "Submit" or "Send". It is a full-width button on mobile.
- **No JavaScript form handling.** No fetch, no preventDefault, no custom validation — the tracker captures the submit event and external scripts are not permitted. A plain <form> with an action, or a form the client wires up later.
- Inputs stay at font-size: max(16px, 1rem) so iOS does not zoom on focus (this is a locked rule; restating it here because it lives on this element).`,

  checks: [
    {
      id: 'fields_labelled',
      label: 'Every field has a real label',
      run: (html) => {
        const fields = findFormFields(html);
        if (fields.length === 0) return null;
        const body = stripCode(html);
        const forIds = labelledIds(body);
        const ranges = labelRanges(body);
        const unlabelled = fields.filter((f) => {
          if (f.id && forIds.has(f.id)) return false;
          if (hasAttr(f.attrs, 'aria-label') || hasAttr(f.attrs, 'aria-labelledby')) return false;
          // A <label>Email <input></label> wrapper counts too.
          return !ranges.some(([start, end]) => f.index > start && f.index < end);
        });
        return unlabelled.length === 0
          ? {
              passed: true,
              detail:
                fields.length === 1
                  ? 'The one form field has a label.'
                  : `All ${fields.length} form fields have labels.`,
            }
          : {
              passed: false,
              detail: `${unlabelled.length} of ${fields.length} fields rely on placeholder text alone — that text vanishes as soon as the visitor types.`,
            };
      },
    },
    {
      id: 'input_types',
      label: 'Right keyboard on mobile',
      run: (html) => {
        const fields = findFormFields(html);
        if (fields.length === 0) return null;
        const wrong: string[] = [];
        let judged = 0;
        for (const f of fields) {
          const text = fieldPurposeText(f);
          const rule = PURPOSE_RULES.find((r) => r.purpose.test(text));
          // Only fields whose purpose we can actually read from the markup.
          // A field called "field_3" is not evidence of anything.
          if (!rule || rule.type === 'text') continue;
          judged++;
          if (f.type !== rule.type) wrong.push(rule.label);
        }
        if (judged === 0) return null;
        return wrong.length === 0
          ? { passed: true, detail: `Email and phone fields use the input types that trigger the right mobile keyboard.` }
          : {
              passed: false,
              detail: `The ${wrong.join(' and ')} field${wrong.length === 1 ? '' : 's'} use the wrong input type — phones will show a full keyboard instead of the right one.`,
            };
      },
    },
    {
      id: 'autocomplete',
      label: 'Browser autofill enabled',
      run: (html) => {
        const fields = findFormFields(html);
        if (fields.length === 0) return null;
        const missing = fields.filter((f) => !hasAttr(f.attrs, 'autocomplete'));
        return missing.length === 0
          ? { passed: true, detail: 'Every field carries an autocomplete token, so browsers can fill the form in one tap.' }
          : {
              passed: false,
              detail: `${missing.length} of ${fields.length} fields have no autocomplete attribute and cannot be autofilled.`,
            };
      },
    },
    {
      id: 'field_count',
      label: 'Form is short enough to finish',
      run: (html) => {
        const fields = findFormFields(html);
        if (fields.length === 0) return null;
        return fields.length <= 5
          ? {
              passed: true,
              detail: `${fields.length} field${fields.length === 1 ? '' : 's'} to complete.`,
            }
          : {
              passed: false,
              detail: `${fields.length} fields — over the 5 we aim for on a landing page. Each extra field costs completions.`,
            };
      },
    },
    {
      id: 'submit_copy',
      label: 'Submit button says what you get',
      run: (html) => {
        const body = stripCode(html);
        if (findFormFields(html).length === 0) return null;
        // The button element, or an <input type="submit"> and its value.
        const buttons = Array.from(body.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi))
          .filter((m) => {
            const type = (attrValue(m[1] ?? '', 'type') ?? '').toLowerCase();
            return type === 'submit' || type === '';
          })
          .map((m) => m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
        const submitInputs = Array.from(body.matchAll(/<input\b([^>]*)>/gi))
          .filter((m) => (attrValue(m[1] ?? '', 'type') ?? '').toLowerCase() === 'submit')
          .map((m) => attrValue(m[1] ?? '', 'value') ?? '');
        const labels = [...buttons, ...submitInputs].filter(Boolean);
        if (labels.length === 0) return null;
        const generic = labels.filter((t) => /^(submit|send|go|next|continue|ok)\b/i.test(t));
        return generic.length === 0
          ? { passed: true, detail: `Submit button reads "${labels[0]}".` }
          : {
              passed: false,
              detail: `A submit button reads "${generic[0]}" — it describes the mechanism, not what the visitor gets.`,
            };
      },
    },
  ],
};
