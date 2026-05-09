'use client';

import { useState, useEffect, useCallback } from 'react';
import { Zap, Plus, Trash2, Send, Copy, Check, ChevronDown, ChevronRight, Eye, EyeOff, ToggleLeft, ToggleRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import toast from 'react-hot-toast';

interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  events: string[];
  secret: string;
  is_active: boolean;
  created_at: string;
  delivery_count: number;
  last_delivery: string | null;
  last_status: number | null;
}

interface Delivery {
  id: string;
  event_type: string;
  response_status: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

const EVENT_OPTIONS = [
  { value: 'conversion', label: 'Conversion', description: 'Fires when a visitor completes a goal' },
  { value: 'test_status_changed', label: 'Test Status Changed', description: 'Fires when a test starts, pauses, or completes' },
];

function StatusBadge({ status }: { status: number | null }) {
  if (status === null) return <span className="text-xs text-slate-400">—</span>;
  const ok = status >= 200 && status < 300;
  return (
    <span className={cn('text-xs font-mono font-semibold px-1.5 py-0.5 rounded', ok ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' : 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400')}>
      {status}
    </span>
  );
}

function SecretField({ secret }: { secret: string }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  function copySecret() {
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="flex items-center gap-2 font-mono text-xs bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
      <span className="flex-1 text-slate-700 dark:text-slate-300 truncate">
        {visible ? secret : '••••••••••••••••••••••••••••••••••••••••••••••••'}
      </span>
      <button onClick={() => setVisible(!visible)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
        {visible ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
      <button onClick={copySecret} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
        {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function EndpointRow({
  endpoint,
  workspaceId,
  onDelete,
  onToggle,
}: {
  endpoint: WebhookEndpoint;
  workspaceId: string;
  onDelete: (id: string) => void;
  onToggle: (id: string, active: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; status: number | null; error: string | null } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);

  async function loadDeliveries() {
    if (loadingDeliveries) return;
    setLoadingDeliveries(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/webhooks/${endpoint.id}/deliveries`);
      if (res.ok) setDeliveries(await res.json());
    } finally {
      setLoadingDeliveries(false);
    }
  }

  function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && deliveries.length === 0) loadDeliveries();
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/webhooks/${endpoint.id}/test`, { method: 'POST' });
      const data = await res.json();
      setTestResult({ ok: data.ok, status: data.response_status, error: data.error });
      if (data.ok) {
        toast.success('Test delivery succeeded!');
      } else {
        toast.error(data.error || `Server returned ${data.response_status}`);
      }
      // Reload deliveries
      await loadDeliveries();
    } catch {
      toast.error('Test failed — could not reach the server');
    } finally {
      setTesting(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete webhook "${endpoint.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/webhooks/${endpoint.id}`, { method: 'DELETE' });
      if (res.ok) {
        onDelete(endpoint.id);
        toast.success('Webhook deleted');
      } else {
        toast.error('Failed to delete webhook');
      }
    } finally {
      setDeleting(false);
    }
  }

  async function handleToggle() {
    setToggling(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/webhooks/${endpoint.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !endpoint.is_active }),
      });
      if (res.ok) {
        onToggle(endpoint.id, !endpoint.is_active);
        toast.success(endpoint.is_active ? 'Webhook paused' : 'Webhook enabled');
      }
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-4 px-4 py-3 bg-white dark:bg-slate-800">
        <button onClick={toggleExpand} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <p className="font-semibold text-slate-900 dark:text-slate-100 text-sm truncate">{endpoint.name}</p>
            {!endpoint.is_active && (
              <span className="text-xs bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400 px-1.5 py-0.5 rounded font-medium">Paused</span>
            )}
          </div>
          <p className="text-xs text-slate-400 dark:text-slate-500 font-mono truncate">{endpoint.url}</p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Last delivery status */}
          <div className="text-right hidden sm:block">
            <p className="text-xs text-slate-400">{endpoint.delivery_count} deliveries</p>
            {endpoint.last_delivery && (
              <div className="flex items-center gap-1 justify-end mt-0.5">
                <StatusBadge status={endpoint.last_status} />
              </div>
            )}
          </div>

          {/* Events badges */}
          <div className="hidden md:flex gap-1">
            {endpoint.events.map((e) => (
              <span key={e} className="text-xs bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-400 px-2 py-0.5 rounded-full font-medium">
                {e}
              </span>
            ))}
          </div>

          {/* Toggle */}
          <button
            onClick={handleToggle}
            disabled={toggling}
            className="text-slate-400 hover:text-indigo-500 transition-colors disabled:opacity-50"
            title={endpoint.is_active ? 'Pause webhook' : 'Enable webhook'}
          >
            {endpoint.is_active ? <ToggleRight size={20} className="text-indigo-500" /> : <ToggleLeft size={20} />}
          </button>

          {/* Test */}
          <button
            onClick={sendTest}
            disabled={testing}
            className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50"
          >
            <Send size={11} />
            {testing ? 'Sending…' : 'Test'}
          </button>

          {/* Delete */}
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="text-slate-300 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 transition-colors disabled:opacity-50"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 px-4 py-4 space-y-4">
          {/* Secret */}
          <div>
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Signing Secret</p>
            <SecretField secret={endpoint.secret} />
            <p className="text-xs text-slate-400 mt-1.5">
              Verify incoming requests using <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">X-SplitLab-Signature</code>: HMAC-SHA256 of <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">timestamp.body</code>
            </p>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={cn('rounded-lg p-3 text-sm', testResult.ok ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400')}>
              {testResult.ok ? `✓ Delivered — HTTP ${testResult.status}` : `✗ Failed — ${testResult.error || `HTTP ${testResult.status}`}`}
            </div>
          )}

          {/* Delivery log */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Recent Deliveries</p>
              <button onClick={loadDeliveries} className="text-xs text-indigo-500 hover:underline">Refresh</button>
            </div>
            {loadingDeliveries ? (
              <p className="text-xs text-slate-400 py-2">Loading…</p>
            ) : deliveries.length === 0 ? (
              <p className="text-xs text-slate-400 py-2">No deliveries yet. Click "Test" to send a sample payload.</p>
            ) : (
              <div className="space-y-1">
                {deliveries.map((d) => (
                  <div key={d.id} className="flex items-center gap-3 text-xs py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
                    <StatusBadge status={d.response_status} />
                    <span className="text-indigo-500 font-medium">{d.event_type}</span>
                    <span className="text-slate-400 flex-1 truncate">{d.error || 'OK'}</span>
                    {d.duration_ms !== null && <span className="text-slate-400">{d.duration_ms}ms</span>}
                    <span className="text-slate-400 flex-shrink-0">
                      {new Date(d.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AddWebhookModal({
  workspaceId,
  onAdd,
  onClose,
}: {
  workspaceId: string;
  onAdd: (ep: WebhookEndpoint) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['conversion']);
  const [saving, setSaving] = useState(false);

  function toggleEvent(val: string) {
    setEvents((prev) => prev.includes(val) ? prev.filter((e) => e !== val) : [...prev, val]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !url.trim() || events.length === 0) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), url: url.trim(), events }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error?.[0]?.message || 'Failed to create webhook');
        return;
      }
      const ep = await res.json();
      onAdd(ep);
      toast.success('Webhook created');
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-5">Add Webhook</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-base"
              placeholder="Zapier Integration"
              required
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Endpoint URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="input-base font-mono text-sm"
              placeholder="https://hooks.zapier.com/hooks/catch/..."
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Events to send</label>
            <div className="space-y-2">
              {EVENT_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer hover:border-indigo-400 transition-colors">
                  <input
                    type="checkbox"
                    checked={events.includes(opt.value)}
                    onChange={() => toggleEvent(opt.value)}
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{opt.label}</p>
                    <p className="text-xs text-slate-400 dark:text-slate-500">{opt.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" disabled={saving || events.length === 0} className="btn-primary text-sm">
              {saving ? 'Creating…' : 'Create Webhook'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function WebhooksClient({ workspaceId, clientId }: { workspaceId: string; clientId: string }) {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/webhooks`);
      if (res.ok) setEndpoints(await res.json());
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  function handleAdd(ep: WebhookEndpoint) {
    setEndpoints((prev) => [ep, ...prev]);
  }

  function handleDelete(id: string) {
    setEndpoints((prev) => prev.filter((e) => e.id !== id));
  }

  function handleToggle(id: string, active: boolean) {
    setEndpoints((prev) => prev.map((e) => e.id === id ? { ...e, is_active: active } : e));
  }

  return (
    <div className="p-6 max-w-4xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Zap size={18} className="text-indigo-500" />
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Webhooks</h2>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Push real-time conversion data to Zapier, Make, HubSpot, Slack, or any HTTPS endpoint.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="btn-primary text-sm flex items-center gap-2 flex-shrink-0"
        >
          <Plus size={15} />
          Add Webhook
        </button>
      </div>

      {/* Docs callout */}
      <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-xl p-4 mb-6 text-sm text-indigo-700 dark:text-indigo-300">
        <strong>Payload format:</strong> Every event sends a JSON POST with headers{' '}
        <code className="bg-indigo-100 dark:bg-indigo-900/40 px-1 rounded text-xs">X-SplitLab-Event</code>,{' '}
        <code className="bg-indigo-100 dark:bg-indigo-900/40 px-1 rounded text-xs">X-SplitLab-Signature</code>, and{' '}
        <code className="bg-indigo-100 dark:bg-indigo-900/40 px-1 rounded text-xs">X-SplitLab-Delivery</code>.
        Your endpoint must return a 2xx status within 10 seconds.
      </div>

      {/* Endpoint list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : endpoints.length === 0 ? (
        <div className="text-center py-16 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl">
          <div className="w-12 h-12 rounded-2xl bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center mx-auto mb-4">
            <Zap size={22} className="text-indigo-500" />
          </div>
          <h3 className="font-semibold text-slate-900 dark:text-slate-100 mb-1">No webhooks yet</h3>
          <p className="text-sm text-slate-400 mb-5">Connect this workspace to Zapier, Make, or any HTTPS service.</p>
          <button onClick={() => setShowAdd(true)} className="btn-primary text-sm inline-flex items-center gap-2">
            <Plus size={14} />
            Add your first webhook
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {endpoints.map((ep) => (
            <EndpointRow
              key={ep.id}
              endpoint={ep}
              workspaceId={workspaceId}
              onDelete={handleDelete}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <AddWebhookModal
          workspaceId={workspaceId}
          onAdd={handleAdd}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}
