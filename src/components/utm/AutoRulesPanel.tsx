"use client";

import { useEffect, useState } from "react";
import { Sparkles, Plus, Trash2, Loader2, X } from "lucide-react";
import toast from "react-hot-toast";
import ConfirmDialog from "@/components/ui/ConfirmDialog";

// UTM Personalization V2, PIVOT 3 (2026-07-31). See docs/utm-personalization-v2-automation.md,
// "PIVOT 3" section. A rule is an ordered list of per-field rows, not a
// field-set + one shared hint. Each row: which field to watch, what to look
// for (literal filter value if personalize=false, loose AI category if
// personalize=true), and optional instructions for how to personalize.
// Table layout intentionally mirrors the existing manual-rule "When X = Y
// AND ..." UI the user already knows.

const FIELD_OPTIONS = [
  "utm_campaign",
  "utm_medium",
  "utm_source",
  "utm_content",
  "utm_term",
  "ad_id",
  "adset_id",
  "campaign_id",
  "creative_id",
  "placement_id",
];

// Per-field example text so the placeholder actually helps the user, instead
// of showing an unrelated "facebook" example on every field. Two variants per
// field: a literal-filter example (personalize off) and a loose-category
// example (personalize on). utm_campaign/medium/source/content/term carry
// human-readable naming conventions (client's own examples from the pivot
// call), so both modes have a real example. ad_id/adset_id/campaign_id/
// creative_id/placement_id are opaque platform-assigned numbers — filter
// mode still makes sense (match a specific known ID), but "category" mode
// is honestly flagged as rarely useful, since there's no readable text for
// AI to categorize.
const FIELD_EXAMPLES: Record<
  string,
  { filter: string; category: string; instructions: string }
> = {
  utm_campaign: {
    filter: 'e.g. "roofers_2024" — matches campaign names containing this text',
    category: 'e.g. "location (USA) etc" or "audience" (dentist etc)',
    instructions:
      "e.g. 'put the detected city or profession in the hero heading'",
  },
  utm_medium: {
    filter: 'e.g. "cpc" or "paid_social"',
    category: 'e.g. "channel type" (paid search vs. paid social vs. email)',
    instructions:
      "e.g. 'search traffic → answer their query directly; social traffic → lead with the visual/hook'",
  },
  utm_source: {
    filter: 'e.g. "facebook" — also matches Facebook_Ads, FB, etc.',
    category: 'e.g. "ad platform" (Facebook, Google, TikTok...)',
    instructions:
      "e.g. 'match the tone visitors expect coming from that platform'",
  },
  utm_content: {
    filter: 'e.g. "flash_sale_promo"',
    category: '"messaging angle" (urgency, affordable, guarantee...)',
    instructions:
      "e.g. 'urgency → deadline-driven copy; affordable → price/discount emphasis'",
  },
  utm_term: {
    filter: 'e.g. "roofing near me"',
    category: 'e.g. "search keyword theme"',
    instructions: "e.g. 'echo the searched keyword back in the headline'",
  },
  ad_id: {
    filter: 'e.g. "120987654321" — the exact ad ID from your ad platform',
    category:
      "Rarely useful — ad IDs are opaque numbers with no readable meaning to detect",
    instructions: "",
  },
  adset_id: {
    filter: 'e.g. "120987654321" — the exact ad set ID',
    category:
      "Rarely useful — ad set IDs are opaque numbers with no readable meaning to detect",
    instructions: "",
  },
  campaign_id: {
    filter: 'e.g. "120987654321" — the exact campaign ID',
    category:
      "Rarely useful — campaign IDs are opaque numbers with no readable meaning to detect",
    instructions: "",
  },
  creative_id: {
    filter: 'e.g. "120987654321" — the exact creative ID',
    category:
      "Rarely useful — creative IDs are opaque numbers with no readable meaning to detect",
    instructions: "",
  },
  placement_id: {
    filter: 'e.g. "120987654321" — the exact placement ID',
    category:
      "Rarely useful — placement IDs are opaque numbers with no readable meaning to detect",
    instructions: "",
  },
};

