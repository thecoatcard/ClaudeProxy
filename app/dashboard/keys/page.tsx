"use client";
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useToast } from '@/components/ui/toast';

type ProviderKey = {
  id: string;
  key?: string;
  status: 'healthy' | 'cooldown' | 'revoked' | 'disabled';
  failure_count?: number;
  last_used?: number;
  daily_used?: number;
  score?: number;
};

type ValidateResult = {
  key: string;
  valid: boolean;
  latencyMs?: number;
  error?: string;
};

function fmt(n: number) { return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(n || 0))); }
function tsAgo(ts?: number): string {
  if (!ts || ts <= 0) return '-';
  const secs = Math.floor(Date.now() / 1000) - Number(ts);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(Number(ts) * 1000).toLocaleDateString();
}

export default function KeysPage() {
  const { toast, ToastContainer } = useToast();
  const [auth, setAuth] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [tab, setTab] = useState<'pool' | 'add'>('pool');

  // Pool tab state
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  // Single add
  const [newKey, setNewKey] = useState('');

  // Bulk add tab
  const [bulkText, setBulkText] = useState('');
  const [validating, setValidating] = useState(false);
  const [validateResults, setValidateResults] = useState<ValidateResult[]>([]);
  const [adding, setAdding] = useState(false);

  const fetchKeys = useCallback(async () => {
    const res = await fetch('/api/admin/keys', { cache: 'no-store' });
    if (res.ok) setKeys((await res.json()).keys || []);
  }, []);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/auth/me');
      if (!res.ok) { setAuth(false); setLoading(false); return; }
      setAuth(true);
      await fetchKeys();
      setLoading(false);
    })();
  }, [fetchKeys]);

  const busy = (id: string, on: boolean) => setBusyIds((s) => {
    const n = new Set(s); on ? n.add(id) : n.delete(id); return n;
  });

  /* ── Pool actions ── */
  const addSingle = async () => {
    const k = newKey.trim();
    if (!k) return;
    const res = await fetch('/api/admin/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k }) });
    if (!res.ok) { toast.err('Failed to add key'); return; }
    toast.ok('Key added.');
    setNewKey('');
    await fetchKeys();
  };

  const deleteKey = async (id: string) => {
    if (!confirm('Delete this provider key?')) return;
    await fetch(`/api/admin/keys?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast.ok('Key deleted.');
    await fetchKeys();
  };

  const toggleKey = async (id: string) => {
    busy(id, true);
    const res = await fetch(`/api/admin/keys?action=toggle&id=${encodeURIComponent(id)}`, { method: 'PATCH' });
    busy(id, false);
    if (!res.ok) { toast.err('Toggle failed'); return; }
    toast.ok('Status toggled.');
    await fetchKeys();
  };

  const reactivateKey = async (id: string) => {
    busy(id, true);
    const res = await fetch(`/api/admin/keys?action=reactivate&id=${encodeURIComponent(id)}`, { method: 'PATCH' });
    busy(id, false);
    if (!res.ok) { toast.err('Reactivate failed'); return; }
    toast.ok('Key reactivated.');
    await fetchKeys();
  };

  const activateAll = async () => {
    const res = await fetch('/api/admin/keys?action=activate-all', { method: 'PATCH' });
    if (!res.ok) { toast.err('Failed'); return; }
    const d = await res.json();
    toast.ok(`Activated ${d.activated ?? 0} keys.`);
    await fetchKeys();
  };

  /* ── Bulk validate ── */
  const bulkKeys = useMemo(() => bulkText.split('\n').map((s) => s.trim()).filter(Boolean), [bulkText]);

  const runValidate = async () => {
    if (bulkKeys.length === 0) { toast.warn('Paste at least one key.'); return; }
    if (bulkKeys.length > 20) { toast.warn('Max 20 keys at a time.'); return; }
    setValidating(true);
    setValidateResults([]);
    const res = await fetch('/api/admin/keys/validate', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: bulkKeys }),
    });
    setValidating(false);
    if (!res.ok) { toast.err('Validation request failed'); return; }
    setValidateResults((await res.json()).results || []);
  };

  const addValidKeys = async () => {
    const valid = validateResults.filter((r) => r.valid).map((r) => r.key);
    if (valid.length === 0) { toast.warn('No valid keys to add.'); return; }
    setAdding(true);
    let added = 0;
    for (const k of valid) {
      const res = await fetch('/api/admin/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k }) });
      if (res.ok) added++;
    }
    setAdding(false);
    toast.ok(`Added ${added}/${valid.length} valid keys.`);
    setBulkText('');
    setValidateResults([]);
    setTab('pool');
    await fetchKeys();
  };

  /* ── Filtered view ── */
  const filteredKeys = useMemo(() => keys.filter((k) => {
    const s = search.toLowerCase();
    const matchSearch = !s || k.id.toLowerCase().includes(s);
    const matchStatus = !filterStatus || k.status === filterStatus;
    return matchSearch && matchStatus;
  }), [keys, search, filterStatus]);

  const health = useMemo(() => ({
    healthy: keys.filter((k) => k.status === 'healthy').length,
    cooldown: keys.filter((k) => k.status === 'cooldown').length,
    revoked: keys.filter((k) => k.status === 'revoked').length,
    disabled: keys.filter((k) => k.status === 'disabled').length,
  }), [keys]);

  /* ── Render ── */
  if (loading) {
    return (
      <div className="dashboard-page">
        <div className="kpi-grid">{[1,2,3,4].map((i) => <div key={i} className="sk sk-card" />)}</div>
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="panel" style={{ maxWidth: 440, margin: '60px auto', textAlign: 'center', padding: 32 }}>
        <h2 className="section-title" style={{ marginBottom: 8 }}>Authentication Required</h2>
        <p className="muted-text">Sign in from the sidebar to manage provider keys.</p>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <ToastContainer />
      <header className="page-header">
        <div>
          <h1 className="page-title">Provider Keys</h1>
          <p className="muted-text">Gemini API key pool — {keys.length} total</p>
        </div>
        <div className="toolbar-row">
          <button className="btn" onClick={fetchKeys}>↺ Refresh</button>
          <button className="btn btn-ok" onClick={activateAll}>Activate All</button>
        </div>
      </header>

      {/* Health KPIs */}
      <section className="kpi-grid kpi-grid-4">
        <article className={`kpi-card ${health.healthy > 0 ? 'kpi-card-ok' : 'kpi-card-bad'}`}>
          <p className="kpi-label">Healthy</p>
          <p className="kpi-value">{fmt(health.healthy)}</p>
        </article>
        <article className={`kpi-card ${health.cooldown > 0 ? 'kpi-card-warn' : ''}`}>
          <p className="kpi-label">Cooldown</p>
          <p className="kpi-value">{fmt(health.cooldown)}</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Disabled</p>
          <p className="kpi-value">{fmt(health.disabled)}</p>
        </article>
        <article className={`kpi-card ${health.revoked > 0 ? 'kpi-card-bad' : ''}`}>
          <p className="kpi-label">Revoked</p>
          <p className="kpi-value">{fmt(health.revoked)}</p>
        </article>
      </section>

      {/* Quick add single key */}
      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">Quick Add</h2>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            type="text"
            placeholder="Paste a single Gemini API key…"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSingle()}
            style={{ flex: 1 }}
          />
          <button className="btn btn-primary" onClick={addSingle}>Add Key</button>
        </div>
      </section>

      {/* Tabs */}
      <div className="tab-bar" style={{ marginBottom: 0 }}>
        <button className={`tab${tab === 'pool' ? ' active' : ''}`} onClick={() => setTab('pool')}>Pool ({keys.length})</button>
        <button className={`tab${tab === 'add' ? ' active' : ''}`} onClick={() => setTab('add')}>Bulk Add / Validate</button>
      </div>

      {/* Pool tab */}
      {tab === 'pool' && (
        <section className="panel">
          <div className="filter-row">
            <input
              className="search-input"
              placeholder="Search by key ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select className="select-filter" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="healthy">Healthy</option>
              <option value="cooldown">Cooldown</option>
              <option value="disabled">Disabled</option>
              <option value="revoked">Revoked</option>
            </select>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Key ID</th>
                <th className="col-status">Status</th>
                <th className="col-num">Failures</th>
                <th className="col-num">Daily Used</th>
                <th className="col-date">Last Used</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredKeys.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--text-muted)' }}>No keys match the filter.</td></tr>}
              {filteredKeys.map((k) => (
                <tr key={k.id}>
                  <td><code className="key-mask">{k.id}</code></td>
                  <td><span className={`pill pill-${k.status}`}>{k.status}</span></td>
                  <td>{fmt(Number(k.failure_count || 0))}</td>
                  <td>{fmt(Number(k.daily_used || 0))}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{tsAgo(Number(k.last_used || 0))}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        className={`btn btn-xs ${k.status === 'disabled' ? 'btn-ok' : 'btn-warn'}`}
                        onClick={() => toggleKey(k.id)}
                        disabled={busyIds.has(k.id)}
                      >
                        {k.status === 'disabled' ? 'Enable' : 'Disable'}
                      </button>
                      {(k.status === 'cooldown' || k.status === 'disabled') && (
                        <button className="btn btn-xs" onClick={() => reactivateKey(k.id)} disabled={busyIds.has(k.id)}>
                          Reset
                        </button>
                      )}
                      <button className="btn btn-xs btn-danger" onClick={() => deleteKey(k.id)} disabled={busyIds.has(k.id)}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Bulk add tab */}
      {tab === 'add' && (
        <section className="panel">
          <div className="panel-header">
            <h2 className="section-title">Bulk Add &amp; Validate</h2>
            <span className="muted-text" style={{ fontSize: 12 }}>One key per line · max 20 per validation run</span>
          </div>
          <textarea
            className="textarea"
            rows={8}
            placeholder={"AIzaSy... \nAIzaSy... \n(one key per line)"}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <div className="toolbar-row" style={{ marginTop: 8 }}>
            <span className="muted-text" style={{ fontSize: 12 }}>{bulkKeys.length} key{bulkKeys.length !== 1 ? 's' : ''} detected</span>
            <button className="btn btn-primary" onClick={runValidate} disabled={validating || bulkKeys.length === 0}>
              {validating ? 'Validating…' : 'Validate All'}
            </button>
            {validateResults.some((r) => r.valid) && (
              <button className="btn btn-ok" onClick={addValidKeys} disabled={adding}>
                {adding ? 'Adding…' : `Add ${validateResults.filter((r) => r.valid).length} Valid Keys`}
              </button>
            )}
          </div>

          {validateResults.length > 0 && (
            <div className="validation-list" style={{ marginTop: 16 }}>
              {validateResults.map((r, i) => (
                <div key={i} className="validate-row">
                  <span className={`pill ${r.valid ? 'pill-success' : r.error?.includes('rate') ? 'pill-rate-limited' : 'pill-invalid'}`}>
                    {r.valid ? '✓' : '✗'}
                  </span>
                  <code className="key-mask" style={{ flex: 1 }}>{r.key.slice(0, 30)}…</code>
                  {r.latencyMs && <span className="muted-text">{r.latencyMs}ms</span>}
                  {r.error && <span style={{ color: 'var(--bad)', fontSize: 11 }}>{r.error}</span>}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
