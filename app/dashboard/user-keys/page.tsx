"use client";
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type GatewayKey = {
  token: string;
  name?: string;
  status?: 'active' | 'revoked';
  usage_count?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  created_at?: number;
  last_used?: number;
};

function n(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(value || 0)));
}

function compact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, value || 0));
}

function fmtUnix(ts?: number): string {
  if (!ts || ts <= 0) return '-';
  return new Date(Number(ts) * 1000).toLocaleString();
}

export default function UserKeysPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [keys, setKeys] = useState<GatewayKey[]>([]);
  const [newName, setNewName] = useState('');
  const [editingToken, setEditingToken] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchKeys = async () => {
    const res = await fetch('/api/admin/user-keys', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      setKeys((data.userKeys || []).filter((k: GatewayKey) => k.status !== 'revoked'));
    }
  };

  useEffect(() => {
    const load = async () => {
      const authRes = await fetch('/api/auth/me');
      if (!authRes.ok) {
        setLoading(false);
        return;
      }
      setIsAuthenticated(true);
      await fetchKeys();
      setLoading(false);
    };
    load();
  }, []);

  const createKey = async () => {
    const res = await fetch('/api/admin/user-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() || 'Gateway Key' }),
    });
    if (!res.ok) {
      alert('Failed to create key');
      return;
    }
    setNewName('');
    await fetchKeys();
  };

  const revokeKey = async (token: string) => {
    if (!confirm('Revoke this gateway key?')) return;
    await fetch(`/api/admin/user-keys?id=${token}`, { method: 'DELETE' });
    await fetchKeys();
  };

  const saveName = async (token: string) => {
    const trimmed = editingName.trim();
    if (!trimmed) return;
    const res = await fetch('/api/admin/user-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: token, name: trimmed }),
    });
    if (!res.ok) {
      alert('Failed to update name');
      return;
    }
    setEditingToken(null);
    await fetchKeys();
  };

  const totals = useMemo(() => {
    return keys.reduce(
      (acc, row) => {
        acc.requests += Number(row.usage_count || 0);
        acc.tokens += Number(row.total_tokens || 0);
        return acc;
      },
      { requests: 0, tokens: 0 }
    );
  }, [keys]);

  if (loading) return <div className="panel">Loading...</div>;

  if (!isAuthenticated) {
    return (
      <div className="panel">
        <h2 className="section-title">Admin Login Required</h2>
        <p className="muted-text">Please sign in from Provider Keys.</p>
        <div className="toolbar-row">
          <Link href="/dashboard/keys" className="btn btn-primary">Go to Login</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Gateway User Keys</h1>
          <p className="muted-text">Issue, rename, revoke, and monitor per-key token usage.</p>
        </div>
        <div className="toolbar-row">
          <button className="btn" onClick={fetchKeys}>Refresh</button>
        </div>
      </header>

      <section className="kpi-grid kpi-grid-3">
        <article className="kpi-card">
          <p className="kpi-label">Active Keys</p>
          <p className="kpi-value">{n(keys.length)}</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Total Requests</p>
          <p className="kpi-value">{n(totals.requests)}</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Total Tokens</p>
          <p className="kpi-value">{compact(totals.tokens)}</p>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">Create Key</h2>
        </div>
        <div className="toolbar-row">
          <input className="input" type="text" placeholder="Name / Owner / Team" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn btn-primary" onClick={createKey}>Create Key</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">Active Gateway Keys</h2>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Name</th>
              <th>Status</th>
              <th>Requests</th>
              <th>Input</th>
              <th>Output</th>
              <th>Total Tokens</th>
              <th>Last Used</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && <tr><td colSpan={9}>No active gateway keys.</td></tr>}
            {keys.map((row) => (
              <tr key={row.token}>
                <td><code>{row.token}</code></td>
                <td>
                  {editingToken === row.token ? (
                    <div className="inline-edit">
                      <input className="input" type="text" value={editingName} onChange={(e) => setEditingName(e.target.value)} />
                      <button className="btn btn-primary" onClick={() => saveName(row.token)}>Save</button>
                      <button className="btn" onClick={() => setEditingToken(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div className="inline-edit">
                      <span>{row.name || 'Gateway Key'}</span>
                      <button className="btn" onClick={() => { setEditingToken(row.token); setEditingName(row.name || 'Gateway Key'); }}>Rename</button>
                    </div>
                  )}
                </td>
                <td><span className={`pill pill-${row.status || 'active'}`}>{row.status || 'active'}</span></td>
                <td>{n(Number(row.usage_count || 0))}</td>
                <td>{compact(Number(row.input_tokens || 0))}</td>
                <td>{compact(Number(row.output_tokens || 0))}</td>
                <td>{compact(Number(row.total_tokens || 0))}</td>
                <td>{fmtUnix(Number(row.last_used || 0))}</td>
                <td><button className="btn btn-danger" onClick={() => revokeKey(row.token)}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