function placeholderFor(row: RuleRow): string {
  const examples = FIELD_EXAMPLES[row.field];
  if (!examples)
    return row.personalize
      ? 'e.g. "location" or "messaging angle"'
      : 'e.g. "facebook"';
  return row.personalize ? examples.category : examples.filter;
}

function instructionsPlaceholderFor(row: RuleRow): string {
  return (
    FIELD_EXAMPLES[row.field]?.instructions ||
    "e.g. 'how should this detected value change the hero content?'"
  );
}

const MAX_ROWS_PER_RULE = 5;

interface RuleRow {
  field: string;
  look_for: string;
  personalize: boolean;
  instructions?: string;
}

interface AutoRule {
  id: string;
  rows: RuleRow[];
  enabled: boolean;
  created_at: string;
}

interface Props {
  pageId: string;
}

function emptyRow(): RuleRow {
  return {
    field: FIELD_OPTIONS[0],
    look_for: "",
    personalize: false,
    instructions: "",
  };
}

export default function AutoRulesPanel({ pageId }: Props) {
  const [rules, setRules] = useState<AutoRule[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [rows, setRows] = useState<RuleRow[]>([emptyRow()]);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pages/${pageId}/auto-rules`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setRules(data.rules ?? []);
      })
      .catch(() => {
        if (!cancelled) setRules([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  function updateRow(index: number, patch: Partial<RuleRow>) {
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  // Each field may only be used once per rule — one row per field keeps the
  // "what am I watching" mental model unambiguous (no "utm_campaign AND
  // utm_campaign" confusion).
  function unusedField(currentRows: RuleRow[]): string | null {
    const used = new Set(currentRows.map((r) => r.field));
    return FIELD_OPTIONS.find((f) => !used.has(f)) ?? null;
  }

  function addRow() {
    if (rows.length >= MAX_ROWS_PER_RULE) return;
    const next = unusedField(rows);
    if (!next) {
      toast.error("All available fields are already used in this rule.");
      return;
    }
    setRows((prev) => [
      ...prev,
      { field: next, look_for: "", personalize: false, instructions: "" },
    ]);
  }

  async function saveRule() {
    if (rows.length === 0) {
      toast.error("Add at least one field row.");
      return;
    }
    for (const r of rows) {
      if (r.look_for.trim().length < 2) {
        toast.error(`Describe what to look for in "${r.field}".`);
        return;
      }
    }
    if (!rows.some((r) => r.personalize)) {
      toast.error(
        'Add at least one "Personalize with AI" row — a rule made only of filter rows never changes anything.',
      );
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/pages/${pageId}/auto-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save rule");
      setRules((prev) => [data.rule, ...(prev ?? [])]);
      setCreating(false);
      setRows([emptyRow()]);
      toast.success(
        "Auto-personalization rule saved. New matching traffic will be personalized automatically.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save rule");
    } finally {
      setSaving(false);
    }
  }

  async function deleteRule(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/pages/${pageId}/auto-rules?rule_id=${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete rule");
      setRules((prev) => (prev ?? []).filter((r) => r.id !== id));
    } catch {
      toast.error("Failed to delete rule");
    } finally {
      setDeletingId(null);
      setConfirmingDeleteId(null);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-400">
        Add a row per field. Unchecked rows filter by matching text (e.g. source
        contains "facebook"). Checked rows tell the AI what category to detect
        and how to personalize based on it. New matching traffic is personalized
        and published automatically — no review step.
      </p>

      {rules === null ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : (
        rules.map((r) => (
          <div
            key={r.id}
            className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
          >
            <div className="min-w-0 space-y-0.5">
              {(r.rows ?? []).map((row, i) => (
                <p
                  key={i}
                  className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate"
                >
                  {i > 0 && (
                    <span className="text-slate-400 font-normal">AND </span>
                  )}
                  {row.field} → {row.personalize ? "personalize: " : "match: "}
                  <span className="text-slate-400 font-normal">
                    "{row.look_for}"
                  </span>
                </p>
              ))}
            </div>
            <button
              onClick={() => setConfirmingDeleteId(r.id)}
              disabled={deletingId === r.id}
              className="p-1 text-red-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors flex-shrink-0"
              title="Remove rule"
            >
              {deletingId === r.id ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Trash2 size={12} />
              )}
            </button>
            <ConfirmDialog
              open={confirmingDeleteId === r.id}
              onClose={() => setConfirmingDeleteId(null)}
              onConfirm={() => deleteRule(r.id)}
              title="Remove this auto-personalization rule?"
              description="Future matching traffic will no longer be personalized. Rules/content already published from this rule stay live."
              confirmLabel="Remove"
              loading={deletingId === r.id}
            />
          </div>
        ))
      )}

      {creating ? (
        <div className="p-3 rounded-xl border-2 border-indigo-400 dark:border-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 space-y-1.5">
          {rows.map((row, i) => (
            <div key={i} className="space-y-1">
              <span className="text-xs text-slate-400 font-medium block">
                {i === 0 ? "When" : "AND"}
              </span>
              <div className="flex items-center gap-1.5">
                <select
                  value={row.field}
                  onChange={(e) => updateRow(i, { field: e.target.value })}
                  className="flex-shrink-0 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-700 dark:text-slate-200 focus:outline-none focus:border-indigo-400"
                >
                  {FIELD_OPTIONS.map((f) => {
                    const usedElsewhere = rows.some(
                      (r, j) => j !== i && r.field === f,
                    );
                    return (
                      <option key={f} value={f} disabled={usedElsewhere}>
                        {f}
                        {usedElsewhere ? " (in use)" : ""}
                      </option>
                    );
                  })}
                </select>
                <select
                  value={row.personalize ? "personalize" : "filter"}
                  onChange={(e) =>
                    updateRow(i, { personalize: e.target.value === "personalize" })
                  }
                  title={
                    row.personalize
                      ? "AI detects the value and rewrites the hero section"
                      : "Just filters traffic — no content change"
                  }
                  className="flex-shrink-0 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-700 dark:text-slate-200 focus:outline-none focus:border-indigo-400"
                >
                  <option value="filter">contains</option>
                  <option value="personalize">personalize:</option>
                </select>
                <input
                  type="text"
                  value={row.look_for}
                  onChange={(e) => updateRow(i, { look_for: e.target.value })}
                  placeholder={placeholderFor(row)}
                  className="min-w-0 flex-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-400"
                />
                {rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="p-1 text-slate-400 hover:text-red-400 transition-colors flex-shrink-0"
                    title="Remove row"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              {row.personalize && (
                <div>
                  <span className="text-[10px] text-slate-400 block mb-1">
                    → instructions
                  </span>
                  <input
                    type="text"
                    value={row.instructions ?? ""}
                    onChange={(e) =>
                      updateRow(i, { instructions: e.target.value })
                    }
                    placeholder={instructionsPlaceholderFor(row)}
                    className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-400"
                  />
                </div>
              )}
            </div>
          ))}

          {rows.length < MAX_ROWS_PER_RULE && (
            <button
              type="button"
              onClick={addRow}
              className="w-full flex items-center justify-center gap-1 text-[11px] px-2 py-1.5 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-indigo-300 hover:text-indigo-500"
            >
              <Plus size={11} /> Add More
            </button>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setRows([emptyRow()]);
              }}
              className="text-xs px-3 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveRule}
              disabled={saving}
              className="flex-1 flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium disabled:opacity-40"
            >
              {saving ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Sparkles size={12} />
              )}
              Save rule
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-indigo-300 hover:text-indigo-500"
        >
          <Plus size={12} /> Add auto-personalization rule
        </button>
      )}
    </div>
  );
}
