"use client";
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type KeyRow = { id: string; status?: string; failure_count?: number };
type UserKeyRow = { token: string; name?: string; status?: string };
type ModelMap = Record<string, { primary: string; fallback: string[] }>;

type StatsResponse = {
  requests: number;
  errors: number;
  avgLatency: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  today: {
    date: string;
    requests: number;
    errors: number;
    avgLatency: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
  };
  daily: Array<{
    date: string;
    requests: number;
    errors: number;
    avgLatency: number;
    totalTokens: number;
  }>;
  topModels: {
    todayTokens: Array<{ key: string; value: number }>;
    todayRequests: Array<{ key: string; value: number }>;
  };
  topUsersTodayByTokens: Array<{ key: string; value: number }>;
};

function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(n || 0)));
}

function formatCompact(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, n || 0));
}

function errorRate(errors: number, requests: number): string {
  if (!requests) return '0%';
  return `${((errors / requests) * 100).toFixed(2)}%`;
}

export default function DashboardOverviewPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [providerKeys, setProviderKeys] = useState<KeyRow[]>([]);
  const [userKeys, setUserKeys] = useState<UserKeyRow[]>([]);
  const [modelRoutes, setModelRoutes] = useState<ModelMap>({});

  useEffect(() => {
    const load = async () => {
      const authRes = await fetch('/api/auth/me');
      if (!authRes.ok) {
        setLoading(false);
        return;
      }
      setIsAuthenticated(true);
      const [statsRes, keysRes, usersRes, modelsRes] = await Promise.all([
        fetch('/api/admin/stats', { cache: 'no-store' }),
        fetch('/api/admin/keys', { cache: 'no-store' }),
        fetch('/api/admin/user-keys', { cache: 'no-store' }),
        fetch('/api/admin/models', { cache: 'no-store' }),
      ]);

      if (statsRes.ok) setStats(await statsRes.json());
      if (keysRes.ok) {
        const data = await keysRes.json();
        setProviderKeys(data.keys || []);
      }
      if (usersRes.ok) {
        const data = await usersRes.json();
        setUserKeys((data.userKeys || []).filter((row: UserKeyRow) => row.status !== 'revoked'));
      }
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        setModelRoutes(data.models || {});
      }
      setLoading(false);
    };
    load();
  }, []);

  const providerHealth = useMemo(() => {
    const healthy = providerKeys.filter((k) => k.status === 'healthy').length;
    const cooldown = providerKeys.filter((k) => k.status === 'cooldown').length;
    const revoked = providerKeys.filter((k) => k.status === 'revoked').length;
    return { healthy, cooldown, revoked, total: providerKeys.length };
  }, [providerKeys]);

  const maxDailyTokens = useMemo(
    () => Math.max(1, ...(stats?.daily?.map((d) => d.totalTokens || 0) || [1])),
    [stats]
  );

  if (loading) {
    return <div className="panel">Loading dashboard...</div>;
  }

  if (!isAuthenticated) {
    return (
      <div className="panel">
        <h2 className="section-title">Admin Login Required</h2>
        <p className="muted-text">Please sign in from Provider Keys to access the dashboard.</p>
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
          <h1 className="page-title">Gateway Overview</h1>
          <p className="muted-text">Daily usage, key health, routing, and operator signals in one place.</p>
        </div>
        <div className="toolbar-row">
          <Link href="/dashboard/stats" className="btn">Open Usage Details</Link>
        </div>
      </header>

      {stats && (
        <>
          <section className="kpi-grid">
            <article className="kpi-card">
              <p className="kpi-label">Today Tokens</p>
              <p className="kpi-value">{formatCompact(stats.today.totalTokens)}</p>
              <p className="kpi-subtle">{formatNumber(stats.today.inputTokens)} in / {formatNumber(stats.today.outputTokens)} out</p>
            </article>
            <article className="kpi-card">
              <p className="kpi-label">Today Requests</p>
              <p className="kpi-value">{formatNumber(stats.today.requests)}</p>
              <p className="kpi-subtle">Errors: {formatNumber(stats.today.errors)}</p>
            </article>
            <article className="kpi-card">
              <p className="kpi-label">Today Error Rate</p>
              <p className="kpi-value">{errorRate(stats.today.errors, stats.today.requests)}</p>
              <p className="kpi-subtle">Global: {errorRate(stats.errors, stats.requests)}</p>
            </article>
            <article className="kpi-card">
              <p className="kpi-label">Avg Latency</p>
              <p className="kpi-value">{formatNumber(stats.today.avgLatency)} ms</p>
              <p className="kpi-subtle">Global: {formatNumber(stats.avgLatency)} ms</p>
            </article>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2 className="section-title">14-Day Token Trend</h2>
              <p className="muted-text">IST day aggregation from live request accounting.</p>
            </div>
            <div className="trend-bars">
              {stats.daily.map((day) => (
                <div className="trend-row" key={day.date}>
                  <div className="trend-meta">
                    <span>{day.date}</span>
                    <span>{formatCompact(day.totalTokens)}</span>
                  </div>
                  <div className="trend-track">
                    <div className="trend-fill" style={{ width: `${Math.max(2, (day.totalTokens / maxDailyTokens) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      <section className="kpi-grid kpi-grid-3">
        <article className="kpi-card">
          <p className="kpi-label">Provider Keys</p>
          <p className="kpi-value">{providerHealth.total}</p>
          <p className="kpi-subtle">
            Healthy {providerHealth.healthy} / Cooldown {providerHealth.cooldown} / Revoked {providerHealth.revoked}
          </p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Active Gateway Keys</p>
          <p className="kpi-value">{formatNumber(userKeys.length)}</p>
          <p className="kpi-subtle">Revoked keys are excluded.</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Model Routes</p>
          <p className="kpi-value">{formatNumber(Object.keys(modelRoutes).length)}</p>
          <p className="kpi-subtle">Configurable in Model Routing.</p>
        </article>
      </section>

      {stats && (
        <section className="panel-grid two-col">
          <article className="panel">
            <div className="panel-header">
              <h2 className="section-title">Top Models Today</h2>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Tokens</th>
                  <th>Requests</th>
                </tr>
              </thead>
              <tbody>
                {stats.topModels.todayTokens.length === 0 && (
                  <tr><td colSpan={3}>No model activity yet.</td></tr>
                )}
                {stats.topModels.todayTokens.map((row) => (
                  <tr key={row.key}>
                    <td><code>{row.key}</code></td>
                    <td>{formatCompact(row.value)}</td>
                    <td>{formatNumber(stats.topModels.todayRequests.find((r) => r.key === row.key)?.value || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>

          <article className="panel">
            <div className="panel-header">
              <h2 className="section-title">Top Gateway Keys Today</h2>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {stats.topUsersTodayByTokens.length === 0 && (
                  <tr><td colSpan={2}>No user token activity yet.</td></tr>
                )}
                {stats.topUsersTodayByTokens.map((row) => (
                  <tr key={row.key}>
                    <td><code>{row.key}</code></td>
                    <td>{formatCompact(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        </section>
      )}
    </div>
  );
}
