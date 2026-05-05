"use client";
import { useEffect, useMemo, useState } from 'react';

type ProviderKey = {
  id: string;
  key: string;
  status: 'healthy' | 'cooldown' | 'revoked';
  failure_count?: number;
  last_used?: number;
  daily_used?: number;
};

function n(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(value || 0)));
}

function formatUnix(ts?: number): string {
  if (!ts || ts <= 0) return '-';
  return new Date(Number(ts) * 1000).toLocaleString();
}

export default function KeysPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [providerKeys, setProviderKeys] = useState<ProviderKey[]>([]);
  const [newKey, setNewKey] = useState('');

  const fetchKeys = async () => {
    const res = await fetch('/api/admin/keys', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      setProviderKeys(data.keys || []);
    }
  };

  useEffect(() => {
    const load = async () => {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        setLoading(false);
        return;
      }
      setIsAuthenticated(true);
      await fetchKeys();
      setLoading(false);
    };
    load();
  }, []);

  const login = async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      setIsAuthenticated(true);
      await fetchKeys();
    } else {
      alert('Invalid credentials');
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setIsAuthenticated(false);
    setProviderKeys([]);
  };

  const addKey = async () => {
    if (!newKey.trim()) return;
    const res = await fetch('/api/admin/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: newKey.trim() }),
    });
    if (!res.ok) {
      alert('Failed to add key');
      return;
    }
    setNewKey('');
    await fetchKeys();
  };

  const deleteKey = async (id: string) => {
    if (!confirm('Delete this provider key?')) return;
    await fetch(`/api/admin/keys?id=${id}`, { method: 'DELETE' });
    await fetchKeys();
  };

  const activateAll = async () => {
    if (!confirm('Reset cooldown/failures for all provider keys?')) return;
    const res = await fetch('/api/admin/reset-keys', { method: 'POST' });
    if (!res.ok) {
      alert('Failed to activate all keys');
      return;
    }
    await fetchKeys();
  };

  const healthSummary = useMemo(() => {
    const healthy = providerKeys.filter((k) => k.status === 'healthy').length;
    const cooldown = providerKeys.filter((k) => k.status === 'cooldown').length;
    const revoked = providerKeys.filter((k) => k.status === 'revoked').length;
    return { healthy, cooldown, revoked };
  }, [providerKeys]);

  if (loading) return <div className="panel">Loading...</div>;

  if (!isAuthenticated) {
    return (
      <div className="panel auth-panel">
        <h2 className="section-title">Admin Login</h2>
        <p className="muted-text">Authenticate to manage provider keys and gateway controls.</p>
        <div className="form-grid">
          <input className="input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn btn-primary" onClick={login}>Login</button>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Provider Keys</h1>
          <p className="muted-text">Manage Gemini provider keys and monitor pool health.</p>
        </div>
        <div className="toolbar-row">
          <button className="btn" onClick={fetchKeys}>Refresh</button>
          <button className="btn" onClick={logout}>Logout</button>
        </div>
      </header>

      <section className="kpi-grid kpi-grid-4">
        <article className="kpi-card">
          <p className="kpi-label">Total Keys</p>
          <p className="kpi-value">{n(providerKeys.length)}</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Healthy</p>
          <p className="kpi-value">{n(healthSummary.healthy)}</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Cooldown</p>
          <p className="kpi-value">{n(healthSummary.cooldown)}</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Revoked</p>
          <p className="kpi-value">{n(healthSummary.revoked)}</p>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">Key Operations</h2>
        </div>
        <div className="toolbar-row">
          <input className="input" type="text" placeholder="Enter provider API key" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
          <button className="btn btn-primary" onClick={addKey}>Add Key</button>
          <button className="btn" onClick={activateAll}>Activate All</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">Provider Key Pool</h2>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Key</th>
              <th>Status</th>
              <th>Failures</th>
              <th>Daily Used</th>
              <th>Last Used</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {providerKeys.length === 0 && <tr><td colSpan={7}>No provider keys configured.</td></tr>}
            {providerKeys.map((keyRow) => (
              <tr key={keyRow.id}>
                <td><code>{keyRow.id}</code></td>
                <td><code>{keyRow.key?.slice(0, 10)}...</code></td>
                <td><span className={`pill pill-${keyRow.status}`}>{keyRow.status}</span></td>
                <td>{n(Number(keyRow.failure_count || 0))}</td>
                <td>{n(Number(keyRow.daily_used || 0))}</td>
                <td>{formatUnix(Number(keyRow.last_used || 0))}</td>
                <td>
                  <button className="btn btn-danger" onClick={() => deleteKey(keyRow.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
