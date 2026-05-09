"use client";
import { useEffect, useRef, useState, useCallback } from 'react';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/components/auth-provider';

type ActivityEntry = {
  ts: number;
  userKey: string;
  model: string;
  geminiModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  retries?: number;
  status: 'success' | 'error' | 'streaming';
  streaming?: boolean;
  fallback?: boolean;
  toolsUsed?: number;
};

function tsLocal(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function compact(n: number) { return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, n || 0)); }

export default function ActivityPage() {
  const { toast, ToastContainer } = useToast();
  const { isAuthenticated } = useAuth();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Auto-refresh
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchActivity = useCallback(async () => {
    const params = new URLSearchParams({ limit: '200' });
    if (filterModel) params.set('model', filterModel);
    if (filterStatus) params.set('status', filterStatus);
    if (search) params.set('key', search);
    const res = await fetch(`/api/admin/activity?${params}`, { cache: 'no-store' });
    if (res.ok) setEntries((await res.json()).entries || []);
  }, [filterModel, filterStatus, search]);

  useEffect(() => {
    if (isAuthenticated === null) return;
    if (!isAuthenticated) { setLoading(false); return; }
    (async () => {
      await fetchActivity();
      setLoading(false);
    })();
  }, [fetchActivity, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchActivity();
  }, [fetchActivity, isAuthenticated]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchActivity, 30000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, fetchActivity]);

  const clearLog = async () => {
    if (!confirm('Clear all activity log entries?')) return;
    const res = await fetch('/api/admin/activity', { method: 'DELETE' });
    if (!res.ok) { toast.err('Failed to clear log'); return; }
    toast.ok('Activity log cleared.');
    setEntries([]);
  };

  // Collect unique model names for filter
  const models = Array.from(new Set(entries.map((e) => e.model).filter(Boolean)));

  if (loading) {
    return (
      <div className="dashboard-page">
        <div className="sk sk-card" style={{ height: 400 }} />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="panel" style={{ maxWidth: 440, margin: '60px auto', textAlign: 'center', padding: 32 }}>
        <h2 className="section-title" style={{ marginBottom: 8 }}>Authentication Required</h2>
        <p className="muted-text">Sign in from the sidebar to view the activity feed.</p>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <ToastContainer />
      <header className="page-header">
        <div>
          <h1 className="page-title">Activity Feed</h1>
          <p className="muted-text">Per-request log — last 200 entries, newest first.</p>
        </div>
        <div className="toolbar-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh (30s)
          </label>
          <button className="btn" onClick={fetchActivity}>↺ Refresh</button>
          <button className="btn btn-warn" onClick={clearLog}>Clear Log</button>
        </div>
      </header>

      {/* Filters */}
      <section className="panel">
        <div className="filter-row">
          <input
            className="search-input"
            placeholder="Search by masked key…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="select-filter" value={filterModel} onChange={(e) => setFilterModel(e.target.value)}>
            <option value="">All models</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select className="select-filter" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
            <option value="streaming">Streaming</option>
          </select>
        </div>
      </section>

      {/* Table */}
      <section className="panel" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="data-table" style={{ minWidth: 900 }}>
          <thead>
            <tr>
              <th style={{ width: 90 }}>Time</th>
              <th>Key</th>
              <th>Model</th>
              <th>Gemini Model</th>
              <th style={{ width: 80 }}>In</th>
              <th style={{ width: 80 }}>Out</th>
              <th style={{ width: 80 }}>Latency</th>
              <th style={{ width: 70 }}>Status</th>
              <th style={{ width: 130 }}>Flags</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr><td colSpan={9} style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 24 }}>No activity yet. Requests will appear here after they complete.</td></tr>
            )}
            {entries.map((e, i) => (
              <tr key={i} className={e.status === 'error' ? 'row-error' : 'row-success'}>
                <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{tsLocal(e.ts)}</td>
                <td><code className="key-mask">{e.userKey}</code></td>
                <td style={{ fontSize: 12 }}><code>{e.model}</code></td>
                <td style={{ fontSize: 11, color: 'var(--text-muted)' }}><code>{e.geminiModel || '—'}</code></td>
                <td style={{ fontSize: 12 }}>{e.inputTokens != null ? compact(e.inputTokens) : '—'}</td>
                <td style={{ fontSize: 12 }}>{e.outputTokens != null ? compact(e.outputTokens) : '—'}</td>
                <td style={{ fontSize: 12 }}>{e.latencyMs != null ? `${e.latencyMs}ms` : '—'}</td>
                <td>
                  <span className={`pill pill-${e.status}`}>{e.status}</span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {e.streaming && <span className="pill pill-streaming">stream</span>}
                    {e.fallback && <span className="pill pill-warn">fallback</span>}
                    {(e.retries ?? 0) > 0 && <span className="pill pill-rate-limited">{e.retries}×</span>}
                    {(e.toolsUsed ?? 0) > 0 && <span className="pill" style={{ background: '#1a1a3a', color: '#b8c0f0', borderColor: '#3a3a70' }}>🔧{e.toolsUsed}</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
