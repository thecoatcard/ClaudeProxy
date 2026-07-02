"use client";
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  Tooltip, CartesianGrid,
} from 'recharts';
import { useAuth } from '@/components/auth-provider';

type KeyRow = { id: string; status?: string };
type UserKeyRow = { token: string; status?: string };
type SystemResponse = {
  data?: {
    settings?: {
      racingEnabled?: boolean;
    };
  };
};
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

export default function DashboardOverviewPage() {
  const { isAuthenticated } = useAuth();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [providerKeys, setProviderKeys] = useState<KeyRow[]>([]);
  const [userKeys, setUserKeys] = useState<UserKeyRow[]>([]);
  const [racingEnabled, setRacingEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isAuthenticated === null) return;
    if (!isAuthenticated) { setLoading(false); return; }
    (async () => {
      const [sRes, kRes, uRes, systemRes] = await Promise.all([
        fetch('/api/admin/stats', { cache: 'no-store' }),
        fetch('/api/admin/keys', { cache: 'no-store' }),
        fetch('/api/admin/user-keys', { cache: 'no-store' }),
        fetch('/api/admin/system', { cache: 'no-store' }),
      ]);
      if (sRes.ok) setStats(await sRes.json());
      if (kRes.ok) setProviderKeys((await kRes.json()).keys || []);
      if (uRes.ok) setUserKeys(((await uRes.json()).userKeys || []).filter((k: UserKeyRow) => k.status !== 'revoked'));
      if (systemRes.ok) {
        const systemData = await systemRes.json() as SystemResponse;
        setRacingEnabled(systemData.data?.settings?.racingEnabled === true);
      }
      setLoading(false);
    })();
  }, [isAuthenticated]);

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

  const TOOLTIP_STYLE = useMemo(() => ({
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
    fontSize: '12px',
    color: 'var(--text)'
  }), []);

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

  if (!isAuthenticated) {
    return (
      <div className="panel" style={{ maxWidth: 460, margin: '80px auto', textAlign: 'center', padding: 32 }}>
        <h2 className="section-title" style={{ marginBottom: 12 }}>Admin Controls Locked</h2>
        <p className="muted-text" style={{ marginBottom: 24 }}>Authenticate to unlock gateway observability, keys pool management, and performance stats.</p>
        <button onClick={() => {
          // Trigger the sign in click on layout (which renders LoginModal)
          const btn = document.querySelector('.sidebar-footer button') as HTMLButtonElement | null;
          if (btn) btn.click();
        }} className="btn btn-primary">Sign In to Dashboard</button>
      </div>
    );
  }

  const t = stats?.today;
  const g = stats;

  return (
    <div className="dashboard-page">
      <header className="page-header" style={{ border: 'none', paddingBottom: 0 }}>
        <div>
          <p className="brand-eyebrow" style={{ fontSize: '13px', color: 'var(--primary)' }}>Control Plane Dashboard</p>
          <h1 className="page-title" style={{ fontSize: '32px' }}>Welcome back, Operator</h1>
          <p className="muted-text">Gateway health, key pool status, and usage trends are streaming live.</p>
        </div>
        <div className="toolbar-row">
          <Link href="/dashboard/stats" className="btn btn-primary btn-sm">Observability Analytics</Link>
          <Link href="/dashboard/activity" className="btn btn-sm">Activity Feed</Link>
        </div>
      </header>

      {/* KPI Cards Widget Row */}
      <section className="kpi-grid">
        <article className="kpi-card kpi-card-ok">
          <p className="kpi-label">Today's Token Volume</p>
          <p className="kpi-value">{compact(t?.totalTokens ?? 0)}</p>
          <p className="kpi-subtle">{fmt(t?.inputTokens ?? 0)} in / {fmt(t?.outputTokens ?? 0)} out</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Requests Count Today</p>
          <p className="kpi-value">{fmt(t?.requests ?? 0)}</p>
          <p className="kpi-subtle">Total Lifetime: {compact(g?.requests ?? 0)}</p>
        </article>
        <article className={`kpi-card ${(t?.errors ?? 0) > 0 ? 'kpi-card-warn' : ''}`}>
          <p className="kpi-label">Error Rate (24h)</p>
          <p className="kpi-value">{errRate(t?.errors ?? 0, t?.requests ?? 0)}</p>
          <p className="kpi-subtle">{fmt(t?.errors ?? 0)} failures recorded</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Average Latency</p>
          <p className="kpi-value">{fmt(t?.avgLatency ?? 0)} ms</p>
          <p className="kpi-subtle">Lifetime Average: {fmt(g?.avgLatency ?? 0)} ms</p>
        </article>
      </section>

      {/* Recharts observations panel */}
      {stats && chartData.length > 0 && (
        <section className="panel-grid two-col">
          <article className="panel">
            <div className="panel-header">
              <div>
                <h2 className="section-title">Token Consumption Trend</h2>
                <p className="muted-text" style={{ fontSize: '12px' }}>Aggregated volume in thousands (last 14 days)</p>
              </div>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%" minWidth={100} minHeight={100}>
                <LineChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line-soft)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Line type="monotone" dataKey="tokens" stroke="var(--primary)" strokeWidth={2.5} dot={false} name="Tokens (K)" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <h2 className="section-title">Traffic Volume vs Errors</h2>
                <p className="muted-text" style={{ fontSize: '12px' }}>Successful completions against API failures</p>
              </div>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%" minWidth={100} minHeight={100}>
                <LineChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line-soft)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Line type="monotone" dataKey="requests" stroke="var(--ok)" strokeWidth={2.5} dot={false} name="Requests" />
                  <Line type="monotone" dataKey="errors" stroke="var(--bad)" strokeWidth={1.5} dot={false} name="Errors" strokeDasharray="3 3" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </article>
        </section>
      )}

      {/* Infrastructure Widget Row */}
      <section className="kpi-grid kpi-grid-3">
        <article className={`kpi-card ${keyHealth.total === 0 ? '' : keyHealth.healthy / keyHealth.total < 0.5 ? 'kpi-card-bad' : keyHealth.cooldown > 0 ? 'kpi-card-warn' : 'kpi-card-ok'}`}>
          <p className="kpi-label">Provider Keys Pool</p>
          <p className="kpi-value">{keyHealth.total}</p>
          <p className="kpi-subtle">
            <span style={{ color: 'var(--ok)' }}>● {keyHealth.healthy} healthy</span> · 
            <span style={{ color: 'var(--warn)' }}> ● {keyHealth.cooldown} cooldown</span> · 
            <span style={{ color: 'var(--text-muted)' }}> ● {keyHealth.revoked} off</span>
          </p>
          {keyHealth.total > 0 && (
            <div className="progress-track" style={{ marginTop: 12 }}>
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
          <p className="kpi-subtle">Provisioned client tokens. Revoked excluded.</p>
        </article>

        <article className={`kpi-card ${racingEnabled ? 'kpi-card-warn' : 'kpi-card-ok'}`}>
          <p className="kpi-label">Model Racing Engine</p>
          <p className="kpi-value">{racingEnabled ? 'Active' : 'Standby'}</p>
          <p className="kpi-subtle">Live parallel request evaluation: {racingEnabled ? 'ON' : 'OFF'}</p>
        </article>
      </section>

      {/* Top Models and Top Client Keys lists */}
      {stats && (
        <section className="panel-grid two-col">
          <article className="panel">
            <div className="panel-header">
              <h2 className="section-title">Top Models Today</h2>
              <Link href="/dashboard/models" className="btn btn-xs">Configure Routes</Link>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model Profile</th>
                  <th>Tokens</th>
                  <th>Requests</th>
                </tr>
              </thead>
              <tbody>
                {stats.topModels.todayTokens.length === 0 && (
                  <tr>
                    <td colSpan={3} style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '24px 0' }}>
                      No live traffic recorded today.
                    </td>
                  </tr>
                )}
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
            <div className="panel-header">
              <h2 className="section-title">Top Client Keys Today</h2>
              <Link href="/dashboard/user-keys" className="btn btn-xs">Manage Keys</Link>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Gateway Client Token ID</th>
                  <th>Token Usage</th>
                </tr>
              </thead>
              <tbody>
                {stats.topUsersTodayByTokens.length === 0 && (
                  <tr>
                    <td colSpan={2} style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '24px 0' }}>
                      No token usage recorded today.
                    </td>
                  </tr>
                )}
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
