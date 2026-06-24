"use client";
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/components/auth-provider';

type GatewayKey = {
  token: string;
  name?: string;
  status?: 'active' | 'disabled' | 'revoked';
  usage_count?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  max_usage?: number;
  rpm_limit?: number;
  notes?: string;
  expires_at?: string;
  created_at?: number;
  last_used?: number;
};

function fmt(n: number) { return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(n || 0))); }
function compact(n: number) { return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, n || 0)); }
function tsAgo(ts?: number): string {
  if (!ts || ts <= 0) return '-';
  const secs = Math.floor(Date.now() / 1000) - Number(ts);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(Number(ts) * 1000).toLocaleDateString();
}

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (token: string) => void }) {
  const [name, setName] = useState('');
  const [rpmLimit, setRpmLimit] = useState('');
  const [maxUsage, setMaxUsage] = useState('');
  const [notes, setNotes] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [newToken, setNewToken] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const body: Record<string, string | number> = { name: name.trim() || 'Gateway Key' };
    if (rpmLimit) body.rpm_limit = Number(rpmLimit);
    if (maxUsage) body.max_usage = Number(maxUsage);
    if (notes.trim()) body.notes = notes.trim();
    if (expiresAt) body.expires_at = expiresAt;
    const res = await fetch('/api/admin/user-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) { setErr('Failed to create key.'); return; }
    const d = await res.json();
    setNewToken(d.userKey?.token || d.token || '');
    onCreated(d.userKey?.token || d.token || '');
  };

  if (newToken) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-box" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2 className="section-title">Key Created</h2>
            <button className="modal-close" onClick={onClose}>✕</button>
          </div>
          <div className="alert alert-ok" style={{ marginBottom: 12 }}>Copy this token — it will not be shown again.</div>
          <code className="key-mask" style={{ wordBreak: 'break-all', display: 'block', padding: '10px', background: '#0a0e16', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {newToken}
          </code>
          <button className="btn btn-primary" onClick={() => { navigator.clipboard.writeText(newToken); }}>Copy Token</button>
          <button className="btn" style={{ marginLeft: 8 }} onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="section-title">Issue Gateway Key</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        {err && <div className="alert alert-bad" style={{ marginBottom: 12 }}>{err}</div>}
        <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
          <input className="input" type="text" placeholder="Name / Owner / Team" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" type="number" placeholder="RPM limit (0 = unlimited)" min={0} value={rpmLimit} onChange={(e) => setRpmLimit(e.target.value)} />
          <input className="input" type="number" placeholder="Max token usage (0 = unlimited)" min={0} value={maxUsage} onChange={(e) => setMaxUsage(e.target.value)} />
          <input className="input" type="date" placeholder="Expires at" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          <textarea className="textarea" rows={2} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" type="submit" disabled={busy} style={{ flex: 1 }}>{busy ? 'Creating…' : 'Create Key'}</button>
            <button className="btn" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function UserKeysPage() {
  const { toast, ToastContainer } = useToast();
  const { isAuthenticated } = useAuth();
  const [keys, setKeys] = useState<GatewayKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [busyTokens, setBusyTokens] = useState<Set<string>>(new Set());

  const fetchKeys = useCallback(async () => {
    const res = await fetch('/api/admin/user-keys', { cache: 'no-store' });
    if (res.ok) setKeys((await res.json()).userKeys || []);
  }, []);

  useEffect(() => {
    if (isAuthenticated === null) return;
    if (!isAuthenticated) { setLoading(false); return; }
    (async () => {
      await fetchKeys();
      setLoading(false);
    })();
  }, [fetchKeys, isAuthenticated]);

  const busy = (t: string, on: boolean) => setBusyTokens((s) => { const n = new Set(s); on ? n.add(t) : n.delete(t); return n; });

  const revokeKey = async (token: string) => {
    if (!confirm('Revoke this key? It will stop working immediately.')) return;
    await fetch(`/api/admin/user-keys?id=${encodeURIComponent(token)}`, { method: 'DELETE' });
    toast.ok('Key revoked.');
    await fetchKeys();
  };

  const toggleKey = async (token: string, current: string) => {
    busy(token, true);
    const newStatus = current === 'disabled' ? 'active' : 'disabled';
    const res = await fetch('/api/admin/user-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: token, status: newStatus }),
    });
    busy(token, false);
    if (!res.ok) { toast.err('Update failed'); return; }
    toast.ok(`Key ${newStatus === 'active' ? 'enabled' : 'disabled'}.`);
    await fetchKeys();
  };

  const copyToken = (token: string) => {
    navigator.clipboard.writeText(token);
    toast.info('Token copied!');
  };

  const filteredKeys = useMemo(() => keys.filter((k) => {
    const s = search.toLowerCase();
    const matchSearch = !s || (k.name || '').toLowerCase().includes(s) || k.token.toLowerCase().includes(s);
    const matchStatus = !filterStatus || k.status === filterStatus;
    return matchSearch && matchStatus;
  }), [keys, search, filterStatus]);

  const totals = useMemo(() => keys.reduce((acc, row) => ({
    requests: acc.requests + Number(row.usage_count || 0),
    tokens: acc.tokens + Number(row.total_tokens || 0),
  }), { requests: 0, tokens: 0 }), [keys]);

  if (loading) {
    return (
      <div className="dashboard-page">
        <div className="kpi-grid kpi-grid-3">{[1,2,3].map((i) => <div key={i} className="sk sk-card" />)}</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="panel" style={{ maxWidth: 440, margin: '60px auto', textAlign: 'center', padding: 32 }}>
        <h2 className="section-title" style={{ marginBottom: 8 }}>Authentication Required</h2>
        <p className="muted-text">Sign in from the sidebar.</p>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <ToastContainer />
      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreated={async () => { await fetchKeys(); }}
        />
      )}

      <header className="page-header">
        <div>
          <h1 className="page-title">Gateway Keys</h1>
          <p className="muted-text">Issue and manage Anthropic-compatible bearer tokens for clients.</p>
        </div>
        <div className="toolbar-row">
          <button className="btn" onClick={fetchKeys}>↺ Refresh</button>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Issue Key</button>
        </div>
      </header>

      <section className="kpi-grid kpi-grid-3">
        <article className="kpi-card kpi-card-ok">
          <p className="kpi-label">Active Keys</p>
          <p className="kpi-value">{fmt(keys.filter((k) => k.status !== 'revoked').length)}</p>
          <p className="kpi-subtle">{fmt(keys.filter((k) => k.status === 'revoked').length)} revoked</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Total Requests</p>
          <p className="kpi-value">{fmt(totals.requests)}</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Total Tokens</p>
          <p className="kpi-value">{compact(totals.tokens)}</p>
        </article>
      </section>

      <section className="panel">
        <div className="filter-row">
          <input className="search-input" placeholder="Search by name or token…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="select-filter" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
            <option value="revoked">Revoked</option>
          </select>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Name</th>
              <th className="col-status">Status</th>
              <th className="col-num">Requests</th>
              <th>Tokens Used</th>
              <th className="col-date">Last Used</th>
              <th className="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredKeys.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--text-muted)' }}>No keys match the filter.</td></tr>}
            {filteredKeys.map((row) => {
              const usagePct = row.max_usage ? Math.min(100, (Number(row.total_tokens || 0) / row.max_usage) * 100) : null;
              return (
                <tr key={row.token} className={row.status === 'revoked' ? 'row-error' : ''}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <code className="key-mask">{row.token.slice(0, 18)}…</code>
                      <button className="btn btn-xs" onClick={() => copyToken(row.token)} title="Copy full token">⎘</button>
                    </div>
                  </td>
                  <td>{row.name || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td><span className={`pill pill-${row.status || 'active'}`}>{row.status || 'active'}</span></td>
                  <td>{fmt(Number(row.usage_count || 0))}</td>
                  <td style={{ minWidth: 120 }}>
                    <div>{compact(Number(row.total_tokens || 0))}{row.max_usage ? ` / ${compact(row.max_usage)}` : ''}</div>
                    {usagePct !== null && (
                      <div className="progress-track" style={{ marginTop: 4 }}>
                        <div className={`progress-fill ${usagePct > 90 ? 'progress-fill-bad' : usagePct > 70 ? 'progress-fill-warn' : 'progress-fill-ok'}`} style={{ width: `${usagePct}%` }} />
                      </div>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{tsAgo(Number(row.last_used || 0))}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {row.status !== 'revoked' && (
                        <button
                          className={`btn btn-xs ${row.status === 'disabled' ? 'btn-ok' : 'btn-warn'}`}
                          onClick={() => toggleKey(row.token, row.status || 'active')}
                          disabled={busyTokens.has(row.token)}
                        >
                          {row.status === 'disabled' ? 'Enable' : 'Disable'}
                        </button>
                      )}
                      {row.status !== 'revoked' && (
                        <button className="btn btn-xs btn-danger" onClick={() => revokeKey(row.token)} disabled={busyTokens.has(row.token)}>Revoke</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
