"use client";

import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";

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
  ChevronRight as ChevronRightSmall,
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
  CheckCircle2,
  ClipboardList,
  Search,
  ChevronLeft,
  ChevronDown,
  Plug2,
  ArrowRight,
  XCircle,
  Eye,
  Activity,
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
  variant_id?: string | null;
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

interface FormLead {
  id: string;
  visitor_hash: string | null;
  submitted_at: string;
  ip_address: string | null;
  user_agent: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_content: string | null;
  utm_term: string | null;
  utm_campaign: string | null;
  gclid: string | null;
  form_fields: Record<string, string>;
  test_variants: { name: string } | null;
}

interface Props {
  test: Test;
  appUrl: string;
  clientId: string;
  clientName: string;
  domain?: string;
  userRole: string;
  userPlan: string;
  workspaceId?: string;
}

interface HubSpotProperty {
  name: string;
  label: string;
  groupName: string;
}

interface HubSpotFormField {
  name: string;
  label: string;
  fieldType: string;
  required: boolean;
}

interface HubSpotForm {
  id: string;
  name: string;
  fields: HubSpotFormField[];
}

interface TestMapping {
  id?: string;
  enabled: boolean;
  field_mappings: Record<string, string>;
  form_guid?: string | null;
  portal_id?: string | null;
  last_synced_at?: string | null;
  total_synced?: number;
  total_failed?: number;
}

type Tab = "overview" | "leads" | "form-leads" | "integrations" | "settings";

