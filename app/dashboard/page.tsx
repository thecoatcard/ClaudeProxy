"use client";
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  Tooltip, CartesianGrid,
} from 'recharts';

type KeyRow = { id: string; status?: string };
type UserKeyRow = { token: string; status?: string };
type StatsResponse = {
  requests: number; errors: number; avgLatency: number;
  totalTokens: number; inputTokens: number; outputTokens: number;
  today: {
    date: string; requests: number; errors: number; avgLatency: number;
    totalTokens: number; inputTokens: number; outputTokens: number;
  };
  daily: Array<{ date: string; requests: number; errors: number; avgLatency: number; totalTokens: number }>;
  topModels: {
    todayTokens: Array<{ key: string; value: number }>;
    todayRequests: Array<{ key: string; value: number }>;
  };
  topUsersTodayByTokens: Array<{ key: string; value: number }>;
};

function fmt(n: number) { return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(n || 0))); }
function compact(n: number) { return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, n || 0)); }
function errRate(e: number, r: number) { if (!r) return '0%'; return `${((e / r) * 100).toFixed(2)}%`; }

const TOOLTIP_STYLE = { background: '#1c2230', border: '1px solid #2a3345', borderRadius: 8, fontSize: 12 };

export default function DashboardOverviewPage() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [providerKeys, setProviderKeys] = useState<KeyRow[]>([]);
  const [userKeys, setUserKeys] = useState<UserKeyRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const authRes = await fetch('/api/auth/me');
      if (!authRes.ok) { setAuth(false); setLoading(false); return; }
      setAuth(true);
      const [sRes, kRes, uRes] = await Promise.all([
        fetch('/api/admin/stats', { cache: 'no-store' }),
        fetch('/api/admin/keys', { cache: 'no-store' }),
        fetch('/api/admin/user-keys', { cache: 'no-store' }),
      ]);
      if (sRes.ok) setStats(await sRes.json());
      if (kRes.ok) setProviderKeys((await kRes.json()).keys || []);
      if (uRes.ok) setUserKeys(((await uRes.json()).userKeys || []).filter((k: UserKeyRow) => k.status !== 'revoked'));
      setLoading(false);
    })();
  }, []);

  const keyHealth = useMemo(() => ({
    healthy: providerKeys.filter((k) => k.status === 'healthy').length,
    cooldown: providerKeys.filter((k) => k.status === 'cooldown').length,
    revoked: providerKeys.filter((k) => k.status === 'revoked' || k.status === 'disabled').length,
    total: providerKeys.length,
  }), [providerKeys]);

  const chartData = useMemo(() =>
    (stats?.daily ?? []).map((d) => ({
      date: d.date.slice(5),
      tokens: Math.round((d.totalTokens || 0) / 1000),
      requests: d.requests || 0,
      errors: d.errors || 0,
    })), [stats]);

  if (loading) {
    return (
      <div className="dashboard-page">
        <div className="kpi-grid">
          {[1,2,3,4].map((i) => <div key={i} className="sk sk-card" />)}
        </div>
        <div className="sk sk-card" style={{ height: 260 }} />
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="panel" style={{ maxWidth: 440, margin: '60px auto', textAlign: 'center', padding: 32 }}>
        <h2 className="section-title" style={{ marginBottom: 8 }}>Admin Login Required</h2>
        <p className="muted-text" style={{ marginBottom: 20 }}>Click Sign In in the sidebar to access the dashboard.</p>
        <Link href="/dashboard/keys" className="btn btn-primary">Go to Provider Keys</Link>
      </div>
    );
  }

  const t = stats?.today;
  const g = stats;

  return (
    <div className="dashboard-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Gateway Overview</h1>
          <p className="muted-text">Live health, key pool status, and usage trends.</p>
        </div>
        <div className="toolbar-row">
          <Link href="/dashboard/stats" className="btn">Observability →</Link>
          <Link href="/dashboard/activity" className="btn">Activity Feed →</Link>
        </div>
      </header>

      {/* KPI Cards */}
      <section className="kpi-grid">
        <article className="kpi-card kpi-card-ok">
          <p className="kpi-label">Today Tokens</p>
          <p className="kpi-value">{compact(t?.totalTokens ?? 0)}</p>
          <p className="kpi-subtle">{fmt(t?.inputTokens ?? 0)} in / {fmt(t?.outputTokens ?? 0)} out</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Today Requests</p>
          <p className="kpi-value">{fmt(t?.requests ?? 0)}</p>
          <p className="kpi-subtle">All time: {compact(g?.requests ?? 0)}</p>
        </article>
        <article className={`kpi-card ${(t?.errors ?? 0) > 0 ? 'kpi-card-warn' : ''}`}>
          <p className="kpi-label">Error Rate Today</p>
          <p className="kpi-value">{errRate(t?.errors ?? 0, t?.requests ?? 0)}</p>
          <p className="kpi-subtle">{fmt(t?.errors ?? 0)} errors today</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Avg Latency Today</p>
          <p className="kpi-value">{fmt(t?.avgLatency ?? 0)} ms</p>
          <p className="kpi-subtle">All time: {fmt(g?.avgLatency ?? 0)} ms</p>
        </article>
      </section>

      {/* Charts */}
      {stats && chartData.length > 0 && (
        <section className="panel-grid two-col">
          <article className="panel">
            <div className="panel-header">
              <h2 className="section-title">Token Usage (14 days)</h2>
              <span className="muted-text" style={{ fontSize: 11 }}>thousands</span>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1c2a3a" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9dacbf' }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: '#9dacbf' }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#9dacbf' }} itemStyle={{ color: '#e9edf7' }} />
                  <Line type="monotone" dataKey="tokens" stroke="#38bdf8" strokeWidth={2} dot={false} name="Tokens (K)" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <h2 className="section-title">Requests vs Errors (14 days)</h2>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1c2a3a" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9dacbf' }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: '#9dacbf' }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#9dacbf' }} itemStyle={{ color: '#e9edf7' }} />
                  <Line type="monotone" dataKey="requests" stroke="#22c55e" strokeWidth={2} dot={false} name="Requests" />
                  <Line type="monotone" dataKey="errors" stroke="#f43f5e" strokeWidth={1.5} dot={false} name="Errors" strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </article>
        </section>
      )}

      {/* Infrastructure summary */}
      <section className="kpi-grid kpi-grid-3">
        <article className={`kpi-card ${keyHealth.total === 0 ? '' : keyHealth.healthy / keyHealth.total < 0.5 ? 'kpi-card-bad' : keyHealth.cooldown > 0 ? 'kpi-card-warn' : 'kpi-card-ok'}`}>
          <p className="kpi-label">Provider Key Pool</p>
          <p className="kpi-value">{keyHealth.total}</p>
          <p className="kpi-subtle">✅ {keyHealth.healthy} healthy · ⏳ {keyHealth.cooldown} cooldown · 🚫 {keyHealth.revoked} off</p>
          {keyHealth.total > 0 && (
            <div className="progress-track" style={{ marginTop: 8 }}>
              <div
                className={`progress-fill ${keyHealth.healthy / keyHealth.total < 0.5 ? 'progress-fill-bad' : keyHealth.cooldown > 0 ? 'progress-fill-warn' : 'progress-fill-ok'}`}
                style={{ width: `${(keyHealth.healthy / keyHealth.total) * 100}%` }}
              />
            </div>
          )}
        </article>
        <article className="kpi-card kpi-card-ok">
          <p className="kpi-label">Active Gateway Keys</p>
          <p className="kpi-value">{fmt(userKeys.length)}</p>
          <p className="kpi-subtle">Issued to clients. Revoked excluded.</p>
        </article>
        <article className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p className="kpi-label">Quick Actions</p>
          <Link href="/dashboard/keys" className="btn btn-sm" style={{ textAlign: 'center' }}>Manage Provider Keys</Link>
          <Link href="/dashboard/user-keys" className="btn btn-sm" style={{ textAlign: 'center' }}>Issue Gateway Key</Link>
          <Link href="/dashboard/system" className="btn btn-sm" style={{ textAlign: 'center' }}>System Controls</Link>
        </article>
      </section>

      {/* Top models + top users */}
      {stats && (
        <section className="panel-grid two-col">
          <article className="panel">
            <div className="panel-header"><h2 className="section-title">Top Models Today</h2></div>
            <table className="data-table">
              <thead><tr><th>Model</th><th>Tokens</th><th>Requests</th></tr></thead>
              <tbody>
                {stats.topModels.todayTokens.length === 0 && <tr><td colSpan={3} style={{ color: 'var(--text-muted)' }}>No activity yet.</td></tr>}
                {stats.topModels.todayTokens.map((row) => (
                  <tr key={row.key}>
                    <td><code>{row.key}</code></td>
                    <td>{compact(row.value)}</td>
                    <td>{fmt(stats.topModels.todayRequests.find((r) => r.key === row.key)?.value || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
          <article className="panel">
            <div className="panel-header"><h2 className="section-title">Top Gateway Keys Today</h2></div>
            <table className="data-table">
              <thead><tr><th>Token</th><th>Tokens</th></tr></thead>
              <tbody>
                {stats.topUsersTodayByTokens.length === 0 && <tr><td colSpan={2} style={{ color: 'var(--text-muted)' }}>No token activity yet.</td></tr>}
                {stats.topUsersTodayByTokens.map((row) => (
                  <tr key={row.key}>
                    <td><code className="key-mask">{row.key}</code></td>
                    <td>{compact(row.value)}</td>
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
