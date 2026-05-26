"use client";

import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";

const CodeEditor = dynamic(() => import("@/components/pages/CodeEditor"), {
  ssr: false,
});
import toast from "react-hot-toast";
import {
  Download,
  RefreshCw,
  Trophy,
  TrendingUp,
  Code2,
  Copy,
  ChevronRight,
  ShieldCheck,
  ShieldX,
  FileCode2,
  Globe,
  ExternalLink,
  Plus,
  Trash2,
  Check,
  X,
  Pencil,
  BarChart3,
  Users,
  Settings as SettingsIcon,
  Sparkles,
  ScanLine,
  Phone,
  MousePointerClick,
  FormInput,
  Link2,
  ToggleLeft,
  Info,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import Spinner from "@/components/ui/Spinner";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { TestStatusBadge } from "@/components/ui/Badge";
import { formatPercent } from "@/lib/utils";

const GOAL_TYPES = [
  { value: "form_submit", label: "Form Submit" },
  { value: "button_click", label: "Button Click" },
  { value: "url_reached", label: "URL Reached" },
  { value: "call_click", label: "Call Click" },
];

interface Variant {
  id: string;
  name: string;
  is_control: boolean;
  traffic_weight: number;
  redirect_url?: string | null;
  proxy_mode?: boolean;
  pages?: { id: string; name: string } | null;
  tracking_verified?: boolean | null;
  is_ai_generated?: boolean;
  variant_type?: string;
  hosted_url?: string | null;
}

interface Goal {
  id: string;
  name: string;
  type: string;
  selector: string | null;
  url_pattern: string | null;
  is_primary: boolean;
}

interface VariantStat {
  variant: Variant;
  views: number;
  conversions: number;
  goalHits: number;
  cvr: number;
  confidence: number | null;
  isWinner: boolean;
}

interface Test {
  id: string;
  name: string;
  url_path: string;
  status: string;
  head_scripts?: string | null;
  test_variants?: Variant[];
  conversion_goals?: Goal[];
}

interface Lead {
  id: string;
  visitor_hash: string;
  metadata: Record<string, unknown>;
  created_at: string;
  test_variants: { name: string } | null;
  conversion_goals: { name: string } | null;
}

interface Props {
  test: Test;
  appUrl: string;
  clientId: string;
  clientName: string;
  domain?: string;
  userRole: string;
  userPlan: string;
}

type Tab = "overview" | "leads" | "settings";

export default function AnalyticsClient({
  test: initialTest,
  appUrl,
  clientId,
  clientName,
  domain,
  userRole,
  userPlan,
}: Props) {
  const [test, setTest] = useState(initialTest);
  const [tab, setTab] = useState<Tab>("overview");

  // Analytics
  const [stats, setStats] = useState<VariantStat[]>([]);
  const [totalViews, setTotalViews] = useState(0);
  const [totalConversions, setTotalConversions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Inline editing
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(test.name);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState(test.url_path);
  const [savingField, setSavingField] = useState(false);

  // Variant editing
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [variantDraft, setVariantDraft] = useState({
    name: "",
    redirect_url: "",
    proxy_mode: true,
  });
  const [savingVariant, setSavingVariant] = useState(false);

  // HTML editor modal
  const [htmlEditVariant, setHtmlEditVariant] = useState<Variant | null>(null);
  const [htmlDraft, setHtmlDraft] = useState("");
  const [loadingHtml, setLoadingHtml] = useState(false);
  const [savingHtml, setSavingHtml] = useState(false);

  // Tracker card dismissal (persisted per test in localStorage)
  const trackerDismissKey = `sl_tracker_dismissed_${test.id}`;
  const [trackerCardDismissed, setTrackerCardDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return (
      localStorage.getItem(`sl_tracker_dismissed_${initialTest.id}`) === "1"
    );
  });

  function dismissTrackerCard() {
    localStorage.setItem(trackerDismissKey, "1");
    setTrackerCardDismissed(true);
  }

  // Weight editing
  const [editingWeightId, setEditingWeightId] = useState<string | null>(null);
  const [weightDraft, setWeightDraft] = useState("");
  const [savingWeightId, setSavingWeightId] = useState<string | null>(null);

  // Delete variant
  const [deleteVariantId, setDeleteVariantId] = useState<string | null>(null);
  const [deletingVariant, setDeletingVariant] = useState(false);

  // Add variant
  const [addVariantOpen, setAddVariantOpen] = useState(false);
  const [newVariantName, setNewVariantName] = useState("");
  const [newVariantUrl, setNewVariantUrl] = useState("");
  const [newVariantUrlError, setNewVariantUrlError] = useState("");
  const [newVariantMode, setNewVariantMode] = useState<"url" | "html">("url");
  const [newVariantHtml, setNewVariantHtml] = useState("");
  const [addingVariant, setAddingVariant] = useState(false);
  const [addVariantError, setAddVariantError] = useState<{ message: string; isLimit: boolean } | null>(null);

  // Tracking verification
  const [checkingTracking, setCheckingTracking] = useState<string | null>(null);
  const [variantOverrides, setVariantOverrides] = useState<
    Record<string, boolean>
  >({});
  // Variants currently being auto-checked on load (silent, no toast)
  const [autoCheckingIds, setAutoCheckingIds] = useState<string[]>([]);
  const autoCheckedRef = useRef<Set<string>>(new Set());

  // Goals (settings tab)
  const [editGoals, setEditGoals] = useState<Goal[]>(() =>
    (initialTest.conversion_goals || []).map((g) => ({
      ...g,
      selector: g.selector || "",
      url_pattern: g.url_pattern || "",
    })),
  );
  const [savingGoals, setSavingGoals] = useState(false);

  // Head scripts (settings tab)
  const [headScriptsDraft, setHeadScriptsDraft] = useState(
    initialTest.head_scripts || "",
  );
  const [savingScripts, setSavingScripts] = useState(false);

  const [togglingStatus, setTogglingStatus] = useState(false);

  // Leads
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadsLoaded, setLeadsLoaded] = useState(false);

  // Page scanner
  interface ScanElement {
    type: string;
    id: string | null;
    text: string | null;
  }
  interface VariantScan {
    variant_id: string;
    variant_name: string;
    scanned_at: string;
    elements: ScanElement[];
  }
  interface ScanResults {
    variants: VariantScan[];
  }
  const [scanResults, setScanResults] = useState<ScanResults | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scannedVariantName, setScannedVariantName] = useState<string | null>(
    null,
  );
  const [scanResultsLoaded, setScanResultsLoaded] = useState(false);

  // Computed
  const variants = test.test_variants || [];
  const snippet = `<script src="${appUrl}/tracker.js"></script>`;
  const fullUrl = domain ? `${domain}${test.url_path}` : null;

  // True when every variant is a pure redirect (proxy_mode = false + redirect_url set).
  // In this mode SplitLab never serves any HTML, so head_scripts are never injected.
  const allPureRedirect =
    variants.length > 0 &&
    variants.every((v) => !!v.redirect_url && v.proxy_mode === false);

  const anyTrackerMissing = variants.some(
    (v) =>
      !!v.redirect_url &&
      (variantOverrides[v.id] !== undefined
        ? variantOverrides[v.id]
        : v.tracking_verified) === false,
  );

  // ─── Analytics ──────────────────────────────────────────────────────

  const fetchAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const res = await fetch(`/api/tests/${test.id}/analytics?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (data.test) setTest(data.test);
      setStats(data.variantStats ?? []);
      setTotalViews(data.totalViews ?? 0);
      setTotalConversions(data.totalConversions ?? 0);
    } catch {
      toast.error("Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [test.id, from, to]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  // Auto-check tracker on load for redirect variants that have never been verified.
  // Uses `variants` (from SSR props) not `stats` — analytics response may omit tracking_verified.
  useEffect(() => {
    if (variants.length === 0) return;
    const toCheck = variants.filter(
      (v) =>
        v.redirect_url &&
        v.tracking_verified == null && // null OR undefined = never checked
        !autoCheckedRef.current.has(v.id),
    );
    if (toCheck.length === 0) return;

    setAutoCheckingIds((prev) => [...prev, ...toCheck.map((v) => v.id)]);

    for (const v of toCheck) {
      autoCheckedRef.current.add(v.id);
      fetch("/api/check-tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: v.redirect_url, variant_id: v.id }),
      })
        .then((r) => r.json())
        .then((data) => {
          setVariantOverrides((prev) => ({ ...prev, [v.id]: data.verified }));
          setAutoCheckingIds((prev) => prev.filter((id) => id !== v.id));
        })
        .catch(() => {
          setAutoCheckingIds((prev) => prev.filter((id) => id !== v.id));
          autoCheckedRef.current.delete(v.id); // allow retry on next render
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount — autoCheckedRef prevents duplicates

  const winner = stats.find((s) => s.isWinner);
  const overallCvr = totalViews > 0 ? totalConversions / totalViews : 0;

  function exportCsv() {
    const headers = [
      "Variant",
      "Control",
      "Views",
      "Conversions",
      "Goal Hits",
      "CVR",
      "Confidence",
      "Winner",
    ];
    const rows = stats.map((s) => [
      s.variant.name,
      s.variant.is_control ? "Yes" : "No",
      s.views,
      s.conversions,
      s.goalHits,
      formatPercent(s.cvr * 100),
      s.confidence !== null ? formatPercent(s.confidence) : "N/A",
      s.isWinner ? "Yes" : "No",
    ]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${test.name.replace(/\s+/g, "_")}_analytics.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Inline field saves ─────────────────────────────────────────────

  async function saveField(field: "name" | "url_path", value: string) {
    setSavingField(true);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        toast.error("Failed to save");
        return;
      }
      const updated = await res.json();
      setTest(updated);
      toast.success("Saved");
      if (field === "name") setEditingName(false);
      if (field === "url_path") setEditingPath(false);
    } catch {
      toast.error("Failed to save");
    } finally {
      setSavingField(false);
    }
  }

  // ─── Status toggle ──────────────────────────────────────────────────

  async function toggleStatus() {
    setTogglingStatus(true);
    const newStatus = test.status === "active" ? "paused" : "active";
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        toast.error("Failed to update status");
        return;
      }
      const updated = await res.json();
      setTest(updated);
      toast.success(newStatus === "active" ? "Published" : "Unpublished");
    } finally {
      setTogglingStatus(false);
    }
  }

  // ─── Weight editing ─────────────────────────────────────────────────

  function startEditWeight(variantId: string, currentWeight: number) {
    setEditingWeightId(variantId);
    setWeightDraft(String(currentWeight));
  }

  async function saveWeight() {
    const variantId = editingWeightId;
    if (!variantId) return;
    const newWeight = Math.max(
      0,
      Math.min(100, Math.round(Number(weightDraft))),
    );
    if (isNaN(newWeight)) {
      setEditingWeightId(null);
      return;
    }
    setEditingWeightId(null);

    const otherVariants = variants.filter((v) => v.id !== variantId);
    const remaining = 100 - newWeight;
    const weights: { id: string; traffic_weight: number }[] = [
      { id: variantId, traffic_weight: newWeight },
    ];

    if (otherVariants.length === 0) {
      weights[0].traffic_weight = 100;
    } else {
      const currentOtherTotal = otherVariants.reduce(
        (s, v) => s + v.traffic_weight,
        0,
      );
      if (currentOtherTotal === 0) {
        const each = Math.floor(remaining / otherVariants.length);
        let leftover = remaining - each * otherVariants.length;
        for (const v of otherVariants) {
          weights.push({
            id: v.id,
            traffic_weight: each + (leftover-- > 0 ? 1 : 0),
          });
        }
      } else {
        let allocated = 0;
        for (let i = 0; i < otherVariants.length; i++) {
          const v = otherVariants[i];
          if (i === otherVariants.length - 1) {
            weights.push({ id: v.id, traffic_weight: remaining - allocated });
          } else {
            const w = Math.round(
              (v.traffic_weight / currentOtherTotal) * remaining,
            );
            weights.push({ id: v.id, traffic_weight: w });
            allocated += w;
          }
        }
      }
    }

    setSavingWeightId(variantId);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weights }),
      });
      if (!res.ok) {
        toast.error("Weights must sum to 100");
        return;
      }
      const updated = await res.json();
      setTest(updated);
      const updatedVariants: Variant[] = updated.test_variants ?? [];
      setStats((prev) =>
        prev.map((s) => {
          const v = updatedVariants.find((u) => u.id === s.variant.id);
          return v
            ? {
                ...s,
                variant: { ...s.variant, traffic_weight: v.traffic_weight },
              }
            : s;
        }),
      );
      toast.success("Weights updated");
    } catch {
      toast.error("Failed to save weights");
    } finally {
      setSavingWeightId(null);
    }
  }

  // ─── Variant editing ────────────────────────────────────────────────

  function startEditVariant(v: Variant) {
    if (editingVariantId === v.id) {
      setEditingVariantId(null);
      return;
    }
    setEditingVariantId(v.id);
    setVariantDraft({
      name: v.name,
      redirect_url: v.redirect_url || "",
      proxy_mode: v.proxy_mode !== false,
    });
  }

  async function saveVariant(variantId: string) {
    setSavingVariant(true);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variant_updates: [
            {
              id: variantId,
              name: variantDraft.name,
              redirect_url: variantDraft.redirect_url || null,
              proxy_mode: variantDraft.proxy_mode,
            },
          ],
        }),
      });
      if (!res.ok) {
        toast.error("Failed to save variant");
        return;
      }
      const updated = await res.json();
      setTest(updated);
      setEditingVariantId(null);
      // Re-check tracker if this is a redirect variant (URL may have changed)
      if (variantDraft.redirect_url)
        autoCheckVariant(variantId, variantDraft.redirect_url);
      toast.success("Variant updated");
      fetchAnalytics();
    } catch {
      toast.error("Failed to save");
    } finally {
      setSavingVariant(false);
    }
  }

  async function openHtmlEditor(variant: Variant) {
    setHtmlEditVariant(variant);
    setHtmlDraft("");
    const pageId = variant.pages?.id;
    if (!pageId) return;
    setLoadingHtml(true);
    try {
      const res = await fetch(`/api/pages/${pageId}`);
      const data = await res.json();
      setHtmlDraft(data.html_content || "");
    } catch {
      toast.error("Failed to load HTML");
    } finally {
      setLoadingHtml(false);
    }
  }

  async function saveHtml() {
    const pageId = htmlEditVariant?.pages?.id;
    if (!pageId) return;
    setSavingHtml(true);
    try {
      const res = await fetch(`/api/pages/${pageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html_content: htmlDraft }),
      });
      if (!res.ok) {
        toast.error("Failed to save HTML");
        return;
      }
      toast.success("HTML updated — live variant will reflect the changes");
      setHtmlEditVariant(null);
    } catch {
      toast.error("Failed to save HTML");
    } finally {
      setSavingHtml(false);
    }
  }

  async function deleteVariant() {
    if (!deleteVariantId) return;
    setDeletingVariant(true);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete_variant_id: deleteVariantId }),
      });
      if (!res.ok) {
        toast.error("Failed to delete variant");
        return;
      }
      const updated = await res.json();
      setTest(updated);
      setEditingVariantId(null);
      setScanResults(null);
      setScanResultsLoaded(false);
      toast.success("Variant deleted");
      fetchAnalytics();
    } catch {
      toast.error("Failed to delete");
    } finally {
      setDeletingVariant(false);
      setDeleteVariantId(null);
    }
  }

  // ─── Add variant ────────────────────────────────────────────────────

  async function handleAddVariant(e: React.FormEvent) {
    e.preventDefault();
    if (newVariantMode === "url") {
      const trimmed = newVariantUrl.trim();
      if (!trimmed) {
        setNewVariantUrlError("Please enter a destination URL.");
        return;
      }
      try {
        new URL(trimmed);
      } catch {
        setNewVariantUrlError(
          "Please enter a valid URL (e.g. https://example.com).",
        );
        return;
      }
      setNewVariantUrlError("");
    }
    setAddingVariant(true);
    try {
      const count = variants.length + 1;
      const weight = Math.floor(100 / count);
      const remainder = 100 - weight * count;

      const payload =
        newVariantMode === "html"
          ? {
              name: newVariantName,
              html_content: newVariantHtml,
              traffic_weight: weight + remainder,
            }
          : {
              name: newVariantName,
              redirect_url: newVariantUrl,
              proxy_mode: true,
              traffic_weight: weight + remainder,
            };
      const res = await fetch(`/api/tests/${test.id}/variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json();
        const msg = err.error || "Failed to add variant";
        toast.error(msg);
        setAddVariantError({ message: msg, isLimit: !!err.limitError });
        return;
      }
      const updated = await res.json();

      // Equalize weights
      const allVariants = updated.test_variants || [];
      const equalWeight = Math.floor(100 / allVariants.length);
      const rem = 100 - equalWeight * allVariants.length;
      const weights = allVariants.map((v: Variant, i: number) => ({
        id: v.id,
        traffic_weight: equalWeight + (i === 0 ? rem : 0),
      }));

      const wRes = await fetch(`/api/tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weights }),
      });
      const finalTest = wRes.ok ? await wRes.json() : updated;
      setTest(finalTest);
      // Auto-check tracker for the newly added redirect variant
      const previousIds = new Set(variants.map((v) => v.id));
      const newVariant = (finalTest.test_variants || []).find(
        (v: Variant) => !previousIds.has(v.id),
      );
      if (newVariant?.redirect_url)
        autoCheckVariant(newVariant.id, newVariant.redirect_url);
      setAddVariantOpen(false);
      setNewVariantName("");
      setNewVariantUrl("");
      setNewVariantHtml("");
      setNewVariantMode("url");
      setAddVariantError(null);
      toast.success("Variant added");
      fetchAnalytics();
    } catch {
      toast.error("Failed to add variant");
    } finally {
      setAddingVariant(false);
    }
  }

  // ─── Tracking check ─────────────────────────────────────────────────

  function autoCheckVariant(variantId: string, url: string) {
    autoCheckedRef.current.delete(variantId); // allow re-check (URL may have changed)
    setAutoCheckingIds((prev) => [...prev, variantId]);
    autoCheckedRef.current.add(variantId);
    fetch("/api/check-tracking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, variant_id: variantId }),
    })
      .then((r) => r.json())
      .then((data) => {
        setVariantOverrides((prev) => ({
          ...prev,
          [variantId]: data.verified,
        }));
        setAutoCheckingIds((prev) => prev.filter((id) => id !== variantId));
      })
      .catch(() => {
        setAutoCheckingIds((prev) => prev.filter((id) => id !== variantId));
        autoCheckedRef.current.delete(variantId);
      });
  }

  function getVerifiedStatus(v: Variant) {
    if (variantOverrides[v.id] !== undefined) return variantOverrides[v.id];
    return v.tracking_verified;
  }

  async function checkTracking(variantId: string, url: string) {
    setCheckingTracking(variantId);
    try {
      const res = await fetch("/api/check-tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, variant_id: variantId }),
      });
      const data = await res.json();
      setVariantOverrides((prev) => ({ ...prev, [variantId]: data.verified }));
      toast[data.verified ? "success" : "error"](
        data.verified ? "Tracker verified" : "Tracker not found",
      );
    } catch {
      toast.error("Check failed");
    } finally {
      setCheckingTracking(null);
    }
  }

  // ─── Goals ───────────────────────────────────────────────────────────

  async function handleSaveGoals(e: React.FormEvent) {
    e.preventDefault();
    setSavingGoals(true);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goals: editGoals.map((g) => ({
            ...(g.id ? { id: g.id } : {}),
            name: g.name,
            type: g.type,
            selector: g.selector || null,
            url_pattern: g.url_pattern || null,
            is_primary: g.is_primary,
          })),
        }),
      });
      if (!res.ok) {
        toast.error("Failed to save goals");
        return;
      }
      const updated = await res.json();
      setTest(updated);
      setEditGoals(
        (updated.conversion_goals || []).map((g: Goal) => ({
          ...g,
          selector: g.selector || "",
          url_pattern: g.url_pattern || "",
        })),
      );
      toast.success("Goals saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSavingGoals(false);
    }
  }

  // ─── Head Scripts ────────────────────────────────────────────────────

  async function saveHeadScripts() {
    setSavingScripts(true);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ head_scripts: headScriptsDraft || null }),
      });
      if (!res.ok) {
        toast.error("Failed to save");
        return;
      }
      const updated = await res.json();
      setTest(updated);
      toast.success("Scripts saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSavingScripts(false);
    }
  }

  // ─── Leads ───────────────────────────────────────────────────────────

  const fetchLeads = useCallback(async () => {
    setLeadsLoading(true);
    try {
      const res = await fetch(`/api/tests/${test.id}/leads`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setLeads(data.leads || []);
      setLeadsLoaded(true);
    } catch {
      toast.error("Failed to load leads");
    } finally {
      setLeadsLoading(false);
    }
  }, [test.id]);

  useEffect(() => {
    if (tab === "leads" && !leadsLoaded) fetchLeads();
  }, [tab, leadsLoaded, fetchLeads]);

  useEffect(() => {
    if (tab === "settings" && !scanResultsLoaded && !scanning) {
      setScanResultsLoaded(true);
      fetch(`/api/tests/${test.id}/scan-results`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.scan_results?.variants) setScanResults(data.scan_results);
        })
        .catch(() => {});
    }
  }, [tab, scanResultsLoaded, scanning, test.id]);

  // ─── Page Scanner ────────────────────────────────────────────────────

  function buildVariantUrl(
    variantId: string,
    extraParams: Record<string, string> = {},
  ): string {
    const isLocalhost =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    const params = new URLSearchParams({ sl_vid: variantId, ...extraParams });
    if (!domain) {
      // No custom domain — use preview mode via test ID so free users can still open variants
      const base = isLocalhost
        ? `http://localhost:${window.location.port || 3000}`
        : appUrl;
      return `${base}/api/serve?preview_test_id=${test.id}&${params}`;
    }
    const rawDomain = domain.replace(/^https?:\/\//, "");
    if (isLocalhost) {
      return `http://localhost:${window.location.port || 3000}/api/serve?domain=${encodeURIComponent(rawDomain)}&path=${encodeURIComponent(test.url_path)}&${params}`;
    }
    return `https://${domain}${test.url_path}?${params}`;
  }

  /** Open the full test as a fresh visitor — variant is assigned by SplitLab (no forced variant) */
  function buildTestPreviewUrl(): string {
    const freshHash = crypto.randomUUID();
    const isLocalhost =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    if (!domain) {
      const base = isLocalhost
        ? `http://localhost:${window.location.port || 3000}`
        : appUrl;
      return `${base}/api/serve?preview_test_id=${test.id}&sl_vh=${freshHash}`;
    }
    const rawDomain = domain.replace(/^https?:\/\//, "");
    if (isLocalhost) {
      return `http://localhost:${window.location.port || 3000}/api/serve?domain=${encodeURIComponent(rawDomain)}&path=${encodeURIComponent(test.url_path)}&sl_vh=${freshHash}`;
    }
    return `https://${domain}${test.url_path}?sl_vh=${freshHash}`;
  }

  function openVariant(variantId: string) {
    const freshHash = crypto.randomUUID();
    window.open(buildVariantUrl(variantId, { sl_vh: freshHash }), "_blank");
  }

  async function scanPage(variantId: string) {
    const targetVariant = variants.find((v) => v.id === variantId);
    if (!targetVariant) return;

    const scanUrl = buildVariantUrl(variantId, { sl_scan: "1" });
    const scanStartedAt = Date.now();
    window.open(scanUrl, "_blank");
    setScanning(true);
    setScanResults(null);
    setScannedVariantName(targetVariant.name);
    setTab("settings");

    // Poll for results (up to 30 s, every 2 s)
    // Only accept results with scanned_at AFTER we opened the tab
    let attempts = 0;
    const maxAttempts = 15;
    const poll = async () => {
      try {
        const res = await fetch(`/api/tests/${test.id}/scan-results`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        const variantEntry = data.scan_results?.variants?.find(
          (v: { variant_id: string; scanned_at: string }) =>
            v.variant_id === variantId,
        );
        if (variantEntry) {
          const resultTime = new Date(variantEntry.scanned_at).getTime();
          if (resultTime > scanStartedAt) {
            setScanResults(data.scan_results);
            setScanning(false);
            return;
          }
        }
      } catch {
        /* keep polling */
      }
      attempts++;
      if (attempts < maxAttempts) {
        setTimeout(poll, 2000);
      } else {
        setScanning(false);
        toast.error(
          "Scan timed out. Make sure tracker.js is installed and the page loaded.",
        );
      }
    };
    setTimeout(poll, 3000); // give the page 3 s to load before first poll
  }

  async function enableAsGoal(el: {
    type: string;
    id: string | null;
    text: string | null;
  }) {
    const goalTypeMap: Record<string, string> = {
      form: "form_submit",
      button: "button_click",
      cta_link: "button_click",
      link: "button_click",
      toggle: "button_click",
      call: "call_click",
    };
    const goalType = goalTypeMap[el.type] || "button_click";

    let selector: string | null = null;
    if (el.id) {
      selector = `id:${el.id}`;
    } else if (el.text) {
      selector = `text:${el.text}`;
    }

    const label = el.text || el.id || el.type;
    const newGoal: Goal = {
      id: "",
      name: label.slice(0, 60),
      type: goalType,
      selector,
      url_pattern: null,
      is_primary: editGoals.length === 0,
    };

    const originalGoals = editGoals;
    const updatedGoals = [...editGoals, newGoal];
    setEditGoals(updatedGoals);

    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goals: updatedGoals.map((g) => ({
            ...(g.id ? { id: g.id } : {}),
            name: g.name,
            type: g.type,
            selector: g.selector || null,
            url_pattern: g.url_pattern || null,
            is_primary: g.is_primary,
          })),
        }),
      });
      if (!res.ok) {
        setEditGoals(originalGoals);
        toast.error("Failed to save goal");
        return;
      }
      const updated = await res.json();
      setTest(updated);
      setEditGoals(
        (updated.conversion_goals || []).map((g: Goal) => ({
          ...g,
          selector: g.selector || "",
          url_pattern: g.url_pattern || "",
        })),
      );
      toast.success(`Goal "${newGoal.name}" enabled`);
    } catch {
      setEditGoals(originalGoals);
      toast.error("Failed to save goal");
    }
  }

  async function removeGoalBySelector(el: {
    id: string | null;
    text: string | null;
  }) {
    const matchSelector = el.id
      ? `id:${el.id}`
      : el.text
        ? `text:${el.text}`
        : null;
    if (!matchSelector) return;

    const originalGoals = editGoals;
    const updatedGoals = editGoals.filter((g) => g.selector !== matchSelector);
    if (updatedGoals.length === originalGoals.length) return; // nothing matched
    setEditGoals(updatedGoals);

    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goals: updatedGoals.map((g) => ({
            ...(g.id ? { id: g.id } : {}),
            name: g.name,
            type: g.type,
            selector: g.selector || null,
            url_pattern: g.url_pattern || null,
            is_primary: g.is_primary,
          })),
        }),
      });
      if (!res.ok) {
        setEditGoals(originalGoals);
        toast.error("Failed to remove goal");
        return;
      }
      const updated = await res.json();
      setTest(updated);
      setEditGoals(
        (updated.conversion_goals || []).map((g: Goal) => ({
          ...g,
          selector: g.selector || "",
          url_pattern: g.url_pattern || "",
        })),
      );
      toast.success("Goal removed");
    } catch {
      setEditGoals(originalGoals);
      toast.error("Failed to remove goal");
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "overview", label: "Overview", icon: <BarChart3 size={14} /> },
    { key: "leads", label: "Leads", icon: <Users size={14} /> },
    { key: "settings", label: "Settings", icon: <SettingsIcon size={14} /> },
  ];

  return (
    <div>
      {/* ═══ HEADER ═══ */}
      <div className="border-b border-slate-200 dark:border-slate-800 px-6 py-4 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-3">
          <Link
            href={`/clients/${clientId}/pages`}
            className="hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
          >
            {clientName}
          </Link>
          <ChevronRight size={12} />
          <Link
            href={`/clients/${clientId}/pages`}
            className="hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
          >
            Pages
          </Link>
          <ChevronRight size={12} />
          <span className="text-slate-500 dark:text-slate-400">
            {test.name}
          </span>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {editingName ? (
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                className="input-base text-lg font-semibold py-1 px-2 w-full max-w-md"
                autoFocus
                disabled={savingField}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveField("name", nameDraft);
                  if (e.key === "Escape") {
                    setEditingName(false);
                    setNameDraft(test.name);
                  }
                }}
                onBlur={() => {
                  if (nameDraft.trim() && nameDraft !== test.name)
                    saveField("name", nameDraft);
                  else {
                    setEditingName(false);
                    setNameDraft(test.name);
                  }
                }}
              />
            ) : (
              <div className="flex items-center gap-2">
                <h1
                  className="text-xl font-semibold text-slate-900 dark:text-slate-100 cursor-pointer hover:text-indigo-400 transition-colors inline-block"
                  onClick={() => setEditingName(true)}
                  title="Click to edit"
                >
                  {test.name}
                </h1>
                <TestStatusBadge status={test.status} />
              </div>
            )}

            <div className="flex items-center gap-2 mt-1">
              {editingPath ? (
                <div className="flex items-center gap-1">
                  {domain && (
                    <span className="text-slate-500 text-sm font-mono">
                      {domain}
                    </span>
                  )}
                  <input
                    type="text"
                    value={pathDraft}
                    onChange={(e) => setPathDraft(e.target.value)}
                    className="input-base font-mono text-sm py-0.5 px-1.5 w-48"
                    autoFocus
                    disabled={savingField}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveField("url_path", pathDraft);
                      if (e.key === "Escape") {
                        setEditingPath(false);
                        setPathDraft(test.url_path);
                      }
                    }}
                    onBlur={() => {
                      if (pathDraft.trim() && pathDraft !== test.url_path)
                        saveField("url_path", pathDraft);
                      else {
                        setEditingPath(false);
                        setPathDraft(test.url_path);
                      }
                    }}
                  />
                </div>
              ) : fullUrl ? (
                <div className="flex items-center gap-2">
                  <a
                    href={`https://${fullUrl}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-mono text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors"
                  >
                    <Globe size={12} />
                    {fullUrl}
                    <ExternalLink size={10} />
                  </a>
                  <button
                    onClick={() => setEditingPath(true)}
                    className="text-slate-400 dark:text-slate-600 hover:text-slate-700 dark:hover:text-slate-300 transition-colors p-0.5"
                    title="Edit path"
                  >
                    <Pencil size={11} />
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => setEditingPath(true)}
                    className="text-sm font-mono text-slate-500 dark:text-slate-400 hover:text-indigo-400 transition-colors text-left"
                    title="Click to edit path"
                  >
                    {test.url_path}
                  </button>
                  {/* No domain configured — show the preview URL so it can be shared/tested */}
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-500">
                      Preview URL:
                    </span>
                    <code className="text-[11px] text-indigo-400 font-mono truncate max-w-[320px]">
                      {appUrl}/api/serve?preview_test_id={test.id}
                    </code>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `${appUrl}/api/serve?preview_test_id=${test.id}`,
                        );
                        toast.success("Preview URL copied");
                      }}
                      className="text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0"
                      title="Copy preview URL"
                    >
                      <Copy size={11} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 flex-shrink-0">
            <div className="flex items-center gap-4 text-sm border-r border-slate-200 dark:border-slate-700 pr-4">
              <div className="text-center">
                <p className="text-slate-900 dark:text-slate-100 font-semibold">
                  {totalViews.toLocaleString()}
                </p>
                <p className="text-slate-500 text-[10px]">Views</p>
              </div>
              <div className="text-center">
                <p className="text-slate-900 dark:text-slate-100 font-semibold">
                  {totalConversions.toLocaleString()}
                </p>
                <p className="text-slate-500 text-[10px]">Conversions</p>
              </div>
              <div className="text-center">
                <p className="text-slate-900 dark:text-slate-100 font-semibold">
                  {formatPercent(overallCvr * 100)}
                </p>
                <p className="text-slate-500 text-[10px]">CVR</p>
              </div>
            </div>

            <button
              onClick={() => window.open(buildTestPreviewUrl(), "_blank")}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-slate-500/10 border border-slate-500/20 text-slate-400 hover:bg-slate-500/20 hover:text-slate-300"
              title="Open the test as a fresh visitor — SplitLab assigns the variant"
            >
              <ExternalLink size={14} /> Preview Test
            </button>

            {!domain &&
              userRole !== "viewer" &&
              (userRole === "admin" || userPlan !== "free") && (
                <Link
                  href={`/clients/${clientId}/domains`}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/30 hover:text-indigo-200 ring-1 ring-indigo-500/30"
                >
                  <Globe size={14} /> Add Domain
                </Link>
              )}

            <button
              onClick={toggleStatus}
              disabled={togglingStatus}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-60 ${
                test.status === "active"
                  ? "bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25"
                  : "bg-green-500/15 border border-green-500/30 text-green-400 hover:bg-green-500/25"
              }`}
            >
              {togglingStatus ? (
                <>
                  <Spinner size="sm" />
                  {test.status === "active" ? "Unpublishing…" : "Publishing…"}
                </>
              ) : test.status === "active" ? (
                "Unpublish"
              ) : (
                "Publish"
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ═══ TABS ═══ */}
      <div className="border-b border-slate-200 dark:border-slate-800 px-6 flex">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══ TAB CONTENT ═══ */}
      <div className="p-6 space-y-6">
        {/* ─── OVERVIEW TAB ─── */}
        {tab === "overview" && (
          <>
            {variants.some((v) => v.redirect_url) &&
              (anyTrackerMissing || !trackerCardDismissed) && (
                <div
                  className={`flex items-start gap-3 rounded-xl p-4 border ${anyTrackerMissing ? "bg-red-500/10 border-red-500/40" : "bg-indigo-500/10 border-indigo-500/30"}`}
                >
                  <Code2
                    size={16}
                    className={`flex-shrink-0 mt-0.5 ${anyTrackerMissing ? "text-red-400" : "text-indigo-400"}`}
                  />
                  <div className="flex-1 min-w-0">
                    <p
                      className={`font-medium text-sm ${anyTrackerMissing ? "text-red-400" : "text-indigo-400"}`}
                    >
                      {anyTrackerMissing
                        ? "Tracker not detected — paste the snippet on your destination page"
                        : "Add tracker.js to your destination page to track conversions"}
                    </p>
                    <p className="text-slate-500 text-xs mt-0.5">
                      Paste this before &lt;/body&gt; on your external landing
                      page
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <code className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-slate-300 font-mono truncate">
                        {snippet}
                      </code>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(snippet);
                          toast.success("Copied");
                        }}
                        className="btn-secondary text-xs flex-shrink-0"
                      >
                        <Copy size={12} /> Copy
                      </button>
                    </div>
                  </div>
                  {!anyTrackerMissing && (
                    <button
                      onClick={dismissTrackerCard}
                      className="p-1 rounded hover:bg-indigo-500/20 text-indigo-400/60 hover:text-indigo-400 transition-colors flex-shrink-0"
                      title="Dismiss"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              )}

            {test.status !== "active" && (
              <div className="flex items-center gap-2 w-full rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2.5">
                <AlertTriangle
                  size={14}
                  className="text-red-400 flex-shrink-0"
                />
                <p className="text-xs text-red-400 font-medium">
                  Please publish the test in order to see live pages.
                </p>
              </div>
            )}

            {winner &&
              winner.confidence !== null &&
              winner.confidence >= 95 && (
                <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/30 rounded-xl p-4">
                  <Trophy size={20} className="text-green-400 flex-shrink-0" />
                  <div>
                    <p className="text-green-400 font-semibold text-sm">
                      Winner: {winner.variant.name}
                    </p>
                    <p className="text-slate-500 dark:text-slate-400 text-xs mt-0.5">
                      {formatPercent(winner.confidence)}% confidence
                    </p>
                  </div>
                </div>
              )}

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-slate-500 dark:text-slate-400 text-sm">
                  From
                </span>
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="input-base w-36 text-sm"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-500 dark:text-slate-400 text-sm">
                  To
                </span>
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="input-base w-36 text-sm"
                />
              </div>
              <button
                onClick={fetchAnalytics}
                disabled={loading}
                className="btn-secondary"
              >
                <RefreshCw
                  size={14}
                  className={loading ? "animate-spin" : ""}
                />{" "}
                Refresh
              </button>
              <button onClick={exportCsv} className="btn-secondary ml-auto">
                <Download size={14} /> Export
              </button>
            </div>

            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-700">
                    <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">
                      Variant
                    </th>
                    <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium w-24">
                      Weight
                    </th>
                    <th className="text-right px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">
                      Views
                    </th>
                    <th className="text-right px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">
                      Conversions
                    </th>
                    <th className="text-right px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">
                      Goal Hits
                    </th>
                    <th className="text-right px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">
                      CVR
                    </th>
                    <th className="text-right px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">
                      Confidence
                    </th>
                    <th className="text-center px-5 py-3 text-slate-400 font-medium w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-5 py-10 text-center text-slate-400"
                      >
                        <RefreshCw
                          size={20}
                          className="animate-spin mx-auto mb-2"
                        />
                        Loading...
                      </td>
                    </tr>
                  ) : stats.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-5 py-10 text-center text-slate-400"
                      >
                        No data yet. Publish this page to start collecting
                        events.
                      </td>
                    </tr>
                  ) : (
                    stats.map((stat) => {
                      const cvr = stat.cvr * 100;
                      const control = stats.find((s) => s.variant.is_control);
                      const controlCvr = (control?.cvr ?? 0) * 100;
                      const uplift =
                        !stat.variant.is_control && controlCvr > 0
                          ? ((cvr - controlCvr) / controlCvr) * 100
                          : null;
                      const isEditing = editingVariantId === stat.variant.id;
                      const verified = getVerifiedStatus(stat.variant);
                      const rowBg = stat.isWinner ? "bg-green-500/5" : "";

                      return (
                        <Fragment key={stat.variant.id}>
                          <tr className={`group ${rowBg}`}>
                            <td className="px-5 py-3.5">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-slate-800 dark:text-slate-200">
                                  {stat.variant.name}
                                </span>
                                {stat.variant.is_control && (
                                  <span className="badge bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 text-[10px]">
                                    control
                                  </span>
                                )}
                                {stat.variant.is_ai_generated && (
                                  <span className="inline-flex items-center gap-1 badge bg-[#3D8BDA]/10 text-[#3D8BDA] border border-[#3D8BDA]/20 text-[10px]">
                                    <Sparkles size={9} /> AI Generated
                                  </span>
                                )}
                                {stat.isWinner && (
                                  <Trophy
                                    size={13}
                                    className="text-green-400"
                                  />
                                )}
                              </div>
                              {stat.variant.variant_type === "hosted" &&
                                stat.variant.hosted_url &&
                                !isEditing && (
                                  <p className="text-slate-500 text-xs font-mono truncate max-w-[250px] mt-0.5">
                                    {stat.variant.hosted_url}
                                  </p>
                                )}
                              {stat.variant.variant_type !== "hosted" &&
                                stat.variant.redirect_url &&
                                !isEditing && (
                                  <p className="text-slate-500 text-xs font-mono truncate max-w-[250px] mt-0.5">
                                    {stat.variant.redirect_url}
                                  </p>
                                )}
                              {/* HTML/hosted variants: tracker.js is always injected by SplitLab */}
                              {!stat.variant.redirect_url && !isEditing && (
                                <div className="flex items-center gap-1.5 mt-1">
                                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 border border-green-500/20 text-green-400">
                                    <ShieldCheck size={10} /> Tracker injected
                                  </span>
                                </div>
                              )}
                              {stat.variant.redirect_url && !isEditing && (
                                <div className="flex items-center gap-1.5 mt-1">
                                  {checkingTracking === stat.variant.id ||
                                  autoCheckingIds.includes(stat.variant.id) ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                                      <Spinner size="sm" /> Checking…
                                    </span>
                                  ) : verified === true ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 border border-green-500/20 text-green-400">
                                      <ShieldCheck size={10} /> Tracker detected
                                      <button
                                        onClick={() =>
                                          checkTracking(
                                            stat.variant.id,
                                            stat.variant.redirect_url!,
                                          )
                                        }
                                        className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
                                        title="Re-check"
                                      >
                                        <RefreshCw size={9} />
                                      </button>
                                    </span>
                                  ) : verified === false ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 border border-red-500/20 text-red-400">
                                      <ShieldX size={10} /> Tracker not found
                                      <button
                                        onClick={() =>
                                          checkTracking(
                                            stat.variant.id,
                                            stat.variant.redirect_url!,
                                          )
                                        }
                                        className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
                                        title="Re-check"
                                      >
                                        <RefreshCw size={9} />
                                      </button>
                                    </span>
                                  ) : (
                                    // Auto-check failed or hasn't fired yet — allow manual trigger
                                    <button
                                      onClick={() =>
                                        checkTracking(
                                          stat.variant.id,
                                          stat.variant.redirect_url!,
                                        )
                                      }
                                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-slate-500/10 border border-slate-500/20 text-slate-400 hover:text-slate-300 transition-colors"
                                    >
                                      <ShieldCheck
                                        size={10}
                                        className="opacity-50"
                                      />{" "}
                                      Check tracker
                                    </button>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className={`px-5 py-3.5 ${rowBg}`}>
                              {savingWeightId === stat.variant.id ? (
                                <Loader2
                                  size={14}
                                  className="animate-spin text-slate-400"
                                />
                              ) : editingWeightId === stat.variant.id ? (
                                <input
                                  type="number"
                                  value={weightDraft}
                                  onChange={(e) =>
                                    setWeightDraft(e.target.value)
                                  }
                                  className="input-base w-16 text-sm text-center py-0.5"
                                  min={0}
                                  max={100}
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") saveWeight();
                                    if (e.key === "Escape")
                                      setEditingWeightId(null);
                                  }}
                                  onBlur={saveWeight}
                                />
                              ) : (
                                <button
                                  onClick={() =>
                                    startEditWeight(
                                      stat.variant.id,
                                      stat.variant.traffic_weight,
                                    )
                                  }
                                  className="text-slate-400 hover:text-indigo-400 transition-colors cursor-pointer"
                                  title="Click to edit weight"
                                >
                                  {stat.variant.traffic_weight}%
                                </button>
                              )}
                            </td>
                            <td
                              className={`px-5 py-3.5 text-right text-slate-700 dark:text-slate-300 ${rowBg}`}
                            >
                              {stat.views.toLocaleString()}
                            </td>
                            <td
                              className={`px-5 py-3.5 text-right text-slate-700 dark:text-slate-300 ${rowBg}`}
                            >
                              {stat.conversions.toLocaleString()}
                            </td>
                            <td
                              className={`px-5 py-3.5 text-right text-slate-500 dark:text-slate-400 ${rowBg}`}
                            >
                              {stat.goalHits.toLocaleString()}
                            </td>
                            <td
                              className={`px-5 py-3.5 text-right font-semibold text-slate-900 dark:text-slate-100 ${rowBg}`}
                            >
                              {formatPercent(cvr)}
                            </td>
                            <td className={`px-5 py-3.5 text-right ${rowBg}`}>
                              {stat.variant.is_control ? (
                                <span className="text-slate-500">—</span>
                              ) : stat.confidence !== null ? (
                                <span
                                  className={
                                    stat.confidence >= 95
                                      ? "text-green-400 font-semibold"
                                      : stat.confidence >= 80
                                        ? "text-amber-400"
                                        : "text-slate-400"
                                  }
                                >
                                  {formatPercent(stat.confidence)}
                                </span>
                              ) : (
                                <span className="text-slate-500">—</span>
                              )}
                            </td>
                            <td className={`px-5 py-3.5 text-center ${rowBg}`}>
                              <div className="flex items-center justify-center gap-2">
                                {uplift !== null && (
                                  <span
                                    className={`flex items-center gap-0.5 text-xs font-medium ${uplift > 0 ? "text-green-400" : "text-red-400"}`}
                                  >
                                    <TrendingUp
                                      size={11}
                                      className={uplift < 0 ? "rotate-180" : ""}
                                    />
                                    {uplift > 0 ? "+" : ""}
                                    {formatPercent(uplift)}
                                  </span>
                                )}
                                <button
                                  onClick={() => openVariant(stat.variant.id)}
                                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-slate-500/10 border border-slate-500/20 text-slate-400 hover:bg-slate-500/20 hover:text-slate-300 transition-colors"
                                  title={`Open ${stat.variant.name}`}
                                >
                                  <ExternalLink size={11} />
                                  Open
                                </button>
                                <button
                                  onClick={() => scanPage(stat.variant.id)}
                                  disabled={
                                    scanning ||
                                    getVerifiedStatus(stat.variant) === false
                                  }
                                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                                  title={
                                    getVerifiedStatus(stat.variant) === false
                                      ? "Tracker not found — install the tracker script first"
                                      : `Scan ${stat.variant.name}`
                                  }
                                >
                                  <ScanLine size={11} />
                                  Setup Tracking
                                </button>
                                <button
                                  onClick={() => startEditVariant(stat.variant)}
                                  className={`p-1 rounded transition-colors ${isEditing ? "bg-indigo-500/20 text-indigo-400" : "text-slate-400 dark:text-slate-600 hover:text-slate-700 dark:hover:text-slate-300"}`}
                                  title="Edit variant"
                                >
                                  <Pencil size={13} />
                                </button>
                              </div>
                            </td>
                          </tr>

                          {isEditing && (
                            <tr>
                              <td
                                colSpan={8}
                                className="border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-6 py-4"
                              >
                                <div className="grid grid-cols-2 gap-4 max-w-2xl">
                                  <div>
                                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                                      Variant Name
                                    </label>
                                    <input
                                      type="text"
                                      value={variantDraft.name}
                                      onChange={(e) =>
                                        setVariantDraft({
                                          ...variantDraft,
                                          name: e.target.value,
                                        })
                                      }
                                      className="input-base text-sm"
                                    />
                                  </div>
                                  {stat.variant.pages?.id ? (
                                    <div className="flex items-end">
                                      <button
                                        onClick={() =>
                                          openHtmlEditor(stat.variant)
                                        }
                                        className="btn-secondary text-sm flex items-center gap-2"
                                      >
                                        <FileCode2 size={14} />
                                        Edit HTML
                                      </button>
                                    </div>
                                  ) : (
                                    <div>
                                      <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                                        Destination URL
                                      </label>
                                      <input
                                        type="url"
                                        value={variantDraft.redirect_url}
                                        onChange={(e) =>
                                          setVariantDraft({
                                            ...variantDraft,
                                            redirect_url: e.target.value,
                                          })
                                        }
                                        className="input-base text-sm font-mono"
                                        placeholder="https://..."
                                      />
                                    </div>
                                  )}
                                </div>

                                <div className="flex items-center gap-4 mt-3">
                                  <div className="flex items-center gap-2">
                                    <span
                                      title={
                                        !variantDraft.redirect_url
                                          ? "Mode only applies to destination URL variants, not HTML page variants"
                                          : undefined
                                      }
                                      className={`text-xs text-slate-500 dark:text-slate-400 ${!variantDraft.redirect_url ? "cursor-help" : ""}`}
                                    >
                                      Mode:
                                    </span>
                                    {variantDraft.redirect_url && (
                                      <button
                                        onClick={() =>
                                          setVariantDraft({
                                            ...variantDraft,
                                            proxy_mode:
                                              !variantDraft.proxy_mode,
                                          })
                                        }
                                        className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border transition-colors ${
                                          variantDraft.proxy_mode
                                            ? "bg-indigo-500/20 text-indigo-400 border-indigo-500/30"
                                            : "bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border-slate-300 dark:border-slate-600"
                                        }`}
                                      >
                                        {variantDraft.proxy_mode ? (
                                          <>
                                            <Globe size={11} /> Proxy
                                          </>
                                        ) : (
                                          <>
                                            <ExternalLink size={11} /> Redirect
                                          </>
                                        )}
                                      </button>
                                    )}
                                  </div>

                                  {variantDraft.redirect_url && (
                                    <a
                                      href={variantDraft.redirect_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="btn-secondary text-xs"
                                    >
                                      <ExternalLink size={12} /> Preview
                                    </a>
                                  )}

                                  {variantDraft.redirect_url && (
                                    <button
                                      onClick={() =>
                                        checkTracking(
                                          stat.variant.id,
                                          variantDraft.redirect_url,
                                        )
                                      }
                                      disabled={
                                        checkingTracking === stat.variant.id
                                      }
                                      className="btn-secondary text-xs"
                                    >
                                      {checkingTracking === stat.variant.id ? (
                                        <Spinner size="sm" />
                                      ) : (
                                        <ShieldCheck size={12} />
                                      )}
                                      Check Tracker
                                    </button>
                                  )}

                                  <div className="ml-auto flex items-center gap-2">
                                    {variants.length > 1 && (
                                      <button
                                        onClick={() =>
                                          setDeleteVariantId(stat.variant.id)
                                        }
                                        className="btn-secondary text-xs text-red-400 hover:text-red-300"
                                      >
                                        <Trash2 size={12} /> Delete
                                      </button>
                                    )}
                                    <Button
                                      size="sm"
                                      onClick={() =>
                                        saveVariant(stat.variant.id)
                                      }
                                      loading={savingVariant}
                                    >
                                      <Check size={12} /> Save
                                    </Button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>

              <div className="border-t border-slate-200 dark:border-slate-700 px-5 py-3">
                <button
                  onClick={() => {
                    setNewVariantName(
                      `Variant ${String.fromCharCode(65 + variants.length)}`,
                    );
                    setNewVariantUrl("");
                    setNewVariantHtml("");
                    setNewVariantMode("url");
                    setAddVariantOpen(true);
                  }}
                  className="text-indigo-400 hover:text-indigo-300 text-sm font-medium flex items-center gap-1.5 transition-colors"
                >
                  <Plus size={14} /> Add Variant
                </button>
              </div>
            </div>

            {stats.length > 0 && (
              <p className="text-xs text-slate-500">
                Confidence is calculated using a chi-square test. 95%+ is
                considered statistically significant.
              </p>
            )}
          </>
        )}

        {/* ─── LEADS TAB ─── */}
        {tab === "leads" && (
          <>
            {leadsLoading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw
                  size={20}
                  className="animate-spin text-slate-500 dark:text-slate-400"
                />
              </div>
            ) : leads.length === 0 ? (
              <div className="text-center py-12">
                <Users size={32} className="mx-auto text-slate-600 mb-3" />
                <p className="text-slate-500 dark:text-slate-400 text-sm">
                  No conversions recorded yet.
                </p>
                <p className="text-slate-500 text-xs mt-1">
                  Conversions will appear here once visitors trigger your goals.
                </p>
              </div>
            ) : (
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700">
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {leads.length} conversion{leads.length !== 1 ? "s" : ""}
                  </p>
                  <button
                    onClick={fetchLeads}
                    className="btn-secondary text-xs"
                  >
                    <RefreshCw size={12} /> Refresh
                  </button>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">
                        Date
                      </th>
                      <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">
                        Visitor
                      </th>
                      <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">
                        Variant
                      </th>
                      <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">
                        Goal
                      </th>
                      <th className="text-left px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">
                        Details
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map((lead) => (
                      <tr
                        key={lead.id}
                        className="border-b border-slate-200 dark:border-slate-800 last:border-0"
                      >
                        <td className="px-5 py-3 text-slate-700 dark:text-slate-300 text-xs">
                          {new Date(lead.created_at).toLocaleString()}
                        </td>
                        <td className="px-5 py-3 text-slate-500 font-mono text-xs">
                          {lead.visitor_hash.slice(0, 8)}...
                        </td>
                        <td className="px-5 py-3 text-slate-700 dark:text-slate-300">
                          {lead.test_variants?.name || "—"}
                        </td>
                        <td className="px-5 py-3 text-slate-700 dark:text-slate-300">
                          {lead.conversion_goals?.name || "—"}
                        </td>
                        <td className="px-5 py-3 text-slate-500 text-xs font-mono">
                          {(lead.metadata as Record<string, string>)?.trigger ||
                            "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ─── SETTINGS TAB ─── */}
        {tab === "settings" && (
          <>
            {/* Page Scanner */}
            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center">
                    <ScanLine size={16} className="text-indigo-400" />
                  </div>
                  <div>
                    <p className="font-medium text-slate-800 dark:text-slate-200 text-sm">
                      Page Scanner
                    </p>
                    {scanning || scannedVariantName ? (
                      <p className="text-slate-500 text-xs">
                        {scanning
                          ? `Scanning ${scannedVariantName}…`
                          : `Last scanned: ${scannedVariantName}`}
                      </p>
                    ) : (
                      <div className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-300 mt-1">
                        <Info size={12} className="flex-shrink-0" />
                        <span>
                          Click Scan on any variant in the Overview tab to
                          detect elements
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="px-5 py-4">
                {!scanning && !scanResults && (
                  <p className="text-slate-500 text-xs">
                    No scan results yet. Use the Scan button on a variant row in
                    the Overview tab.
                  </p>
                )}

                {scanning && (
                  <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2.5 text-xs text-amber-300 font-medium">
                    <RefreshCw size={13} className="animate-spin flex-shrink-0" />
                    Page opened — waiting for scan results…
                  </div>
                )}

                {scanResults && (
                  <div className="space-y-4 max-h-96 overflow-y-auto pr-1">
                    {scanResults.variants.map((vs) => (
                      <div key={vs.variant_id}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                            {vs.variant_name}
                          </span>
                          <span className="text-slate-400 text-xs">
                            {vs.elements.length} element
                            {vs.elements.length !== 1 ? "s" : ""}
                          </span>
                          <span className="text-slate-500 text-xs ml-auto">
                            {new Date(vs.scanned_at).toLocaleString()}
                          </span>
                        </div>
                        {vs.elements.length === 0 ? (
                          <p className="text-slate-400 text-xs px-3 py-2">
                            No trackable elements found.
                          </p>
                        ) : (
                          <div className="space-y-1.5">
                            {vs.elements.map((el, i) => {
                              const icon =
                                el.type === "form" ? (
                                  <FormInput
                                    size={13}
                                    className="text-purple-400 flex-shrink-0"
                                  />
                                ) : el.type === "call" ? (
                                  <Phone
                                    size={13}
                                    className="text-green-400 flex-shrink-0"
                                  />
                                ) : el.type === "link" ? (
                                  <ExternalLink
                                    size={13}
                                    className="text-blue-400 flex-shrink-0"
                                  />
                                ) : el.type === "toggle" ? (
                                  <ToggleLeft
                                    size={13}
                                    className="text-amber-400 flex-shrink-0"
                                  />
                                ) : (
                                  <MousePointerClick
                                    size={13}
                                    className="text-indigo-400 flex-shrink-0"
                                  />
                                );

                              const label = el.text
                                ? `"${el.text}"`
                                : el.id
                                  ? `#${el.id}`
                                  : el.type;

                              const alreadyAdded = editGoals.some((g) => {
                                if (el.id) return g.selector === `id:${el.id}`;
                                if (el.text)
                                  return g.selector === `text:${el.text}`;
                                return false;
                              });

                              return (
                                <div
                                  key={i}
                                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700"
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    {icon}
                                    <span className="text-slate-700 dark:text-slate-300 text-sm truncate">
                                      {label}
                                    </span>
                                    {el.id && (
                                      <span className="text-slate-400 font-mono text-xs flex-shrink-0">
                                        #{el.id}
                                      </span>
                                    )}
                                    <span className="text-slate-400 text-xs flex-shrink-0 capitalize">
                                      {el.type.replace("_", " ")}
                                    </span>
                                  </div>
                                  {alreadyAdded ? (
                                    <button
                                      type="button"
                                      onClick={() => removeGoalBySelector(el)}
                                      className="flex-shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                                    >
                                      <X size={11} /> Remove
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => enableAsGoal(el)}
                                      className="flex-shrink-0 text-xs px-2.5 py-1 rounded-lg border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/10 transition-colors"
                                    >
                                      + Goal
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Conversion Goals — hidden for now; uncomment to re-enable */}
            {false && (
              <div className="card overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium text-slate-800 dark:text-slate-200">
                      Goals
                    </h3>
                    <button
                      type="button"
                      onClick={() =>
                        setEditGoals([
                          ...editGoals,
                          {
                            id: "",
                            name: "",
                            type: "form_submit",
                            selector: "",
                            url_pattern: "",
                            is_primary: editGoals.length === 0,
                          },
                        ])
                      }
                      className="text-indigo-400 hover:text-indigo-300 text-sm"
                    >
                      + Add Goal
                    </button>
                  </div>
                </div>
                <form
                  onSubmit={handleSaveGoals}
                  className="px-5 py-4 space-y-3"
                >
                  {editGoals.map((g, i) => (
                    <div
                      key={i}
                      className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-2"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={g.name}
                          onChange={(e) => {
                            const c = [...editGoals];
                            c[i] = { ...c[i], name: e.target.value };
                            setEditGoals(c);
                          }}
                          className="input-base flex-1"
                          placeholder="Goal name"
                          required
                        />
                        <select
                          value={g.type}
                          onChange={(e) => {
                            const c = [...editGoals];
                            c[i] = {
                              ...c[i],
                              type: e.target.value,
                              selector: "",
                              url_pattern: "",
                            };
                            setEditGoals(c);
                          }}
                          className="input-base w-36"
                        >
                          {GOAL_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() =>
                            setEditGoals(editGoals.filter((_, gi) => gi !== i))
                          }
                          className="text-slate-500 hover:text-red-400 transition-colors"
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        {(g.type === "form_submit" ||
                          g.type === "button_click") && (
                          <input
                            type="text"
                            value={g.selector || ""}
                            onChange={(e) => {
                              const c = [...editGoals];
                              c[i] = { ...c[i], selector: e.target.value };
                              setEditGoals(c);
                            }}
                            className="input-base flex-1 font-mono text-xs"
                            placeholder={
                              g.type === "form_submit"
                                ? "#my-form"
                                : "#cta-button"
                            }
                          />
                        )}
                        {g.type === "url_reached" && (
                          <input
                            type="text"
                            value={g.url_pattern || ""}
                            onChange={(e) => {
                              const c = [...editGoals];
                              c[i] = { ...c[i], url_pattern: e.target.value };
                              setEditGoals(c);
                            }}
                            className="input-base flex-1 font-mono text-xs"
                            placeholder="/thank-you"
                          />
                        )}
                        {g.type === "call_click" && (
                          <p className="text-slate-500 text-xs flex-1">
                            Tracks tel: link clicks
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                  {editGoals.length === 0 && (
                    <p className="text-slate-500 text-xs">
                      No goals. Add one to track conversions.
                    </p>
                  )}
                  <div className="flex justify-end pt-2">
                    <Button type="submit" loading={savingGoals} size="sm">
                      Save Goals
                    </Button>
                  </div>
                </form>
              </div>
            )}

            {/* Tracking Setup */}
            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center">
                    <Code2 size={16} className="text-indigo-400" />
                  </div>
                  <div>
                    <p className="font-medium text-slate-800 dark:text-slate-200 text-sm">
                      Tracking Snippet
                    </p>
                    <div className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-300 mt-1">
                      <Info size={12} className="flex-shrink-0" />
                      <span>
                        Paste before{" "}
                        <code className="font-mono">&lt;/body&gt;</code> on your
                        external landing page (redirect mode only)
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="px-5 py-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-slate-500 dark:text-slate-400 text-xs">
                    Tracking context is passed via URL parameters.
                  </p>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(snippet);
                      toast.success("Copied");
                    }}
                    className="btn-secondary text-xs"
                  >
                    <Copy size={12} /> Copy
                  </button>
                </div>
                <pre className="bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 overflow-x-auto text-xs text-slate-700 dark:text-slate-300">
                  <code>{snippet}</code>
                </pre>
              </div>
            </div>

            {/* Head Scripts (for proxy / custom HTML mode) */}
            <div
              className={`card overflow-hidden ${allPureRedirect ? "opacity-60" : ""}`}
            >
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700">
                <h3 className="font-medium text-slate-800 dark:text-slate-200">
                  Head Scripts
                </h3>
                <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2.5 text-xs text-amber-600 dark:text-amber-300 mt-2">
                  <Info size={13} className="mt-0.5 flex-shrink-0" />
                  <span>
                    Only works for custom HTML pages — not hosted URLs (Lovable,
                    Replit, site builders, etc.). For third-party scripts (GTM,
                    Pixel, etc.), add them directly to your site.
                  </span>
                </div>
              </div>
              <div className="px-5 py-4 space-y-3">
                {allPureRedirect && (
                  <div className="flex items-start gap-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3 py-2.5 text-xs text-slate-500 dark:text-slate-400">
                    <span className="mt-0.5 flex-shrink-0">⚠️</span>
                    <span>
                      Head scripts are disabled in{" "}
                      <strong className="text-slate-700 dark:text-slate-300">
                        redirect mode
                      </strong>
                      . SplitLab redirects visitors directly to the destination
                      URL (302) — no HTML is served, so scripts cannot be
                      injected. Switch to{" "}
                      <strong className="text-slate-700 dark:text-slate-300">
                        proxy mode
                      </strong>{" "}
                      on your variants to enable this, or add{" "}
                      <code className="font-mono bg-slate-200 dark:bg-slate-700 px-1 rounded">
                        tracker.js
                      </code>{" "}
                      directly to your destination page.
                    </span>
                  </div>
                )}
                <textarea
                  value={headScriptsDraft}
                  onChange={(e) => setHeadScriptsDraft(e.target.value)}
                  disabled={allPureRedirect}
                  className={`input-base font-mono text-xs w-full h-32 resize-y ${allPureRedirect ? "cursor-not-allowed opacity-50" : ""}`}
                  placeholder={
                    "<!-- Meta Pixel -->\n<script>...</script>\n\n<!-- Google Analytics -->\n<script>...</script>"
                  }
                />
                <div className="flex justify-end">
                  <Button
                    onClick={saveHeadScripts}
                    loading={savingScripts}
                    size="sm"
                    disabled={allPureRedirect}
                  >
                    Save Scripts
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ═══ MODALS ═══ */}
      <Modal
        open={addVariantOpen}
        onClose={() => { setAddVariantOpen(false); setAddVariantError(null); }}
        title="Add Variant"
        size="sm"
      >
        <form onSubmit={handleAddVariant} className="space-y-4">
          {/* Mode toggle */}
          <div className="flex border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setNewVariantMode("url")}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${newVariantMode === "url" ? "bg-indigo-500/20 text-indigo-400" : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/50"}`}
            >
              External URL
            </button>
            <button
              type="button"
              onClick={() => setNewVariantMode("html")}
              className={`flex-1 py-2 text-sm font-medium transition-colors border-l border-slate-200 dark:border-slate-700 ${newVariantMode === "html" ? "bg-indigo-500/20 text-indigo-400" : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/50"}`}
            >
              Upload HTML
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Variant Name
            </label>
            <input
              type="text"
              value={newVariantName}
              onChange={(e) => setNewVariantName(e.target.value)}
              className="input-base"
              required
              autoFocus
            />
          </div>

          {newVariantMode === "url" ? (
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Destination URL
              </label>
              <input
                type="text"
                value={newVariantUrl}
                onChange={(e) => {
                  setNewVariantUrl(e.target.value);
                  if (newVariantUrlError) setNewVariantUrlError("");
                }}
                className={`input-base font-mono text-sm ${newVariantUrlError ? "border-red-500 focus:ring-red-500" : ""}`}
                placeholder="https://..."
              />
              {newVariantUrlError && (
                <p className="mt-1.5 text-xs text-red-500 flex items-center gap-1">
                  <AlertTriangle size={11} className="flex-shrink-0" />{" "}
                  {newVariantUrlError}
                </p>
              )}
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                HTML Content
              </label>
              <textarea
                value={newVariantHtml}
                onChange={(e) => setNewVariantHtml(e.target.value)}
                className="input-base font-mono text-xs w-full h-40 resize-y"
                placeholder="<!DOCTYPE html>\n<html>\n<head>...</head>\n<body>...</body>\n</html>"
                required
              />
              <div className="mt-2">
                <label className="btn-secondary text-xs inline-flex items-center gap-1.5 cursor-pointer">
                  <FileCode2 size={12} /> Upload .html file
                  <input
                    type="file"
                    accept=".html,.htm"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () =>
                        setNewVariantHtml(reader.result as string);
                      reader.readAsText(file);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
          )}

          <p className="text-slate-500 text-xs">
            Traffic weights will be automatically split equally across all
            variants.
          </p>
          {addVariantError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2.5 text-sm text-red-400">
              {addVariantError.message}
              {addVariantError.isLimit && (
                <> · <a href="/billing" className="underline font-medium hover:text-red-300">Upgrade Plan</a></>
              )}
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="secondary"
              type="button"
              onClick={() => { setAddVariantOpen(false); setAddVariantError(null); }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={addingVariant}>
              Add Variant
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deleteVariantId}
        onClose={() => setDeleteVariantId(null)}
        onConfirm={deleteVariant}
        title="Delete Variant"
        description="This will permanently delete the variant and its event data. Traffic weights will need to be adjusted."
        loading={deletingVariant}
      />

      {/* HTML Editor Modal */}
      {htmlEditVariant && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => !savingHtml && setHtmlEditVariant(null)}
        >
          <div
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-4xl flex flex-col max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
              <div>
                <h3 className="font-semibold text-slate-900 dark:text-slate-100">
                  Edit HTML — {htmlEditVariant.name}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Changes go live immediately after saving.
                </p>
              </div>
              <button
                onClick={() => setHtmlEditVariant(null)}
                disabled={savingHtml}
                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-auto min-h-0">
              {loadingHtml ? (
                <div className="flex items-center justify-center h-64">
                  <Loader2 size={20} className="animate-spin text-slate-400" />
                </div>
              ) : (
                <CodeEditor
                  value={htmlDraft}
                  onChange={setHtmlDraft}
                  height="60vh"
                />
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-slate-200 dark:border-slate-700 flex-shrink-0">
              <button
                onClick={() => setHtmlEditVariant(null)}
                disabled={savingHtml}
                className="btn-secondary text-sm"
              >
                Cancel
              </button>
              <Button size="sm" onClick={saveHtml} loading={savingHtml}>
                <Check size={13} /> Save HTML
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