export default function AnalyticsClient({
  test: initialTest,
  appUrl,
  clientId,
  clientName,
  domain,
  userRole,
  userPlan,
  workspaceId,
}: Props) {
  const [test, setTest] = useState(initialTest);
  const [tab, setTab] = useState<Tab>("overview");
  const searchParams = useSearchParams();
  const router = useRouter();

  // Show success/error toast on return from HubSpot OAuth
  useEffect(() => {
    if (searchParams.get('hs_connected') === '1') {
      toast.success('HubSpot connected successfully!');
      setTab('integrations');
      router.replace(window.location.pathname);
    } else if (searchParams.get('hs_error')) {
      toast.error(`HubSpot connection failed: ${searchParams.get('hs_error')}`);
      router.replace(window.location.pathname);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Analytics
  const [stats, setStats] = useState<VariantStat[]>([]);
  const [totalViews, setTotalViews] = useState(0);
  const [totalConversions, setTotalConversions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Page Reporting (collapsible chart section)
  type ReportingVariant = { id: string; name: string; is_control: boolean };
  type ReportingTotals = { visitors: number; views: number; conversions: number; cvr: number };
  const [reportingOpen, setReportingOpen] = useState(false);
  const [reportingLoaded, setReportingLoaded] = useState(false);
  const [reportingLoading, setReportingLoading] = useState(false);
  const [reportingDaily, setReportingDaily] = useState<Record<string, unknown>[]>([]);
  const [reportingVariants, setReportingVariants] = useState<ReportingVariant[]>([]);
  const [reportingTotals, setReportingTotals] = useState<ReportingTotals>({ visitors: 0, views: 0, conversions: 0, cvr: 0 });
  const [reportingFrom, setReportingFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  });
  const [reportingTo, setReportingTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [reportingMetric, setReportingMetric] = useState<'views' | 'visitors' | 'conversions' | 'cvr'>('conversions');
  const [reportingVariantFilter, setReportingVariantFilter] = useState<Set<string>>(new Set(['overall']));
  const [reportingVariantDropdownOpen, setReportingVariantDropdownOpen] = useState(false);
  const reportingDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!reportingVariantDropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (reportingDropdownRef.current && !reportingDropdownRef.current.contains(e.target as Node)) {
        setReportingVariantDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [reportingVariantDropdownOpen]);

  const CHART_COLORS = ['#3D8BDA','#f59e0b','#10b981','#f43f5e','#8b5cf6','#06b6d4','#ec4899','#84cc16','#fb923c','#a78bfa'];

  const [reportingError, setReportingError] = useState<string | null>(null);

  async function fetchReporting() {
    setReportingLoading(true);
    setReportingError(null);
    try {
      const params = new URLSearchParams({ from: reportingFrom, to: reportingTo });
      const res = await fetch(`/api/tests/${test.id}/reporting?${params}`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const json = await res.json();
      setReportingVariants(json.variants || []);
      setReportingDaily(json.daily || []);
      setReportingTotals(json.totals || { visitors: 0, views: 0, conversions: 0, cvr: 0 });
      setReportingLoaded(true);
      // Default: show all variants + overall on first load
      if (reportingVariantFilter.size === 1 && reportingVariantFilter.has('overall')) {
        const allIds = new Set<string>(['overall']);
        (json.variants || []).forEach((v: ReportingVariant) => allIds.add(v.id));
        setReportingVariantFilter(allIds);
      }
    } catch (err) {
      setReportingError(err instanceof Error ? err.message : 'Failed to load reporting data');
    } finally {
      setReportingLoading(false);
    }
  }

  useEffect(() => {
    if (reportingOpen && !reportingLoaded) fetchReporting();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportingOpen]);

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

  const [bannerVerifying, setBannerVerifying] = useState(false);

  async function verifyAllTracking() {
    const toVerify = variants.filter(
      (v) => v.redirect_url && getVerifiedStatus(v) !== true,
    );
    if (toVerify.length === 0) return;
    setBannerVerifying(true);
    const results = await Promise.all(
      toVerify.map((v) =>
        fetch("/api/check-tracking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: v.redirect_url, variant_id: v.id }),
        })
          .then((r) => r.json())
          .then((data) => {
            setVariantOverrides((prev) => ({ ...prev, [v.id]: data.verified }));
            return data.verified as boolean;
          })
          .catch(() => false),
      ),
    );
    setBannerVerifying(false);
    const allVerified = results.every(Boolean);
    const anyVerified = results.some(Boolean);
    if (allVerified) {
      toast.success("Tracker verified on all variants");
    } else if (anyVerified) {
      toast.error("Tracker not found on some variants — make sure the snippet is pasted.");
    } else {
      toast.error("Tracker not found on some variants");
    }
  }

  // Weight editing
  const [editingWeightId, setEditingWeightId] = useState<string | null>(null);
  const [weightDraft, setWeightDraft] = useState("");
  const [savingWeightId, setSavingWeightId] = useState<string | null>(null);

  // Delete variant
  const [deleteVariantId, setDeleteVariantId] = useState<string | null>(null);
  const [deletingVariant, setDeletingVariant] = useState(false);

  // URL change confirmation (clears scan results)
  const [urlChangeConfirmId, setUrlChangeConfirmId] = useState<string | null>(null);

  // Visitor cap
  const [visitorOverCap, setVisitorOverCap] = useState(false);

  // Add variant
  const [addVariantOpen, setAddVariantOpen] = useState(false);
  const [newVariantName, setNewVariantName] = useState("");
  const [newVariantUrl, setNewVariantUrl] = useState("");
  const [newVariantUrlError, setNewVariantUrlError] = useState("");
  const [newVariantUrlFrameable, setNewVariantUrlFrameable] = useState<boolean | null>(null);
  const [editUrlFrameable, setEditUrlFrameable] = useState<boolean | null>(null);
  const [checkingFrameable, setCheckingFrameable] = useState(false);
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

  // Form Leads
  const [formLeads, setFormLeads] = useState<FormLead[]>([]);
  const [formLeadsFieldKeys, setFormLeadsFieldKeys] = useState<string[]>([]);
  const [formLeadsTotal, setFormLeadsTotal] = useState(0);
  const [formLeadsPage, setFormLeadsPage] = useState(1);
  const [formLeadsLoading, setFormLeadsLoading] = useState(false);
  const FORM_LEADS_LIMIT = 50;
  // Filters
  const [flVariantId, setFlVariantId] = useState("");
  const [flFrom, setFlFrom] = useState("");
  const [flTo, setFlTo] = useState("");
  const [flSearch, setFlSearch] = useState("");
  const [flSearchInput, setFlSearchInput] = useState("");

  // Integrations
  const [hsIntegration, setHsIntegration] = useState<{ id: string; enabled: boolean; hub_id?: string | null } | null>(null);
  const [hsDisconnecting, setHsDisconnecting] = useState(false);
  const [hsProperties, setHsProperties] = useState<HubSpotProperty[]>([]);
  const [hsPropsLoading, setHsPropsLoading] = useState(false);
  const [hsForms, setHsForms] = useState<HubSpotForm[]>([]);
  const [hsFormsLoading, setHsFormsLoading] = useState(false);
  const [hsSelectedFormId, setHsSelectedFormId] = useState<string>('');
  const [integrationsLoaded, setIntegrationsLoaded] = useState(false);
  // Test-level mapping (one flat mapping for the whole test)
  const [testMapping, setTestMapping] = useState<TestMapping>({ enabled: true, field_mappings: {} });
  const [testFormKeys, setTestFormKeys] = useState<string[]>([]);
  const [savingMapping, setSavingMapping] = useState(false);
  const [newFieldKey, setNewFieldKey] = useState("");

  // Integrations sub-tab
  const [integrationsSubTab, setIntegrationsSubTab] = useState<'native' | 'webhooks'>('native');

  // Email notifications integration
  const [emailIntegration, setEmailIntegration] = useState<{ id: string; enabled: boolean } | null>(null);
  const [emailMapping, setEmailMapping] = useState<{ id?: string; recipients: string; subject: string; enabled: boolean }>({ recipients: '', subject: 'New lead: {{test}} - {{variant}}', enabled: true });
  const [emailDisconnecting, setEmailDisconnecting] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  // Modal for configuring email before enabling
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailModalRecipients, setEmailModalRecipients] = useState('');
  const [emailModalSubject, setEmailModalSubject] = useState('New lead: {{test}} - {{variant}}');
  const [emailModalError, setEmailModalError] = useState('');

  // Webhook integrations
  interface WebhookRow { id: string; enabled: boolean; config: { url: string; format: 'json' | 'form' | 'xml'; headers: { key: string; value: string }[] } }
  interface WebhookMapping { id: string; formFields: Record<string, string>; systemFields: Record<string, string>; total_synced?: number; total_failed?: number; last_synced_at?: string | null }
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [webhookMappings, setWebhookMappings] = useState<Record<string, WebhookMapping>>({});
  const [webhookModalOpen, setWebhookModalOpen] = useState(false);
  const [editingWebhookId, setEditingWebhookId] = useState<string | null>(null);
  const [wUrl, setWUrl] = useState('');
  const [wFormat, setWFormat] = useState<'json' | 'form' | 'xml'>('json');
  const [wHeaders, setWHeaders] = useState<{ key: string; value: string }[]>([]);
  const [wFormFields, setWFormFields] = useState<Record<string, string>>({});
  const [wSystemFields, setWSystemFields] = useState<Record<string, string>>({});
  const [wNewFormKey, setWNewFormKey] = useState('');
  const [wSaving, setWSaving] = useState(false);
  const [wDeleting, setWDeleting] = useState<string | null>(null);
  const [wTestResult, setWTestResult] = useState<{ ok: boolean; statusCode?: number; error?: string } | null>(null);
  const [wTesting, setWTesting] = useState(false);
  const [wError, setWError] = useState('');

  const SYSTEM_FIELDS = [
    { key: 'ip_address',   label: 'IP Address' },
    { key: 'submitted_at', label: 'Submitted At' },
    { key: 'test_id',      label: 'Test ID' },
    { key: 'test_name',    label: 'Test Name' },
    { key: 'variant_id',   label: 'Variant ID' },
    { key: 'variant_name', label: 'Variant Name' },
    { key: 'utm_source',   label: 'UTM Source' },
    { key: 'utm_medium',   label: 'UTM Medium' },
    { key: 'utm_campaign', label: 'UTM Campaign' },
    { key: 'utm_content',  label: 'UTM Content' },
    { key: 'utm_term',     label: 'UTM Term' },
  ];

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
  const [scanTab, setScanTab] = useState<string | null>(null);

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

  function refreshVisitorCap() {
    fetch('/api/usage')
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        // Only update state when we have a confident answer — if response is missing
        // or malformed, keep current state rather than incorrectly re-enabling buttons
        if (d && typeof d.visitors?.overCap === 'boolean') {
          setVisitorOverCap(d.visitors.overCap);
        }
      })
      .catch(() => {});
  }

  useEffect(() => {
    refreshVisitorCap();
  }, []);

  // Auto-check tracker on load for redirect variants that have never been verified.
  // Uses `variants` (from SSR props) not `stats` — analytics response may omit tracking_verified.
  useEffect(() => {
    if (variants.length === 0) return;
    const toCheck = variants.filter(
      (v) =>
        v.redirect_url &&
        v.tracking_verified !== true && // re-check if never checked (null) or previously failed (false)
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
    setEditUrlFrameable(null);
    setVariantDraft({
      name: v.name,
      redirect_url: v.redirect_url || "",
      proxy_mode: v.proxy_mode !== false,
    });
  }

  async function saveVariant(variantId: string, skipUrlChangeConfirm = false) {
    const editedUrl = variantDraft.redirect_url.trim();
    if (editedUrl) {
      const duplicate = variants.find(
        (v) => v.id !== variantId && v.redirect_url && v.redirect_url.trim() === editedUrl
      );
      if (duplicate) {
        toast.error(`This URL is already used by "${duplicate.name}". Each variant must have a unique destination URL.`);
        return;
      }
    }

    // If URL changed and variant has scan results, confirm before proceeding
    if (!skipUrlChangeConfirm) {
      const current = variants.find((v) => v.id === variantId);
      const urlChanged = current && editedUrl && (current.redirect_url ?? '').trim() !== editedUrl;
      const hasScanResults = scanResults?.variants?.some((v) => v.variant_id === variantId);
      if (urlChanged && hasScanResults) {
        setUrlChangeConfirmId(variantId);
        return;
      }
    }

    setSavingVariant(true);
    try {
      let proxyMode = variantDraft.proxy_mode;
      if (variantDraft.redirect_url) {
        proxyMode = await checkFrameable(variantDraft.redirect_url.trim());
      }
      const res = await fetch(`/api/tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variant_updates: [
            {
              id: variantId,
              name: variantDraft.name,
              redirect_url: variantDraft.redirect_url || null,
              proxy_mode: proxyMode,
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
      // If URL changed and scan results were cleared server-side, reflect that in local state
      if (skipUrlChangeConfirm) {
        setScanResults((prev) => {
          if (!prev) return prev;
          const filtered = prev.variants.filter((v) => v.variant_id !== variantId);
          return filtered.length > 0 ? { ...prev, variants: filtered } : null;
        });
      }
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
    let frameableResult = newVariantUrlFrameable;
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
      const duplicate = variants.find(
        (v) => v.redirect_url && v.redirect_url.trim() === trimmed
      );
      if (duplicate) {
        setNewVariantUrlError(`This URL is already used by "${duplicate.name}". Each variant must have a unique destination URL.`);
        return;
      }
      setNewVariantUrlError("");
    }
    setAddingVariant(true);
    try {
      const count = variants.length + 1;
      const weight = Math.floor(100 / count);
      const remainder = 100 - weight * count;
      const useProxyMode = newVariantMode === "url"
        ? await checkFrameable(newVariantUrl.trim())
        : true;

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
              proxy_mode: useProxyMode,
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
      const finalTest = await res.json();
      setTest(finalTest);
      const updatedVariants: Variant[] = finalTest.test_variants ?? [];
      setStats((prev) =>
        prev.map((s) => {
          const v = updatedVariants.find((u) => u.id === s.variant.id);
          return v ? { ...s, variant: { ...s.variant, traffic_weight: v.traffic_weight } } : s;
        }),
      );
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
      setNewVariantUrlFrameable(null);
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

  // Auto-dismiss tracker banner once all redirect variants become verified
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const redirectVariants = variants.filter((v) => v.redirect_url);
    if (redirectVariants.length === 0) return;
    const allVerified = redirectVariants.every((v) => getVerifiedStatus(v) === true);
    if (allVerified && !trackerCardDismissed) {
      dismissTrackerCard();
    }
  }, [variantOverrides]); // eslint-disable-line react-hooks/exhaustive-deps

  async function checkFrameable(url: string): Promise<boolean> {
    if (!url.startsWith('http')) return true;
    try {
      const res = await fetch(`/api/check-frameable?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      return data.frameable !== false;
    } catch {
      return true;
    }
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
            variant_id: g.variant_id ?? null,
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

  // ─── Form Leads ──────────────────────────────────────────────────────

  const fetchFormLeads = useCallback(async (page = 1, filters?: { variantId?: string; from?: string; to?: string; search?: string }) => {
    setFormLeadsLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(FORM_LEADS_LIMIT) });
      const v = filters?.variantId ?? flVariantId;
      const f = filters?.from ?? flFrom;
      const t = filters?.to ?? flTo;
      const s = filters?.search ?? flSearch;
      if (v) params.set('variant_id', v);
      if (f) params.set('from', f);
      if (t) params.set('to', t);
      if (s) params.set('search', s);
      const res = await fetch(`/api/tests/${test.id}/form-leads?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setFormLeads(data.leads || []);
      setFormLeadsFieldKeys(data.fieldKeys || []);
      setFormLeadsTotal(data.total || 0);
      setFormLeadsPage(page);
    } catch {
      toast.error("Failed to load form leads");
    } finally {
      setFormLeadsLoading(false);
    }
  }, [test.id, flVariantId, flFrom, flTo, flSearch]);

  useEffect(() => {
    if (tab === "form-leads") fetchFormLeads(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // ─── Integrations ────────────────────────────────────────────────────

  const fetchIntegrations = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/integrations`);
      const data = await res.json() as { integrations?: { id: string; type: string; enabled: boolean; config?: unknown }[] };
      const hsRaw = data.integrations?.find(i => i.type === 'hubspot') ?? null;
      const hs = hsRaw ? { id: hsRaw.id, enabled: hsRaw.enabled, hub_id: (hsRaw.config as { hub_id?: string } | null)?.hub_id ?? null } : null;
      const em = data.integrations?.find(i => i.type === 'email') ?? null;
      const whs = (data.integrations ?? []).filter(i => i.type === 'webhook') as WebhookRow[];
      setHsIntegration(hs);
      setEmailIntegration(em);
      setWebhooks(whs);

      // Fetch all test mappings once (covers hubspot + email + webhooks)
      const [mRes, kRes] = await Promise.all([
        fetch(`/api/tests/${test.id}/integrations`),
        fetch(`/api/tests/${test.id}/form-field-keys`),
      ]);
      const mData = await mRes.json() as { mappings?: { id?: string; enabled: boolean; field_mappings: unknown; last_synced_at?: string; total_synced?: number; total_failed?: number; workspace_integrations?: { id: string } }[] };

      if (hs) {
        setHsFormsLoading(true);
        const [formsRes, propsRes] = await Promise.all([
          fetch(`/api/workspaces/${workspaceId}/integrations/hubspot-forms`),
          fetch(`/api/workspaces/${workspaceId}/integrations/hubspot-properties`),
        ]);
        setHsFormsLoading(false);
        const formsData = await formsRes.json() as { forms?: HubSpotForm[]; error?: string };
        if (!formsRes.ok) {
          toast.error(`Failed to load HubSpot forms: ${formsData.error ?? 'Unknown error'}`);
        }
        setHsForms(formsData.forms ?? []);
        if (propsRes.ok) {
          const propsData = await propsRes.json() as { properties?: HubSpotProperty[] };
          setHsProperties(propsData.properties ?? []);
        }

        const m = mData.mappings?.find(x => x.workspace_integrations?.id === hs.id);
        const rawMapping = m?.field_mappings as { fieldMappings?: Record<string, string>; form_guid?: string; portal_id?: string } | Record<string, string> | null;
        const isNewShape = rawMapping && 'fieldMappings' in rawMapping;
        const fieldMappings = isNewShape ? (rawMapping as { fieldMappings: Record<string, string> }).fieldMappings : (rawMapping as Record<string, string> ?? {});
        const formGuid = isNewShape ? (rawMapping as { form_guid?: string }).form_guid ?? '' : '';
        const portalId = isNewShape ? (rawMapping as { portal_id?: string }).portal_id ?? '' : '';

        setTestMapping(m
          ? { id: m.id, enabled: m.enabled, field_mappings: fieldMappings, form_guid: formGuid, portal_id: portalId, last_synced_at: m.last_synced_at, total_synced: m.total_synced, total_failed: m.total_failed }
          : { enabled: false, field_mappings: {}, form_guid: '', portal_id: '' }
        );
        if (formGuid) setHsSelectedFormId(formGuid);
        else if (m && !isNewShape) setHsSelectedFormId('none');
      }

      if (em) {
        const em_m = mData.mappings?.find(x => x.workspace_integrations?.id === em.id);
        if (em_m?.field_mappings) {
          const cfg = em_m.field_mappings as { recipients?: string; subject?: string };
          setEmailMapping({
            id: em_m.id,
            recipients: cfg.recipients ?? '',
            subject: cfg.subject ?? 'New lead: {{test}} - {{variant}}',
            enabled: em_m.enabled,
          });
        }
      }

      // Load webhook mappings
      if (whs.length > 0) {
        const whMappings: Record<string, WebhookMapping> = {};
        for (const wh of whs) {
          const m = mData.mappings?.find(x => x.workspace_integrations?.id === wh.id);
          if (m?.field_mappings) {
            const fm = m.field_mappings as { formFields?: Record<string, string>; systemFields?: Record<string, string> };
            whMappings[wh.id] = {
              id: m.id!,
              formFields: fm.formFields ?? {},
              systemFields: fm.systemFields ?? {},
              total_synced: m.total_synced,
              total_failed: m.total_failed,
              last_synced_at: m.last_synced_at,
            };
          }
        }
        setWebhookMappings(whMappings);
      }

      const kData = await kRes.json() as { keys?: string[] };
      setTestFormKeys(kData.keys ?? []);
    } catch (err) {
      console.error('[integrations] load error', err);
      toast.error('Failed to load integrations');
    } finally {
      setIntegrationsLoaded(true);
    }
  }, [workspaceId, test.id]);

  useEffect(() => {
    if (tab === "integrations") {
      setIntegrationsLoaded(false);
      fetchIntegrations();
    }
  }, [tab]);

  async function disconnectHubSpot() {
    if (!workspaceId) return;
    setHsDisconnecting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/integrations?type=hubspot`, { method: 'DELETE' });
      if (!res.ok) { toast.error('Failed to disconnect HubSpot'); return; }
      setHsIntegration(null);
      setTestMapping({ enabled: true, field_mappings: {} });
      setHsProperties([]);
      setIntegrationsLoaded(false);
      toast.success('HubSpot disconnected');
    } catch {
      toast.error('Failed to disconnect HubSpot');
    } finally {
      setHsDisconnecting(false);
    }
  }

  function openEmailModal() {
    // Pre-fill from existing config if editing
    setEmailModalRecipients(emailMapping.recipients);
    setEmailModalSubject(emailMapping.subject || 'New lead: {{test}} - {{variant}}');
    setEmailModalError('');
    setEmailModalOpen(true);
  }

  async function submitEmailModal(e: React.FormEvent) {
    e.preventDefault();
    const recipients = emailModalRecipients.trim().toLowerCase();
    if (!recipients) { setEmailModalError('At least one recipient email is required.'); return; }
    const valid = recipients.split(',').map(r => r.trim()).filter(Boolean).every(r => r.includes('@'));
    if (!valid) { setEmailModalError('One or more email addresses look invalid.'); return; }

    setSavingEmail(true);
    setEmailModalError('');
    try {
      // Step 1: create / upsert workspace-level email integration
      let integrationId = emailIntegration?.id;
      if (!integrationId) {
        const res = await fetch(`/api/workspaces/${workspaceId}/integrations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'email', config: {} }),
        });
        if (!res.ok) { setEmailModalError('Failed to enable email notifications.'); return; }
        const { integration } = await res.json() as { integration: { id: string; enabled: boolean } };
        setEmailIntegration(integration);
        integrationId = integration.id;
      }

      // Step 2: save test-level config (recipients + subject)
      const subject = emailModalSubject.trim() || 'New lead: {{test}} - {{variant}}';
      const mRes = await fetch(`/api/tests/${test.id}/integrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_integration_id: integrationId,
          enabled: true,
          field_mappings: { recipients, subject },
        }),
      });
      if (!mRes.ok) { setEmailModalError('Failed to save email configuration.'); return; }
      const { mapping } = await mRes.json() as { mapping: { id: string } };

      setEmailMapping({ id: mapping.id, recipients, subject, enabled: true });
      setEmailModalOpen(false);
      toast.success('Email notifications configured');
    } catch {
      setEmailModalError('Something went wrong. Please try again.');
    } finally {
      setSavingEmail(false);
    }
  }

  async function disconnectEmail() {
    if (!workspaceId) return;
    setEmailDisconnecting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/integrations?type=email`, { method: 'DELETE' });
      if (!res.ok) { toast.error('Failed to remove email notifications'); return; }
      setEmailIntegration(null);
      setEmailMapping({ recipients: '', subject: 'New lead: {{test}} - {{variant}}', enabled: true });
      toast.success('Email notifications removed');
    } catch {
      toast.error('Failed to remove email notifications');
    } finally {
      setEmailDisconnecting(false);
    }
  }

  function openAddWebhookModal() {
    setEditingWebhookId(null);
    setWUrl('');
    setWFormat('json');
    setWHeaders([]);
    setWFormFields(Object.fromEntries(testFormKeys.map(k => [k, k])));
    const defaultSys: Record<string, string> = {};
    SYSTEM_FIELDS.forEach(sf => { defaultSys[sf.key] = sf.key; });
    setWSystemFields(defaultSys);
    setWNewFormKey('');
    setWTestResult(null);
    setWError('');
    setWebhookModalOpen(true);
  }

  function openEditWebhookModal(wh: WebhookRow) {
    const mapping = webhookMappings[wh.id];
    setEditingWebhookId(wh.id);
    setWUrl(wh.config?.url ?? '');
    setWFormat(wh.config?.format ?? 'json');
    setWHeaders(wh.config?.headers ?? []);
    setWFormFields(mapping?.formFields ?? Object.fromEntries(testFormKeys.map(k => [k, k])));
    const defaultSys: Record<string, string> = {};
    SYSTEM_FIELDS.forEach(sf => { defaultSys[sf.key] = sf.key; });
    setWSystemFields(mapping?.systemFields ?? defaultSys);
    setWNewFormKey('');
    setWTestResult(null);
    setWError('');
    setWebhookModalOpen(true);
  }

  async function submitWebhookModal(e: React.FormEvent) {
    e.preventDefault();
    const url = wUrl.trim();
    if (!url) { setWError('Webhook URL is required.'); return; }
    if (!url.startsWith('http://') && !url.startsWith('https://')) { setWError('URL must start with http:// or https://'); return; }
    if (!workspaceId) return;

    setWSaving(true);
    setWError('');
    try {
      const config = { url, format: wFormat, headers: wHeaders.filter(h => h.key.trim()) };
      const fieldMappings = { formFields: wFormFields, systemFields: wSystemFields };

      let integrationId = editingWebhookId;

      if (!integrationId) {
        // Create new workspace integration
        const iRes = await fetch(`/api/workspaces/${workspaceId}/integrations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'webhook', config }),
        });
        if (!iRes.ok) { setWError('Failed to create webhook.'); return; }
        const { integration } = await iRes.json() as { integration: { id: string; enabled: boolean; config: WebhookRow['config'] } };
        integrationId = integration.id;
        setWebhooks(prev => [...prev, { id: integration.id, enabled: true, config }]);
      } else {
        // Update config — delete old and re-insert (simplest without a PATCH endpoint)
        await fetch(`/api/workspaces/${workspaceId}/integrations?integrationId=${integrationId}`, { method: 'DELETE' });
        const iRes = await fetch(`/api/workspaces/${workspaceId}/integrations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'webhook', config }),
        });
        if (!iRes.ok) { setWError('Failed to update webhook.'); return; }
        const { integration } = await iRes.json() as { integration: { id: string; enabled: boolean; config: WebhookRow['config'] } };
        integrationId = integration.id;
        setWebhooks(prev => prev.map(w => w.id === editingWebhookId ? { ...w, id: integration.id, config } : w));
      }

      // Save test-level field mappings
      const mRes = await fetch(`/api/tests/${test.id}/integrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_integration_id: integrationId, enabled: true, field_mappings: fieldMappings }),
      });
      if (!mRes.ok) { setWError('Failed to save field mappings.'); return; }
      const { mapping } = await mRes.json() as { mapping: { id: string } };

      setWebhookMappings(prev => ({
        ...prev,
        [integrationId!]: { id: mapping.id, formFields: wFormFields, systemFields: wSystemFields },
      }));
      setWebhookModalOpen(false);
      toast.success(editingWebhookId ? 'Webhook updated' : 'Webhook added');
    } catch {
      setWError('Something went wrong. Please try again.');
    } finally {
      setWSaving(false);
    }
  }

  async function deleteWebhook(id: string) {
    if (!workspaceId) return;
    setWDeleting(id);
    try {
      await fetch(`/api/workspaces/${workspaceId}/integrations?integrationId=${id}`, { method: 'DELETE' });
      setWebhooks(prev => prev.filter(w => w.id !== id));
      setWebhookMappings(prev => { const n = { ...prev }; delete n[id]; return n; });
      toast.success('Webhook removed');
    } catch {
      toast.error('Failed to remove webhook');
    } finally {
      setWDeleting(null);
    }
  }

  async function testWebhook() {
    if (!workspaceId || !wUrl.trim()) return;
    setWTesting(true);
    setWTestResult(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/integrations/test-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { url: wUrl.trim(), format: wFormat, headers: wHeaders.filter(h => h.key.trim()) },
          mappings: { formFields: wFormFields, systemFields: wSystemFields },
        }),
      });
      const result = await res.json() as { ok: boolean; statusCode?: number; error?: string };
      setWTestResult(result);
    } catch {
      setWTestResult({ ok: false, error: 'Request failed' });
    } finally {
      setWTesting(false);
    }
  }

  async function saveTestMapping() {
    if (!hsIntegration) return;
    if (!hsSelectedFormId) { toast.error('Please select a mapping mode first'); return; }

    const isDirectContacts = hsSelectedFormId === 'none';
    const selectedForm = isDirectContacts ? null : hsForms.find(f => f.id === hsSelectedFormId);

    // For form-based flow, portal_id is required
    if (!isDirectContacts && !hsIntegration.hub_id) {
      toast.error('HubSpot portal ID missing — please reconnect HubSpot');
      return;
    }

    setSavingMapping(true);
    try {
      const field_mappings = isDirectContacts
        // Legacy flat shape → triggers contact upsert path
        ? testMapping.field_mappings
        // New shape → triggers form submission path
        : {
            fieldMappings: testMapping.field_mappings,
            form_guid: hsSelectedFormId,
            form_name: selectedForm?.name ?? '',
            portal_id: hsIntegration.hub_id ?? '',
          };

      const res = await fetch(`/api/tests/${test.id}/integrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_integration_id: hsIntegration.id,
          enabled: true,
          field_mappings,
        }),
      });
      if (!res.ok) { toast.error('Failed to save mapping'); return; }
      setTestMapping(prev => ({
        ...prev,
        form_guid: isDirectContacts ? '' : hsSelectedFormId,
        portal_id: isDirectContacts ? '' : (hsIntegration.hub_id ?? ''),
      }));
      toast.success('Mapping saved');
    } finally {
      setSavingMapping(false);
    }
  }

  function updateMapping(ourField: string, hubspotProp: string) {
    setTestMapping(prev => ({
      ...prev,
      field_mappings: { ...prev.field_mappings, [ourField]: hubspotProp },
    }));
  }

  function removeMapping(ourField: string) {
    setTestMapping(prev => {
      const fm = { ...prev.field_mappings };
      delete fm[ourField];
      return { ...prev, field_mappings: fm };
    });
  }

  function addCustomFormField() {
    const key = newFieldKey.trim();
    if (!key) return;
    setTestFormKeys(prev => Array.from(new Set([...prev, key])));
    setNewFieldKey('');
  }

  function exportFormLeadsCsv() {
    if (formLeads.length === 0) return;
    const fixedCols = ['submitted_at', 'variant', 'visitor_hash', 'ip_address', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'user_agent'];
    const allCols = [...fixedCols, ...formLeadsFieldKeys];
    const rows = formLeads.map((l) => allCols.map((col) => {
      if (col === 'variant') return l.test_variants?.name ?? '';
      if (col in l) return String((l as unknown as Record<string, unknown>)[col] ?? '');
      return String(l.form_fields?.[col] ?? '');
    }));
    const csv = [allCols, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `form-leads-${test.id}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    if (!scanResultsLoaded && !scanning) {
      setScanResultsLoaded(true);
      fetch(`/api/tests/${test.id}/scan-results`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.scan_results?.variants) setScanResults(data.scan_results);
        })
        .catch(() => {});
    }
  }, [scanResultsLoaded, scanning, test.id]);

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
    setTimeout(refreshVisitorCap, 1500);
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

    // Poll every 2 s for up to 2 minutes to catch stepper form steps
    let attempts = 0;
    const maxAttempts = 60;
    let foundFirst = false;
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
            foundFirst = true;
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
        // Only show error if we never got any results
        if (!foundFirst) {
          toast.error(
            "Scan timed out. Make sure tracker.js is installed and the page loaded.",
          );
        }
      }
    };
    setTimeout(poll, 3000);

    // Re-fetch when user switches back to this tab after clicking "Finish Scanning"
    const onVisibilityChange = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`/api/tests/${test.id}/scan-results`);
        if (!res.ok) return;
        const data = await res.json();
        const variantEntry = data.scan_results?.variants?.find(
          (v: { variant_id: string }) => v.variant_id === variantId,
        );
        if (variantEntry) {
          setScanResults(data.scan_results);
          setScanning(false);
        }
      } catch { /* ignore */ }
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  async function enableAsGoal(el: {
    type: string;
    id: string | null;
    text: string | null;
  }, variantId: string) {
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
      variant_id: variantId,
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
            variant_id: g.variant_id ?? null,
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
  }, variantId: string) {
    const matchSelector = el.id
      ? `id:${el.id}`
      : el.text
        ? `text:${el.text}`
        : null;
    if (!matchSelector) return;

    const originalGoals = editGoals;
    const updatedGoals = editGoals.filter(
      (g) => !(g.selector === matchSelector && g.variant_id === variantId),
    );
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
            variant_id: g.variant_id ?? null,
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
    { key: "leads", label: "Conversions", icon: <Users size={14} /> },
    { key: "form-leads", label: "Leads", icon: <ClipboardList size={14} /> },
    { key: "integrations", label: "Integrations", icon: <Plug2 size={14} /> },
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
          <ChevronRightSmall size={12} />
          <Link
            href={`/clients/${clientId}/pages`}
            className="hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
          >
            Pages
          </Link>
          <ChevronRightSmall size={12} />
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
                  {/* No domain configured — show the test URL for real traffic */}
                  {(() => {
                    const nameSlug = test.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                    const testUrl = `${appUrl}/${nameSlug}/${test.id}`;
                    return (
                      <>
                        <div className="flex items-center gap-2">
                          <code className="text-[11px] text-indigo-400 font-mono truncate max-w-[360px]">
                            {testUrl}
                          </code>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(testUrl);
                              toast.success("URL copied");
                            }}
                            className="text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0"
                            title="Copy URL"
                          >
                            <Copy size={11} />
                          </button>
                          {test.status === "active" ? (
                            <a
                              href={testUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0"
                              title="Open URL"
                            >
                              <ExternalLink size={11} />
                            </a>
                          ) : null}
                        </div>
                        <p className={`text-[10px] mt-0.5 ${test.status === "active" ? "text-green-500" : "text-amber-500"}`}>
                          {test.status === "active"
                            ? "This link is live and accepting real traffic."
                            : "This link only works when the test is published."}
                        </p>
                      </>
                    );
                  })()}
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
              onClick={() => { window.open(buildTestPreviewUrl(), "_blank"); setTimeout(refreshVisitorCap, 1500); }}
              disabled={visitorOverCap}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-slate-500/10 border border-slate-500/20 text-slate-400 hover:bg-slate-500/20 hover:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
              title={visitorOverCap ? "Visitor limit reached — upgrade your plan to resume testing" : "Open the test as a fresh visitor — SplitLab assigns the variant"}
            >
              <ExternalLink size={14} /> Preview Test
            </button>

            {!domain &&
              userRole !== "viewer" &&
              (userRole === "admin" || userPlan !== "free") && (
                <Link
                  href={`/clients/${clientId}/domains`}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-colors bg-indigo-600 border border-indigo-500 text-white hover:bg-indigo-500 shadow-lg shadow-indigo-500/30"
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
                      {anyTrackerMissing && (
                        <button
                          onClick={verifyAllTracking}
                          disabled={bannerVerifying}
                          className="btn-primary text-xs flex-shrink-0"
                        >
                          {bannerVerifying ? (
                            <><Spinner size="sm" /> Verifying…</>
                          ) : (
                            <><ShieldCheck size={12} /> Verify Tracking</>
                          )}
                        </button>
                      )}
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

            <div className="card overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
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
                    <th className="text-center px-5 py-3 text-slate-400 font-medium w-20"></th>
                    <th className="text-center px-5 py-3 text-slate-400 font-medium w-36"></th>
                    <th className="text-center px-5 py-3 text-slate-400 font-medium w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td
                        colSpan={10}
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
                        colSpan={10}
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
                                  {verified === true ? (
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
                                  ) : (
                                    <button
                                      onClick={() =>
                                        checkTracking(
                                          stat.variant.id,
                                          stat.variant.redirect_url!,
                                        )
                                      }
                                      disabled={checkingTracking === stat.variant.id || autoCheckingIds.includes(stat.variant.id)}
                                      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50 ${
                                        verified === false
                                          ? "bg-red-500/10 border-red-500/40 text-red-400 hover:bg-red-500/20"
                                          : "bg-slate-500/10 border-slate-500/30 text-slate-400 hover:bg-slate-500/20"
                                      }`}
                                    >
                                      {checkingTracking === stat.variant.id || autoCheckingIds.includes(stat.variant.id) ? (
                                        <><Spinner size="sm" /> Checking…</>
                                      ) : verified === false ? (
                                        <><ShieldX size={12} /> Verify Tracking</>
                                      ) : (
                                        <><ShieldCheck size={12} /> Verify Tracking</>
                                      )}
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
                            {/* Uplift % */}
                            <td className={`px-5 py-3.5 text-center ${rowBg}`}>
                              {uplift !== null ? (
                                <span className={`flex items-center justify-center gap-0.5 text-xs font-medium ${uplift > 0 ? "text-green-400" : "text-red-400"}`}>
                                  <TrendingUp size={11} className={uplift < 0 ? "rotate-180" : ""} />
                                  {uplift > 0 ? "+" : ""}{formatPercent(uplift)}
                                </span>
                              ) : (
                                <span className="text-slate-500">—</span>
                              )}
                            </td>
                            {/* Open + Setup Goal Tracking */}
                            <td className={`px-3 py-3.5 text-center ${rowBg}`}>
                              <div className="flex flex-col items-center gap-1">
                                <button
                                  onClick={() => openVariant(stat.variant.id)}
                                  disabled={visitorOverCap}
                                  className="flex items-center justify-center gap-1 w-full px-2 py-1 rounded-lg text-xs font-medium bg-slate-500/10 border border-slate-500/20 text-slate-400 hover:bg-slate-500/20 hover:text-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                  title={visitorOverCap ? "Visitor limit reached — upgrade your plan to resume testing" : `Open ${stat.variant.name}`}
                                >
                                  <ExternalLink size={11} />
                                  Open
                                </button>
                                <button
                                  onClick={() => {
                                    if (getVerifiedStatus(stat.variant) === false) {
                                      toast.error('Install the tracker.js snippet on your landing page first, then set up goal or event tracking.');
                                      return;
                                    }
                                    scanPage(stat.variant.id);
                                  }}
                                  disabled={scanning}
                                  className={`flex items-center justify-center gap-1 w-full px-2 py-1 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap ${
                                    scanResults !== null && !scanResults.variants.some(vs => vs.variant_id === stat.variant.id)
                                      ? "bg-amber-500 border border-amber-400 text-white hover:bg-amber-600 shadow-sm shadow-amber-500/30"
                                      : "bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20"
                                  }`}
                                  title={scanResults !== null && !scanResults.variants.some(vs => vs.variant_id === stat.variant.id) ? "This variant has never been scanned — click to detect trackable elements" : "Set up goal or event tracking"}
                                >
                                  <ScanLine size={11} />
                                  Setup Goal Tracking
                                </button>
                              </div>
                            </td>
                            {/* Edit icon */}
                            <td className={`px-3 py-3.5 text-center ${rowBg}`}>
                              <button
                                onClick={() => startEditVariant(stat.variant)}
                                className={`p-1 rounded transition-colors ${isEditing ? "bg-indigo-500/20 text-indigo-400" : "text-slate-400 dark:text-slate-600 hover:text-slate-700 dark:hover:text-slate-300"}`}
                                title="Edit variant"
                              >
                                <Pencil size={13} />
                              </button>
                            </td>
                          </tr>

                          {isEditing && (
                            <tr>
                              <td
                                colSpan={10}
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
                                        onChange={(e) => {
                                          setVariantDraft({
                                            ...variantDraft,
                                            redirect_url: e.target.value,
                                          });
                                        }}
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
                                        onClick={() => saveVariant(stat.variant.id)}
                                        loading={savingVariant || checkingFrameable}
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

            {/* ── PAGE REPORTING ── */}
            <div className="card overflow-hidden">
              {/* Header / toggle */}
              <button
                onClick={() => setReportingOpen((o) => !o)}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <Activity size={16} className="text-indigo-400" />
                  <span className="font-semibold text-sm text-slate-800 dark:text-slate-200">Page Reporting</span>
                  {reportingLoaded && (
                    <span className="text-xs text-slate-400 font-normal">
                      {reportingFrom} – {reportingTo}
                    </span>
                  )}
                </div>
                <ChevronDown
                  size={16}
                  className={`text-slate-400 transition-transform duration-200 ${reportingOpen ? "rotate-180" : ""}`}
                />
              </button>

              {reportingOpen && (
                <div className="border-t border-slate-200 dark:border-slate-700">
                  {/* Controls */}
                  <div className="px-5 pt-4 pb-3 flex flex-wrap items-end gap-3">
                    {/* Date range */}
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-slate-500 font-medium">From</label>
                      <input
                        type="date"
                        value={reportingFrom}
                        onChange={(e) => setReportingFrom(e.target.value)}
                        className="input-base w-36 text-sm"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-slate-500 font-medium">To</label>
                      <input
                        type="date"
                        value={reportingTo}
                        onChange={(e) => setReportingTo(e.target.value)}
                        className="input-base w-36 text-sm"
                      />
                    </div>

                    {/* Metric */}
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-slate-500 font-medium">Metric</label>
                      <select
                        value={reportingMetric}
                        onChange={(e) => setReportingMetric(e.target.value as typeof reportingMetric)}
                        className="input-base text-sm pr-8"
                      >
                        <option value="conversions">Conversions Over Time</option>
                        <option value="cvr">Conversion Rate Over Time</option>
                        <option value="visitors">Visitors Over Time</option>
                        <option value="views">Views Over Time</option>
                      </select>
                    </div>

                    {/* Variant filter */}
                    <div className="flex flex-col gap-1 relative" ref={reportingDropdownRef}>
                      <label className="text-xs text-slate-500 font-medium">Variants</label>
                      <button
                        onClick={() => setReportingVariantDropdownOpen((o) => !o)}
                        className="input-base text-sm flex items-center gap-2 min-w-[160px] justify-between"
                      >
                        <span className="truncate">
                          {reportingVariantFilter.size === reportingVariants.length + 1
                            ? "All Variants"
                            : reportingVariantFilter.size === 0
                            ? "None"
                            : `${reportingVariantFilter.size} selected`}
                        </span>
                        <ChevronDown size={12} className="flex-shrink-0 text-slate-400" />
                      </button>
                      {reportingVariantDropdownOpen && (
                        <div className="absolute top-full mt-1 left-0 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl py-2 min-w-[220px] max-h-72 overflow-y-auto">
                          {/* Overall */}
                          <label className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                            <input
                              type="checkbox"
                              checked={reportingVariantFilter.has('overall')}
                              onChange={(e) => {
                                const next = new Set(reportingVariantFilter);
                                e.target.checked ? next.add('overall') : next.delete('overall');
                                setReportingVariantFilter(next);
                              }}
                              className="rounded accent-indigo-500"
                            />
                            <span className="text-sm text-slate-700 dark:text-slate-200 font-medium">Overall</span>
                          </label>
                          {/* Variants */}
                          {reportingVariants.length > 0 && (
                            <>
                              <div className="px-3 py-1 mt-1">
                                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Variants</span>
                              </div>
                              {reportingVariants.map((v) => (
                                <label key={v.id} className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                                  <input
                                    type="checkbox"
                                    checked={reportingVariantFilter.has(v.id)}
                                    onChange={(e) => {
                                      const next = new Set(reportingVariantFilter);
                                      e.target.checked ? next.add(v.id) : next.delete(v.id);
                                      setReportingVariantFilter(next);
                                    }}
                                    className="rounded accent-indigo-500"
                                  />
                                  <span className="text-sm text-slate-700 dark:text-slate-200 truncate">{v.name}</span>
                                </label>
                              ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>

                    <button
                      onClick={() => { setReportingLoaded(false); fetchReporting(); }}
                      disabled={reportingLoading}
                      className="btn-secondary self-end"
                    >
                      <RefreshCw size={13} className={reportingLoading ? "animate-spin" : ""} />
                      Apply
                    </button>
                  </div>

                  {/* Summary cards */}
                  {reportingLoaded && (
                    <div className="px-5 pb-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { label: "Visitors", value: reportingTotals.visitors.toLocaleString(), icon: <Users size={14} className="text-indigo-400" /> },
                        { label: "Views", value: reportingTotals.views.toLocaleString(), icon: <Eye size={14} className="text-sky-400" /> },
                        { label: "Conversions", value: reportingTotals.conversions.toLocaleString(), icon: <TrendingUp size={14} className="text-green-400" /> },
                        { label: "Conv. Rate", value: `${reportingTotals.cvr}%`, icon: <Activity size={14} className="text-amber-400" /> },
                      ].map((card) => (
                        <div key={card.label} className="bg-slate-50 dark:bg-slate-800/60 rounded-xl px-4 py-3 flex flex-col gap-1 border border-slate-200 dark:border-slate-700">
                          <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                            {card.icon}
                            <span className="text-xs font-medium">{card.label}</span>
                          </div>
                          <span className="text-xl font-bold text-slate-800 dark:text-slate-100">{card.value}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Chart */}
                  <div className="px-5 pb-5">
                    {reportingLoading ? (
                      <div className="flex items-center justify-center h-64 gap-2 text-slate-400">
                        <RefreshCw size={16} className="animate-spin" />
                        <span className="text-sm">Loading chart…</span>
                      </div>
                    ) : reportingError ? (
                      <div className="flex flex-col items-center justify-center h-64 gap-2 text-red-400">
                        <AlertTriangle size={24} className="opacity-60" />
                        <p className="text-sm">{reportingError}</p>
                        <button onClick={fetchReporting} className="btn-secondary text-xs mt-1">
                          <RefreshCw size={12} /> Retry
                        </button>
                      </div>
                    ) : !reportingLoaded ? null : reportingDaily.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-64 gap-2 text-slate-400">
                        <BarChart3 size={32} className="opacity-30" />
                        <p className="text-sm">No data for selected range</p>
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height={280}>
                        <LineChart data={reportingDaily} margin={{ top: 4, right: 16, bottom: 0, left: -10 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
                          <XAxis
                            dataKey="date"
                            tick={{ fontSize: 11, fill: '#94a3b8' }}
                            tickFormatter={(v: string) => {
                              const d = new Date(v + 'T00:00:00');
                              return `${d.toLocaleString('default', { month: 'short' })} ${d.getDate()}`;
                            }}
                            tickLine={false}
                            axisLine={false}
                          />
                          <YAxis
                            tick={{ fontSize: 11, fill: '#94a3b8' }}
                            tickLine={false}
                            axisLine={false}
                            allowDecimals={reportingMetric === 'cvr'}
                            tickFormatter={(v: number) => reportingMetric === 'cvr' ? `${v}%` : String(v)}
                          />
                          <Tooltip
                            contentStyle={{
                              background: 'rgba(15,23,42,0.95)',
                              border: '1px solid rgba(148,163,184,0.2)',
                              borderRadius: '10px',
                              fontSize: '12px',
                              color: '#e2e8f0',
                            }}
                            formatter={(value: number, name: string) => {
                              const label = reportingMetric === 'cvr' ? `${value}%` : value;
                              return [label, name];
                            }}
                            labelFormatter={(label: string) => {
                              const d = new Date(label + 'T00:00:00');
                              return d.toLocaleDateString('default', { month: 'short', day: 'numeric', year: 'numeric' });
                            }}
                          />
                          <Legend
                            wrapperStyle={{ fontSize: '11px', paddingTop: '12px' }}
                            formatter={(value: string) => <span style={{ color: '#94a3b8' }}>{value}</span>}
                          />
                          {/* Overall line */}
                          {reportingVariantFilter.has('overall') && (
                            <Line
                              type="monotone"
                              dataKey={`overall_${reportingMetric}`}
                              name="Overall"
                              stroke={CHART_COLORS[0]}
                              strokeWidth={2}
                              dot={{ r: 3, fill: CHART_COLORS[0] }}
                              activeDot={{ r: 5 }}
                            />
                          )}
                          {/* Per-variant lines */}
                          {reportingVariants.map((v, idx) =>
                            reportingVariantFilter.has(v.id) ? (
                              <Line
                                key={v.id}
                                type="monotone"
                                dataKey={`${v.id}_${reportingMetric}`}
                                name={v.name}
                                stroke={CHART_COLORS[(idx + 1) % CHART_COLORS.length]}
                                strokeWidth={1.5}
                                dot={{ r: 2.5, fill: CHART_COLORS[(idx + 1) % CHART_COLORS.length] }}
                                activeDot={{ r: 4.5 }}
                              />
                            ) : null
                          )}
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>
              )}
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

        {/* ─── FORM LEADS TAB ─── */}
        {tab === "form-leads" && (
          <div className="space-y-4">
            {/* Filters bar */}
            <div className="card px-5 py-4">
              <div className="flex flex-wrap gap-3 items-end">
                {/* Variant filter */}
                <div className="flex flex-col gap-1 min-w-[160px]">
                  <label className="text-xs text-slate-500 dark:text-slate-400 font-medium">Variant</label>
                  <select
                    value={flVariantId}
                    onChange={(e) => setFlVariantId(e.target.value)}
                    className="input-base text-sm py-1.5"
                  >
                    <option value="">All Variants</option>
                    {variants.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
                {/* Date from */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-slate-500 dark:text-slate-400 font-medium">From</label>
                  <input
                    type="date"
                    value={flFrom}
                    onChange={(e) => setFlFrom(e.target.value)}
                    className="input-base text-sm py-1.5"
                  />
                </div>
                {/* Date to */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-slate-500 dark:text-slate-400 font-medium">To</label>
                  <input
                    type="date"
                    value={flTo}
                    onChange={(e) => setFlTo(e.target.value)}
                    className="input-base text-sm py-1.5"
                  />
                </div>
                {/* Search */}
                <div className="flex flex-col gap-1 flex-1 min-w-[180px]">
                  <label className="text-xs text-slate-500 dark:text-slate-400 font-medium">Search</label>
                  <div className="relative">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Name, email, phone…"
                      value={flSearchInput}
                      onChange={(e) => setFlSearchInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { setFlSearch(flSearchInput); fetchFormLeads(1, { variantId: flVariantId, from: flFrom, to: flTo, search: flSearchInput }); }
                      }}
                      className="input-base text-sm py-1.5 pl-8"
                    />
                  </div>
                </div>
                {/* Apply + Reset + Export */}
                <div className="flex gap-2 pb-0.5">
                  <button
                    onClick={() => { setFlSearch(flSearchInput); fetchFormLeads(1, { variantId: flVariantId, from: flFrom, to: flTo, search: flSearchInput }); }}
                    className="btn-primary text-xs"
                    disabled={formLeadsLoading}
                  >
                    {formLeadsLoading ? <RefreshCw size={12} className="animate-spin" /> : <Search size={12} />}
                    Apply
                  </button>
                  <button
                    onClick={() => {
                      setFlVariantId(""); setFlFrom(""); setFlTo(""); setFlSearch(""); setFlSearchInput("");
                      fetchFormLeads(1, { variantId: "", from: "", to: "", search: "" });
                    }}
                    className="btn-secondary text-xs"
                  >
                    Reset
                  </button>
                  <button
                    onClick={exportFormLeadsCsv}
                    disabled={formLeads.length === 0}
                    className="btn-secondary text-xs"
                  >
                    <Download size={12} /> CSV
                  </button>
                </div>
              </div>
            </div>

            {/* Table */}
            {formLeadsLoading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw size={20} className="animate-spin text-slate-500 dark:text-slate-400" />
              </div>
            ) : formLeads.length === 0 ? (
              <div className="text-center py-12">
                <ClipboardList size={32} className="mx-auto text-slate-600 mb-3" />
                <p className="text-slate-500 dark:text-slate-400 text-sm">No form leads yet.</p>
                <p className="text-slate-500 text-xs mt-1">
                  When a visitor submits a form on your test page, it will appear here.
                </p>
              </div>
            ) : (
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700">
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {formLeadsTotal} lead{formLeadsTotal !== 1 ? "s" : ""} total
                    {formLeadsTotal > FORM_LEADS_LIMIT && ` — page ${formLeadsPage} of ${Math.ceil(formLeadsTotal / FORM_LEADS_LIMIT)}`}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => fetchFormLeads(1)}
                      className="btn-secondary text-xs"
                    >
                      <RefreshCw size={12} /> Refresh
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-700">
                        <th className="text-left px-4 py-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">#</th>
                        <th className="text-left px-4 py-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">Date / Time</th>
                        <th className="text-left px-4 py-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">Variant</th>
                        {formLeadsFieldKeys.map((key) => (
                          <th key={key} className="text-left px-4 py-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap capitalize">
                            {key.replace(/_/g, ' ')}
                          </th>
                        ))}
                        <th className="text-left px-4 py-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">UTM Source</th>
                        <th className="text-left px-4 py-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">UTM Campaign</th>
                        <th className="text-left px-4 py-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">IP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {formLeads.map((lead, idx) => (
                        <tr key={lead.id} className="border-b border-slate-200 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="px-4 py-2.5 text-slate-400 text-xs">
                            {(formLeadsPage - 1) * FORM_LEADS_LIMIT + idx + 1}
                          </td>
                          <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300 text-xs whitespace-nowrap">
                            {new Date(lead.submitted_at).toLocaleString()}
                          </td>
                          <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300 whitespace-nowrap">
                            {lead.test_variants?.name ?? "—"}
                          </td>
                          {formLeadsFieldKeys.map((key) => (
                            <td key={key} className="px-4 py-2.5 text-slate-700 dark:text-slate-300 max-w-[200px] truncate" title={lead.form_fields?.[key] ?? ''}>
                              {lead.form_fields?.[key] ?? <span className="text-slate-400">—</span>}
                            </td>
                          ))}
                          <td className="px-4 py-2.5 text-slate-500 text-xs">{lead.utm_source ?? "—"}</td>
                          <td className="px-4 py-2.5 text-slate-500 text-xs">{lead.utm_campaign ?? "—"}</td>
                          <td className="px-4 py-2.5 text-slate-400 text-xs font-mono">{lead.ip_address ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {formLeadsTotal > FORM_LEADS_LIMIT && (
                  <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-700">
                    <p className="text-xs text-slate-500">
                      Showing {(formLeadsPage - 1) * FORM_LEADS_LIMIT + 1}–{Math.min(formLeadsPage * FORM_LEADS_LIMIT, formLeadsTotal)} of {formLeadsTotal}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => fetchFormLeads(formLeadsPage - 1)}
                        disabled={formLeadsPage <= 1 || formLeadsLoading}
                        className="btn-secondary text-xs"
                      >
                        <ChevronLeft size={12} /> Prev
                      </button>
                      <span className="text-xs text-slate-500">Page {formLeadsPage} of {Math.ceil(formLeadsTotal / FORM_LEADS_LIMIT)}</span>
                      <button
                        onClick={() => fetchFormLeads(formLeadsPage + 1)}
                        disabled={formLeadsPage >= Math.ceil(formLeadsTotal / FORM_LEADS_LIMIT) || formLeadsLoading}
                        className="btn-secondary text-xs"
                      >
                        Next <ChevronRightSmall size={12} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ─── INTEGRATIONS TAB ─── */}
        {tab === "integrations" && (
          <div className="space-y-6 p-6">

            {/* Sub-tabs */}
            <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1 w-fit">
              {(['native', 'webhooks'] as const).map(st => (
                <button
                  key={st}
                  onClick={() => setIntegrationsSubTab(st)}
                  className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${integrationsSubTab === st ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                  {st === 'native' ? 'Native Integrations' : 'Webhooks'}
                </button>
              ))}
            </div>

            {/* ── NATIVE INTEGRATIONS ── */}
            {integrationsSubTab === 'native' && (<>

            {/* ── HubSpot connect card ── */}
            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-orange-500/15 flex items-center justify-center">
                  <svg width="18" height="18" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M326.4 173.5v-51.7a43.5 43.5 0 0 0 25.2-39.3V80.9C351.6 57.4 332.7 38 309.2 38h-1.4c-23.5 0-42.4 19.4-42.4 42.9v1.6a43.5 43.5 0 0 0 25.2 39.3v51.7c-24.5 3.7-46.9 13.9-65.2 28.8L107 110.1a38.9 38.9 0 1 0-21.6 19.5l113.2 91.6c-16.7 22.4-26.6 50.2-26.6 80.4 0 73.3 59.5 132.8 132.8 132.8S437.6 374.9 437.6 301.6c0-69-52.6-125.7-120-131.8l8.8-.3zM304.8 392.4c-50 0-90.5-40.5-90.5-90.5s40.5-90.5 90.5-90.5 90.5 40.5 90.5 90.5-40.5 90.5-90.5 90.5z" fill="#FF7A59"/>
                  </svg>
                </div>
                <div>
                  <p className="font-semibold text-sm text-slate-800 dark:text-slate-200">HubSpot</p>
                  <p className="text-xs text-slate-500">Send leads to your HubSpot CRM automatically</p>
                </div>
                {hsIntegration && (
                  <span className="ml-auto flex items-center gap-1.5 text-xs font-medium text-green-500">
                    <CheckCircle2 size={13} /> Connected
                  </span>
                )}
              </div>

              <div className="px-5 py-4">
                {!hsIntegration ? (
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-500">
                      Connect your HubSpot account to automatically sync form leads to your CRM.
                    </p>
                    <a
                      href={workspaceId ? `/api/integrations/hubspot/connect?workspaceId=${workspaceId}&returnTo=${encodeURIComponent(window.location.pathname + '?tab=integrations&hs_connected=1')}` : '#'}
                      className="btn-primary text-sm flex items-center gap-2 px-4 py-2 rounded-lg font-medium no-underline"
                    >
                      <svg width="14" height="14" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M326.4 173.5v-51.7a43.5 43.5 0 0 0 25.2-39.3V80.9C351.6 57.4 332.7 38 309.2 38h-1.4c-23.5 0-42.4 19.4-42.4 42.9v1.6a43.5 43.5 0 0 0 25.2 39.3v51.7c-24.5 3.7-46.9 13.9-65.2 28.8L107 110.1a38.9 38.9 0 1 0-21.6 19.5l113.2 91.6c-16.7 22.4-26.6 50.2-26.6 80.4 0 73.3 59.5 132.8 132.8 132.8S437.6 374.9 437.6 301.6c0-69-52.6-125.7-120-131.8l8.8-.3zM304.8 392.4c-50 0-90.5-40.5-90.5-90.5s40.5-90.5 90.5-90.5 90.5 40.5 90.5 90.5-40.5 90.5-90.5 90.5z" fill="white"/>
                      </svg>
                      Connect HubSpot
                    </a>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-500">
                      HubSpot is connected. Map your form fields to HubSpot contact properties below.
                    </p>
                    <button
                      onClick={disconnectHubSpot}
                      disabled={hsDisconnecting}
                      className="text-xs text-red-400 hover:text-red-300 transition-colors flex items-center gap-1"
                    >
                      <XCircle size={13} /> {hsDisconnecting ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  </div>
                )}
              </div>

              {/* ── Field mapping (inline when connected) ── */}
              {hsIntegration && (
                <>
                  <div className="px-5 py-3 border-t border-b border-slate-200 dark:border-slate-700 flex items-center gap-4">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-200 flex-1">Field Mapping</p>
                    {testMapping.last_synced_at && (
                      <div className="flex items-center gap-3 text-xs text-slate-400">
                        <span className="flex items-center gap-1">
                          <CheckCircle2 size={12} className="text-green-400" />
                          {testMapping.total_synced ?? 0} synced
                        </span>
                        {(testMapping.total_failed ?? 0) > 0 && (
                          <span className="flex items-center gap-1 text-red-400">
                            <XCircle size={12} /> {testMapping.total_failed} failed
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <RefreshCw size={11} />
                          {new Date(testMapping.last_synced_at).toLocaleDateString()}
                        </span>
                      </div>
                    )}
                  </div>

                  {hsFormsLoading ? (
                    <div className="px-5 py-6 flex items-center gap-2 text-sm text-slate-400">
                      <Loader2 size={14} className="animate-spin" /> Loading HubSpot forms…
                    </div>
                  ) : (
                    <div className="px-5 py-5 space-y-5">
                      {/* Step 1 — Select HubSpot Form */}
                      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <div className="w-5 h-5 rounded-full bg-orange-500/20 text-orange-400 flex items-center justify-center text-xs font-bold flex-shrink-0">1</div>
                          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Select a HubSpot Form</p>
                        </div>
                          <select
                            value={hsSelectedFormId}
                            onChange={e => {
                              setHsSelectedFormId(e.target.value);
                              setTestMapping(prev => ({ ...prev, field_mappings: {} }));
                            }}
                            className="input text-sm w-full"
                          >
                            <option value="">— Choose an option —</option>
                            <option value="none">Map directly to HubSpot Contacts (no form)</option>
                            {hsForms.map(f => (
                              <option key={f.id} value={f.id}>{f.name}</option>
                            ))}
                          </select>
                          {hsForms.length === 0 && (
                            <p className="text-xs text-slate-400 mt-2 italic">No HubSpot forms found — you can still map directly to contacts above.</p>
                          )}
                      </div>

                      {/* Step 2 — Map fields once a mode is selected */}
                      {hsSelectedFormId && (() => {
                        const isDirectContacts = hsSelectedFormId === 'none';
                        const selectedForm = isDirectContacts ? null : hsForms.find(f => f.id === hsSelectedFormId);
                        if (!isDirectContacts && !selectedForm) return null;
                        const destinationLabel = isDirectContacts ? 'HubSpot Contact Property' : 'HubSpot Form Field';
                        const destinationOptions = isDirectContacts
                          ? hsProperties.map(p => <option key={p.name} value={p.name}>{p.label} ({p.name})</option>)
                          : selectedForm!.fields.map(f => <option key={f.name} value={f.name}>{f.label} ({f.name})</option>);
                        return (
                          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-4 space-y-3">
                            <div className="flex items-center gap-2 mb-1">
                              <div className="w-5 h-5 rounded-full bg-orange-500/20 text-orange-400 flex items-center justify-center text-xs font-bold flex-shrink-0">2</div>
                              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Map Fields</p>
                              {!isDirectContacts && <span className="text-xs text-slate-400 ml-1">→ <span className="text-indigo-400">{selectedForm!.name}</span></span>}
                            </div>
                            <div className="grid grid-cols-[1fr_32px_1fr_32px] gap-2 text-xs font-medium text-slate-500 uppercase tracking-wider">
                              <span>SplitLab Field</span>
                              <span />
                              <span>{destinationLabel}</span>
                              <span />
                            </div>

                            {testFormKeys.map(fk => (
                              <div key={fk} className="grid grid-cols-[1fr_32px_1fr_32px] gap-2 items-center">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs px-2 py-1 rounded bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 font-mono">{fk}</span>
                                  <span className="text-xs text-slate-400 bg-slate-50 dark:bg-slate-800/50 px-1.5 py-0.5 rounded">form</span>
                                </div>
                                <ArrowRight size={13} className="text-orange-400 mx-auto" />
                                <select
                                  value={testMapping.field_mappings[fk] ?? ''}
                                  onChange={e => updateMapping(fk, e.target.value)}
                                  className="input text-xs py-1.5"
                                >
                                  <option value="">(-) Not mapped</option>
                                  {destinationOptions}
                                </select>
                                <span />
                              </div>
                            ))}

                            {testFormKeys.length === 0 && (
                              <p className="text-xs text-slate-400 italic">No form fields detected yet. Submit the form on your landing page first.</p>
                            )}

                            {/* System fields */}
                            <div className="border-t border-slate-200 dark:border-slate-700 pt-3 mt-1">
                              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">System Fields</p>
                              {[
                                { key: 'ip_address', label: 'IP Address' },
                                { key: 'variant', label: 'Page Variant' },
                                { key: 'submitted_at', label: 'Submission Date' },
                                { key: 'utm_source', label: 'UTM Source' },
                                { key: 'utm_medium', label: 'UTM Medium' },
                                { key: 'utm_campaign', label: 'UTM Campaign' },
                                { key: 'utm_content', label: 'UTM Content' },
                                { key: 'utm_term', label: 'UTM Term' },
                                { key: 'gclid', label: 'GCLID' },
                              ].map(sf => (
                                <div key={sf.key} className="grid grid-cols-[1fr_32px_1fr_32px] gap-2 items-center mb-2">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs px-2 py-1 rounded bg-slate-100 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400 font-mono">{sf.label}</span>
                                    <span className="text-xs text-slate-400 bg-slate-50 dark:bg-slate-800/50 px-1.5 py-0.5 rounded">system</span>
                                  </div>
                                  <ArrowRight size={13} className="text-orange-400 mx-auto" />
                                  <select
                                    value={testMapping.field_mappings[sf.key] ?? ''}
                                    onChange={e => updateMapping(sf.key, e.target.value)}
                                    className="input text-xs py-1.5"
                                  >
                                    <option value="">(-) Not mapped</option>
                                    {destinationOptions}
                                  </select>
                                  <span />
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex justify-end">
                    <Button size="sm" onClick={saveTestMapping} loading={savingMapping} disabled={!hsSelectedFormId || hsSelectedFormId === ''}>
                      <Check size={13} /> Save Changes
                    </Button>
                  </div>
                </>
              )}
            </div>

            {/* ── Email Notifications card ── */}
            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/15 flex items-center justify-center">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-400"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                </div>
                <div>
                  <p className="font-semibold text-sm text-slate-800 dark:text-slate-200">Email Notifications</p>
                  <p className="text-xs text-slate-500">Get an email every time a form is submitted on this test</p>
                </div>
                {emailIntegration && (
                  <span className="ml-auto flex items-center gap-1.5 text-xs font-medium text-green-500">
                    <CheckCircle2 size={13} /> Enabled
                  </span>
                )}
              </div>

              <div className="px-5 py-4">
                {!emailIntegration ? (
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-500">
                      Receive an email notification every time a visitor submits a form on any variant of this test.
                    </p>
                    <button
                      onClick={openEmailModal}
                      className="btn-primary text-sm flex items-center gap-2 px-4 py-2 rounded-lg font-medium ml-4 flex-shrink-0"
                    >
                      <Plus size={14} /> Enable
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-500">
                      Configure recipients and subject below. Notifications fire on every form submission.
                    </p>
                    <button
                      onClick={disconnectEmail}
                      disabled={emailDisconnecting}
                      className="text-xs text-red-400 hover:text-red-300 transition-colors flex items-center gap-1 ml-4 flex-shrink-0"
                    >
                      <XCircle size={13} /> {emailDisconnecting ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* ── Email config summary (when configured) ── */}
            {emailIntegration && emailMapping.recipients && (
              <div className="card overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center gap-4">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200 flex-1">Email Configuration</p>
                  <button
                    onClick={openEmailModal}
                    className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1"
                  >
                    <Pencil size={12} /> Edit
                  </button>
                </div>
                <div className="px-5 py-4 space-y-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Recipients</p>
                    <div className="flex flex-wrap gap-1.5">
                      {emailMapping.recipients.split(',').map(r => r.trim()).filter(Boolean).map(r => (
                        <span key={r} className="inline-flex items-center px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-mono">{r}</span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Subject</p>
                    <p className="text-sm text-slate-700 dark:text-slate-300 font-mono text-xs">{emailMapping.subject}</p>
                  </div>
                  <div className="flex items-start gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs text-slate-400">
                    <Info size={12} className="flex-shrink-0 mt-0.5" />
                    <span>Email includes all captured form fields, variant name, and UTM data. Same config applies to all variants.</span>
                  </div>
                </div>
              </div>
            )}


            </>)}

            {/* ── WEBHOOKS TAB ── */}
            {integrationsSubTab === 'webhooks' && (
              <div className="space-y-4">
                {/* Header row */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Webhooks</p>
                    <p className="text-xs text-slate-500 mt-0.5">POST form data to any URL when a lead is submitted. Useful for Zapier, Make, or custom CRMs.</p>
                  </div>
                  <button onClick={openAddWebhookModal} className="btn-primary text-sm flex items-center gap-2 px-4 py-2 rounded-lg font-medium flex-shrink-0">
                    <Plus size={14} /> Add Webhook
                  </button>
                </div>

                {/* Webhook list */}
                {webhooks.length === 0 ? (
                  <div className="card px-6 py-10 text-center">
                    <div className="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-3">
                      <Link2 size={18} className="text-slate-400" />
                    </div>
                    <p className="text-sm font-medium text-slate-600 dark:text-slate-400">No webhooks configured</p>
                    <p className="text-xs text-slate-400 mt-1">Add a webhook to forward leads to any external URL.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {webhooks.map(wh => {
                      const mapping = webhookMappings[wh.id];
                      return (
                        <div key={wh.id} className="card overflow-hidden">
                          <div className="px-5 py-4 flex items-center gap-4">
                            <div className="w-9 h-9 rounded-lg bg-violet-500/15 flex items-center justify-center flex-shrink-0">
                              <Link2 size={16} className="text-violet-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                              {/* URL + format badge */}
                              <div className="flex items-center gap-2 mb-1.5">
                                <span className="flex-shrink-0 text-xs px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wide">POST</span>
                                <p className="text-sm font-mono text-slate-700 dark:text-slate-200 truncate">{wh.config?.url ?? '—'}</p>
                                <span className="flex-shrink-0 text-xs px-2 py-0.5 rounded-md bg-violet-500/10 text-violet-400 border border-violet-500/20 font-medium uppercase">{wh.config?.format ?? 'json'}</span>
                              </div>
                              {/* Stats row */}
                              <div className="flex items-center gap-3 text-xs text-slate-400">
                                {mapping?.last_synced_at ? (
                                  <>
                                    <span className="flex items-center gap-1">
                                      <CheckCircle2 size={11} className="text-green-400" />
                                      {mapping.total_synced ?? 0} delivered
                                    </span>
                                    {(mapping.total_failed ?? 0) > 0 && (
                                      <span className="flex items-center gap-1 text-red-400">
                                        <XCircle size={11} /> {mapping.total_failed} failed
                                      </span>
                                    )}
                                    <span className="flex items-center gap-1">
                                      <RefreshCw size={10} /> Last: {new Date(mapping.last_synced_at).toLocaleDateString()}
                                    </span>
                                  </>
                                ) : (
                                  <span className="text-slate-500 italic">No deliveries yet</span>
                                )}
                                {wh.config?.headers?.length ? (
                                  <span className="flex items-center gap-1 text-slate-500">· {wh.config.headers.length} custom header{wh.config.headers.length > 1 ? 's' : ''}</span>
                                ) : null}
                              </div>
                            </div>
                            <div className="flex items-center gap-3 flex-shrink-0 border-l border-slate-200 dark:border-slate-700 pl-4">
                              <button onClick={() => openEditWebhookModal(wh)} className="text-xs text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-1.5">
                                <Pencil size={13} /> Edit
                              </button>
                              <button
                                onClick={() => deleteWebhook(wh.id)}
                                disabled={wDeleting === wh.id}
                                className="text-xs text-red-400 hover:text-red-300 transition-colors flex items-center gap-1.5"
                              >
                                {wDeleting === wh.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                                {wDeleting === wh.id ? 'Removing…' : 'Remove'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          </div>
        )}

        {/* ── Webhook Modal ── */}
        <Modal open={webhookModalOpen} onClose={() => setWebhookModalOpen(false)} title={editingWebhookId ? 'Edit Webhook' : 'Add a Webhook'}>
          <form onSubmit={submitWebhookModal} className="space-y-6">
            <p className="text-sm text-slate-500 dark:text-slate-400">POST your form data to any URL you choose. The payload fires every time a visitor submits a form on this test.</p>

            {/* URL + Format row */}
            <div className="grid grid-cols-[1fr_148px] gap-3 items-end">
              <div>
                <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                  Webhook URL <span className="text-red-400">*</span>
                </label>
                <div className="flex items-stretch rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-transparent transition-all overflow-hidden">
                  <span className="flex items-center px-3 bg-slate-50 dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700 text-slate-400 text-xs font-medium select-none flex-shrink-0">
                    POST
                  </span>
                  <input
                    type="url"
                    placeholder="https://hooks.zapier.com/hooks/catch/…"
                    value={wUrl}
                    onChange={e => setWUrl(e.target.value)}
                    className="flex-1 px-3 py-2.5 text-sm bg-transparent text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none font-mono placeholder:font-sans min-w-0"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">Format</label>
                <select value={wFormat} onChange={e => setWFormat(e.target.value as 'json' | 'form' | 'xml')} className="input w-full text-sm">
                  <option value="json">JSON</option>
                  <option value="form">Form Encoded</option>
                  <option value="xml">XML</option>
                </select>
              </div>
            </div>

            {/* Custom Headers */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider">Custom Headers</span>
                <button
                  type="button"
                  onClick={() => setWHeaders(prev => [...prev, { key: '', value: '' }])}
                  className="text-xs text-indigo-500 hover:text-indigo-400 font-medium flex items-center gap-1 transition-colors"
                >
                  <Plus size={12} /> Add Header
                </button>
              </div>
              <div className="px-4 py-3 space-y-2">
                {wHeaders.length === 0 ? (
                  <p className="text-xs text-slate-400 italic py-1">No custom headers. Add one if your endpoint requires authentication (e.g. <span className="font-mono not-italic">Authorization: Bearer …</span>).</p>
                ) : (
                  <>
                    <div className="grid grid-cols-[1fr_1fr_28px] gap-2 text-xs font-medium text-slate-400 uppercase tracking-wider">
                      <span>Header Name</span><span>Value</span><span />
                    </div>
                    {wHeaders.map((h, i) => (
                      <div key={i} className="grid grid-cols-[1fr_1fr_28px] gap-2 items-center">
                        <input
                          placeholder="e.g. Authorization"
                          value={h.key}
                          onChange={e => setWHeaders(prev => prev.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                          className="input text-sm font-mono placeholder:font-sans"
                        />
                        <input
                          placeholder="e.g. Bearer token123"
                          value={h.value}
                          onChange={e => setWHeaders(prev => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                          className="input text-sm font-mono placeholder:font-sans"
                        />
                        <button type="button" onClick={() => setWHeaders(prev => prev.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-400 transition-colors flex items-center justify-center">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>

            {/* Field Mapping */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider">Field Mapping</span>
              </div>

              <div className="px-4 py-3 space-y-5">
                {/* Info callout */}
                <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 text-xs text-amber-500 dark:text-amber-400">
                  <Info size={13} className="flex-shrink-0 mt-px" />
                  <span>The <strong>right side</strong> is the key name your CRM or tool will receive. Leave it <strong>blank</strong> to exclude that field from the payload entirely.</span>
                </div>

                {/* Form Fields section */}
                <div>
                  <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Form Fields</p>
                  {Object.keys(wFormFields).length === 0 ? (
                    <p className="text-xs text-slate-400 italic mb-2">No form fields detected yet. Scan a variant or add fields manually below.</p>
                  ) : (
                    <div className="space-y-2 mb-3">
                      <div className="grid grid-cols-[1fr_24px_1fr_28px] gap-2 text-xs font-medium text-slate-400 uppercase tracking-wider">
                        <span>SplitLab Field</span><span /><span>Webhook Key</span><span />
                      </div>
                      {Object.keys(wFormFields).map(fk => (
                        <div key={fk} className="grid grid-cols-[1fr_24px_1fr_28px] gap-2 items-center">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="inline-block text-xs px-2 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 font-mono truncate border border-blue-100 dark:border-blue-800">{fk}</span>
                          </div>
                          <ArrowRight size={13} className="text-slate-300 dark:text-slate-600 mx-auto flex-shrink-0" />
                          <input
                            value={wFormFields[fk] ?? ''}
                            onChange={e => setWFormFields(prev => ({ ...prev, [fk]: e.target.value }))}
                            placeholder="(excluded)"
                            className="input text-sm font-mono placeholder:font-sans placeholder:text-slate-300 dark:placeholder:text-slate-600"
                          />
                          <button type="button" onClick={() => setWFormFields(prev => { const n = { ...prev }; delete n[fk]; return n; })} className="text-slate-300 hover:text-red-400 transition-colors flex items-center justify-center">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Add form field */}
                  <div className="flex items-center gap-2 pt-1 border-t border-slate-100 dark:border-slate-800">
                    <input
                      type="text"
                      placeholder="Add a form field name (e.g. phone_number)"
                      value={wNewFormKey}
                      onChange={e => setWNewFormKey(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); const k = wNewFormKey.trim(); if (k) { setWFormFields(prev => ({ ...prev, [k]: k })); setWNewFormKey(''); } } }}
                      className="input text-sm font-mono placeholder:font-sans flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => { const k = wNewFormKey.trim(); if (k) { setWFormFields(prev => ({ ...prev, [k]: k })); setWNewFormKey(''); } }}
                      className="text-xs text-indigo-500 hover:text-indigo-400 font-medium flex items-center gap-1 flex-shrink-0 transition-colors"
                    >
                      <Plus size={12} /> Add
                    </button>
                  </div>
                </div>

                {/* System Fields section */}
                <div className="border-t border-slate-100 dark:border-slate-800 pt-4">
                  <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">System Fields</p>
                  <div className="space-y-2">
                    <div className="grid grid-cols-[1fr_24px_1fr] gap-2 text-xs font-medium text-slate-400 uppercase tracking-wider">
                      <span>SplitLab Field</span><span /><span>Webhook Key</span>
                    </div>
                    {SYSTEM_FIELDS.map(sf => (
                      <div key={sf.key} className="grid grid-cols-[1fr_24px_1fr] gap-2 items-center">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs px-2 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-mono border border-slate-200 dark:border-slate-700">{sf.label}</span>
                        </div>
                        <ArrowRight size={13} className="text-slate-300 dark:text-slate-600 mx-auto flex-shrink-0" />
                        <input
                          value={wSystemFields[sf.key] ?? ''}
                          onChange={e => setWSystemFields(prev => ({ ...prev, [sf.key]: e.target.value }))}
                          placeholder="(excluded)"
                          className="input text-sm font-mono placeholder:font-sans placeholder:text-slate-300 dark:placeholder:text-slate-600"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Send Test */}
            <div className="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-3 bg-slate-50 dark:bg-slate-800/40">
              <button
                type="button"
                onClick={testWebhook}
                disabled={wTesting || !wUrl.trim()}
                className="btn-secondary text-sm flex items-center gap-2 px-4 py-2 rounded-lg font-medium flex-shrink-0 disabled:opacity-50"
              >
                {wTesting ? <Loader2 size={14} className="animate-spin" /> : <ScanLine size={14} />}
                {wTesting ? 'Sending test…' : 'Send Test Payload'}
              </button>
              {wTestResult ? (
                <div className={`flex items-center gap-2 text-sm font-medium ${wTestResult.ok ? 'text-green-500' : 'text-red-400'}`}>
                  {wTestResult.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                  <span>
                    {wTestResult.ok
                      ? `${wTestResult.statusCode ?? 200} OK — Test payload delivered`
                      : (wTestResult.error ?? `Error ${wTestResult.statusCode ?? ''}`)}
                  </span>
                </div>
              ) : (
                <p className="text-xs text-slate-400">Send a sample payload to verify your endpoint is working before saving.</p>
              )}
            </div>

            {wError && (
              <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2.5 text-sm text-red-400">
                <XCircle size={14} className="flex-shrink-0" /> {wError}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-1 border-t border-slate-200 dark:border-slate-700">
              <button type="button" onClick={() => setWebhookModalOpen(false)} className="btn-secondary text-sm px-5 py-2">Cancel</button>
              <Button type="submit" loading={wSaving}>
                <Check size={14} /> Save Changes
              </Button>
            </div>
          </form>
        </Modal>

        {/* ─── SETTINGS TAB ─── */}
        {tab === "settings" && (
          <>
            {/* Global Tracking Snippet */}
            {(() => {
              const trackerComplete = !anyTrackerMissing && variants.some(v => getVerifiedStatus(v) === true);
              return (
                <div className={`card overflow-hidden ${trackerComplete ? 'border-green-500/30 bg-green-500/5' : ''}`}>
                  <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${trackerComplete ? 'bg-green-500/20' : 'bg-indigo-500/20'}`}>
                        {trackerComplete
                          ? <CheckCircle2 size={16} className="text-green-400" />
                          : <Code2 size={16} className="text-indigo-400" />
                        }
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-slate-800 dark:text-slate-200 text-sm">
                            Global Tracking Snippet
                          </p>
                          {trackerComplete && (
                            <span className="flex items-center gap-1 text-xs font-medium text-green-500">
                              <CheckCircle2 size={12} /> Complete
                            </span>
                          )}
                        </div>
                        {trackerComplete ? (
                          <p className="text-green-500/70 text-xs mt-0.5">Tracker detected on all variants</p>
                        ) : (
                          <div className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-300 mt-1">
                            <Info size={12} className="flex-shrink-0" />
                            <span>
                              Paste before{" "}
                              <code className="font-mono">&lt;/body&gt;</code> on your
                              external landing page (redirect mode only)
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  {!trackerComplete && (
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
                  )}
            </div>
              );
            })()}

            {/* Set Up Goal Conversion Tracking */}
            {anyTrackerMissing && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-3 text-sm text-amber-400">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                <span>Some variants are missing the tracker snippet — conversions may not be recorded for those variants until it is installed.</span>
              </div>
            )}
            <div className="card overflow-hidden ring-2 ring-indigo-400/60 border-indigo-400/50">
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 bg-indigo-500/10">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-indigo-500/30 flex items-center justify-center flex-shrink-0">
                    <ScanLine size={18} className="text-indigo-300" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-800 dark:text-slate-100 text-sm">
                      Set Up Goal Conversion Tracking
                    </p>
                    {scanning || scannedVariantName ? (
                      <p className="text-slate-500 text-xs mt-0.5">
                        {scanning
                          ? `Scanning ${scannedVariantName}…`
                          : `Last scanned: ${scannedVariantName}`}
                      </p>
                    ) : (
                      <p className="text-slate-400 text-xs mt-0.5">
                        Scan your page to detect buttons &amp; forms — then pick which ones count as a conversion.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="px-5 py-4">
                {!scanning && !scanResults && (
                  <div className="flex items-start gap-3 rounded-lg bg-indigo-500/15 border border-indigo-400/30 px-4 py-3">
                    <Info size={14} className="text-indigo-300 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-indigo-200">How to set up goals</p>
                      <p className="text-xs text-slate-300 mt-1">Go to the <span className="font-medium text-white">Overview tab</span>, find a variant row, and click <span className="font-medium text-white">&ldquo;Setup Goal Tracking&rdquo;</span> to scan that page for trackable elements. Once scanned, you can turn any button or form into a conversion goal right here.</p>
                    </div>
                  </div>
                )}

                {scanning && (
                  <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2.5 text-xs text-amber-300 font-medium">
                    <RefreshCw size={13} className="animate-spin flex-shrink-0" />
                    Page opened — waiting for scan results…
                  </div>
                )}

                {scanResults && (() => {
                  const activeId = scanTab ?? scanResults.variants[0]?.variant_id;
                  const activeVs = scanResults.variants.find(v => v.variant_id === activeId) ?? scanResults.variants[0];
                  return (
                    <div>
                      {/* Variant tabs */}
                      {scanResults.variants.length > 1 && (
                        <div className="mb-4">
                          <p className="text-xs text-slate-400 mb-2">Switch variants to set goals per page:</p>
                          <div className="flex gap-0 border-b border-slate-200 dark:border-slate-700 -mx-5 px-5 overflow-x-auto">
                            {scanResults.variants.map((vs) => (
                              <button
                                key={vs.variant_id}
                                type="button"
                                onClick={() => setScanTab(vs.variant_id)}
                                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                                  vs.variant_id === activeId
                                    ? "border-indigo-500 text-indigo-400"
                                    : "border-transparent text-slate-500 hover:text-slate-300"
                                }`}
                              >
                                {vs.variant_name}
                                <span className={`text-xs ${vs.variant_id === activeId ? "text-indigo-400/60" : "text-slate-600"}`}>
                                  {vs.elements.length}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Active variant content */}
                      {activeVs && (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-slate-500">
                              {activeVs.elements.length} element{activeVs.elements.length !== 1 ? "s" : ""}
                            </span>
                            <span className="text-slate-500 text-xs">
                              {new Date(activeVs.scanned_at).toLocaleString()}
                            </span>
                          </div>
                          {activeVs.elements.length === 0 ? (
                            <p className="text-slate-400 text-xs px-3 py-2">
                              No trackable elements found.
                            </p>
                          ) : (
                            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                              {activeVs.elements.map((el, i) => {
                                const icon =
                                  el.type === "form" ? (
                                    <FormInput size={13} className="text-purple-400 flex-shrink-0" />
                                  ) : el.type === "call" ? (
                                    <Phone size={13} className="text-green-400 flex-shrink-0" />
                                  ) : el.type === "link" ? (
                                    <ExternalLink size={13} className="text-blue-400 flex-shrink-0" />
                                  ) : el.type === "toggle" ? (
                                    <ToggleLeft size={13} className="text-amber-400 flex-shrink-0" />
                                  ) : (
                                    <MousePointerClick size={13} className="text-indigo-400 flex-shrink-0" />
                                  );

                                const label = el.text
                                  ? `"${el.text}"`
                                  : el.id
                                    ? `#${el.id}`
                                    : el.type;

                                const alreadyAdded = editGoals.some((g) => {
                                  if (g.variant_id !== activeId) return false;
                                  if (el.id) return g.selector === `id:${el.id}`;
                                  if (el.text) return g.selector === `text:${el.text}`;
                                  return false;
                                });

                                return (
                                  <div
                                    key={i}
                                    className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg border transition-colors ${
                                      alreadyAdded
                                        ? "bg-green-500/10 border-green-500/30"
                                        : "bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700"
                                    }`}
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      {alreadyAdded
                                        ? <CheckCircle2 size={13} className="text-green-400 flex-shrink-0" />
                                        : icon}
                                      <span className={`text-sm truncate ${alreadyAdded ? "text-green-300 font-medium" : "text-slate-700 dark:text-slate-300"}`}>
                                        {label}
                                      </span>
                                      {el.id && (
                                        <span className="text-slate-400 font-mono text-xs flex-shrink-0">
                                          #{el.id}
                                        </span>
                                      )}
                                      {alreadyAdded ? (
                                        <span className="text-xs bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded font-medium flex-shrink-0">Goal</span>
                                      ) : (
                                        <span className="text-slate-400 text-xs flex-shrink-0 capitalize">
                                          {el.type.replace("_", " ")}
                                        </span>
                                      )}
                                    </div>
                                    {alreadyAdded ? (
                                      <button
                                        type="button"
                                        onClick={() => removeGoalBySelector(el, activeId)}
                                        className="flex-shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                                      >
                                        <X size={11} /> Remove
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => enableAsGoal(el, activeId)}
                                        className="flex-shrink-0 text-xs px-2.5 py-1 rounded-lg border border-indigo-400/60 text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/30 font-medium transition-colors"
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
                      )}
                    </div>
                  );
                })()}
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

            {/* Head Scripts (for proxy / custom HTML mode) */}
            <div
              className={`card overflow-hidden ${allPureRedirect ? "opacity-60" : ""}`}
            >
              <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700">
                <h3 className="font-medium text-slate-800 dark:text-slate-200">
                  Page-Specific Head Scripts
                </h3>
                <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2.5 text-xs text-amber-600 dark:text-amber-300 mt-2">
                  <Info size={13} className="mt-0.5 flex-shrink-0" />
                  <span>
                    Injected into the <code className="font-mono">&lt;head&gt;</code> of this test&apos;s HTML pages only — not hosted URLs (Lovable,
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
        onClose={() => { setAddVariantOpen(false); setAddVariantError(null); setNewVariantUrlFrameable(null); setCheckingFrameable(false); }}
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
              <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 text-xs text-amber-600 dark:text-amber-400 mt-2">
                <Info size={13} className="flex-shrink-0 mt-px" />
                <span>Tracking is already built in for this page — <strong>no need to add a <code className="font-mono">tracker.js</code> script tag.</strong></span>
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

      <ConfirmDialog
        open={!!urlChangeConfirmId}
        onClose={() => setUrlChangeConfirmId(null)}
        onConfirm={() => {
          const id = urlChangeConfirmId!;
          setUrlChangeConfirmId(null);
          saveVariant(id, true);
        }}
        title="Change Variant URL?"
        description="Changing the destination URL will clear all scanned elements for this variant. You'll need to re-scan the new page to set up goals and form tracking."
        loading={savingVariant}
      />

      {/* Email Notifications Config Modal */}
      <Modal
        open={emailModalOpen}
        onClose={() => !savingEmail && setEmailModalOpen(false)}
        title={emailIntegration ? 'Edit Email Notifications' : 'Enable Email Notifications'}
        size="sm"
      >
        <form onSubmit={submitEmailModal} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Notification Recipients
            </label>
            <input
              type="text"
              value={emailModalRecipients}
              onChange={e => { setEmailModalRecipients(e.target.value); setEmailModalError(''); }}
              placeholder="alice@agency.com, bob@agency.com"
              className="input-base text-sm w-full"
              autoFocus
              disabled={savingEmail}
            />
            <p className="text-xs text-slate-400 mt-1.5">
              Comma-separated. Every person listed receives a notification on each form submission.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Subject Line
            </label>
            <input
              type="text"
              value={emailModalSubject}
              onChange={e => setEmailModalSubject(e.target.value)}
              placeholder="New lead: {{test}} - {{variant}}"
              className="input-base text-sm w-full"
              disabled={savingEmail}
            />
            <p className="text-xs text-slate-400 mt-1.5">
              Use{' '}
              <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded font-mono text-xs">{'{{test}}'}</code>{' '}
              and{' '}
              <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded font-mono text-xs">{'{{variant}}'}</code>{' '}
              as dynamic placeholders.
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-indigo-500/8 border border-indigo-500/20 px-3 py-2.5 text-xs text-indigo-400">
            <Info size={13} className="flex-shrink-0 mt-0.5" />
            <span>
              The email body includes all captured form fields, variant name, submission time, and UTM data automatically.
              One config applies to all variants of this test — the variant name appears inside each email.
            </span>
          </div>

          {emailModalError && (
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-400">
              <AlertTriangle size={13} className="flex-shrink-0" /> {emailModalError}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-1">
            <Button variant="secondary" type="button" onClick={() => setEmailModalOpen(false)} disabled={savingEmail}>
              Cancel
            </Button>
            <Button type="submit" loading={savingEmail}>
              <Check size={13} /> {emailIntegration ? 'Save Changes' : 'Enable Notifications'}
            </Button>
          </div>
        </form>
      </Modal>

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
              <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 text-xs text-amber-600 dark:text-amber-400 m-4 mb-0">
                <Info size={13} className="flex-shrink-0 mt-px" />
                <span>Tracking is already built in for this page — <strong>no need to add a <code className="font-mono">tracker.js</code> script tag.</strong></span>
              </div>
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
                Close
              </button>
              <Button size="sm" onClick={saveHtml} loading={savingHtml}>
                <Check size={13} /> Save and Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
