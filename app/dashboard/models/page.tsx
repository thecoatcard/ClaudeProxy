"use client";
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/components/auth-provider';

type RouteConfig = { primary: string; fallback: string[] };
type Routes = Record<string, RouteConfig>;
type RoutingDiagnostics = {
  source: 'redis' | 'local' | 'hardcoded';
  version: string;
  aliases: number;
  loadedAt: number;
};

export default function ModelsPage() {
  const { isAuthenticated } = useAuth();
  const [loading, setLoading] = useState(true);
  const [routes, setRoutes] = useState<Routes>({});
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonValue, setJsonValue] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [routingDiagnostics, setRoutingDiagnostics] = useState<RoutingDiagnostics | null>(null);

  const [alias, setAlias] = useState('');
  const [primary, setPrimary] = useState('');
  const [fallbacks, setFallbacks] = useState('');

  const fetchRoutes = async () => {
    const res = await fetch('/api/admin/models', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      setRoutes(data.models || {});
      setJsonValue(JSON.stringify(data.models || {}, null, 2));
      setRoutingDiagnostics(data.routing || null);
    }
  };

  useEffect(() => {
    const load = async () => {
      if (isAuthenticated === null) return;
      if (!isAuthenticated) {
        setLoading(false);
        return;
      }
      await fetchRoutes();
      setLoading(false);
    };
    load();
  }, [isAuthenticated]);

  const saveRoutes = async (nextRoutes: Routes) => {
    setSaveMessage('');
    const res = await fetch('/api/admin/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: nextRoutes }),
    });
    if (!res.ok) {
      alert('Failed to save model routes');
      return false;
    }
    const data = await res.json();
    setRoutes(nextRoutes);
    setJsonValue(JSON.stringify(nextRoutes, null, 2));
    setRoutingDiagnostics(data.routing || null);
    setSaveMessage(data.message || 'Routing saved and reloaded successfully.');
    await fetchRoutes();
    return true;
  };

  const addOrUpdateRoute = async () => {
    if (!alias.trim() || !primary.trim()) {
      alert('Alias and primary model are required.');
      return;
    }
    const fallbackList = fallbacks
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

    const next = {
      ...routes,
      [alias.trim().toLowerCase()]: {
        primary: primary.trim(),
        fallback: fallbackList,
      },
    };
    const ok = await saveRoutes(next);
    if (ok) {
      setAlias('');
      setPrimary('');
      setFallbacks('');
    }
  };

  const deleteRoute = async (name: string) => {
    if (!confirm(`Delete route mapping for ${name}?`)) return;
    const { [name]: _, ...rest } = routes;
    await saveRoutes(rest);
  };

  const saveJson = async () => {
    try {
      const parsed = JSON.parse(jsonValue);
      await saveRoutes(parsed);
      setJsonMode(false);
    } catch {
      alert('Invalid JSON');
    }
  };

  const counts = useMemo(() => {
    const aliases = Object.keys(routes).length;
    const uniqueTargets = new Set<string>();
    for (const cfg of Object.values(routes)) {
      uniqueTargets.add((cfg.primary || '').trim());
      for (const fallback of cfg.fallback || []) uniqueTargets.add((fallback || '').trim());
    }
    return { aliases, uniqueTargets: Array.from(uniqueTargets).filter(Boolean).length };
  }, [routes]);

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
          <h1 className="page-title">Model Routing</h1>
          <p className="muted-text">Configure Anthropic alias to Gemini routing and fallback chains.</p>
        </div>
        <div className="toolbar-row">
          <button className="btn" onClick={fetchRoutes}>Refresh</button>
          <button className="btn" onClick={() => setJsonMode((v) => !v)}>{jsonMode ? 'Close JSON' : 'Edit JSON'}</button>
        </div>
      </header>

      <section className="kpi-grid kpi-grid-3">
        <article className="kpi-card">
          <p className="kpi-label">Route Aliases</p>
          <p className="kpi-value">{counts.aliases}</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Unique Target Models</p>
          <p className="kpi-value">{counts.uniqueTargets}</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Fallback Strategy</p>
          <p className="kpi-subtle">Configured per alias for reliability.</p>
        </article>
      </section>

      {routingDiagnostics && (
        <section className="panel">
          <div className="panel-header">
            <h2 className="section-title">Live Routing Status</h2>
          </div>
          <p className="muted-text">
            Source: <strong>{routingDiagnostics.source}</strong> · Version: <strong>{routingDiagnostics.version}</strong> · Loaded aliases: <strong>{routingDiagnostics.aliases}</strong>
          </p>
          {saveMessage && <p className="muted-text"><strong>{saveMessage}</strong></p>}
        </section>
      )}

      {jsonMode ? (
        <section className="panel">
          <div className="panel-header">
            <h2 className="section-title">Raw JSON Editor</h2>
          </div>
          <textarea className="input json-input" value={jsonValue} onChange={(e) => setJsonValue(e.target.value)} />
          <div className="toolbar-row">
            <button className="btn btn-primary" onClick={saveJson}>Save JSON</button>
          </div>
        </section>
      ) : (
        <>
          <section className="panel">
            <div className="panel-header">
              <h2 className="section-title">Add or Update Route</h2>
            </div>
            <div className="form-grid form-grid-4">
              <input className="input" type="text" placeholder="Anthropic alias (claude-...)" value={alias} onChange={(e) => setAlias(e.target.value)} />
              <input className="input" type="text" placeholder="Primary model (gemini-...)" value={primary} onChange={(e) => setPrimary(e.target.value)} />
              <input className="input" type="text" placeholder="Fallbacks comma-separated" value={fallbacks} onChange={(e) => setFallbacks(e.target.value)} />
              <button className="btn btn-primary" onClick={addOrUpdateRoute}>Save Route</button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2 className="section-title">Current Routing Table</h2>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Alias</th>
                  <th>Primary</th>
                  <th>Fallbacks</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(routes).length === 0 && <tr><td colSpan={4}>No routes configured.</td></tr>}
                {Object.entries(routes).sort(([a], [b]) => a.localeCompare(b)).map(([name, cfg]) => (
                  <tr key={name}>
                    <td><code>{name}</code></td>
                    <td><code>{cfg.primary}</code></td>
                    <td>{(cfg.fallback || []).join(' -> ') || '-'}</td>
                    <td><button className="btn btn-danger" onClick={() => deleteRoute(name)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
