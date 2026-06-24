"use client";
import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { useAuth } from '@/components/auth-provider';

type DayRow = {
  date: string; requests: number; errors: number; avgLatency: number;
  inputTokens: number; outputTokens: number; totalTokens: number;
};
type ModelRow = { key: string; value: number };
type StatsData = {
  requests: number; errors: number; avgLatency: number;
  inputTokens: number; outputTokens: number; totalTokens: number;
  today: DayRow;
  daily: DayRow[];
  topModels: {
    totalRequests: ModelRow[]; totalErrors: ModelRow[]; totalTokens: ModelRow[];
    todayRequests: ModelRow[]; todayErrors: ModelRow[]; todayTokens: ModelRow[];
  };
};

type Range = 'today' | '7d' | '14d' | '30d';
const RANGE_DAYS: Record<Range, number> = { today: 1, '7d': 7, '14d': 14, '30d': 30 };

function fmt(n: number) { return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(n || 0))); }
function compact(n: number) { return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, n || 0)); }
function pct(a: number, b: number) { if (!b) return '0%'; return `${((a / b) * 100).toFixed(2)}%`; }

const TOOLTIP_STYLE = { background: '#1c2230', border: '1px solid #2a3345', borderRadius: 8, fontSize: 12 };

export default function StatsPage() {
  const { isAuthenticated } = useAuth();
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<Range>('14d');

  const fetchStats = useCallback(async () => {
    const res = await fetch('/api/admin/stats', { cache: 'no-store' });
    if (res.ok) setStats(await res.json());
  }, []);

  useEffect(() => {
    if (isAuthenticated === null) return;
    if (!isAuthenticated) { setLoading(false); return; }
    (async () => {
      await fetchStats();
      setLoading(false);
    })();
  }, [fetchStats, isAuthenticated]);

  const slicedDaily = useMemo(() => {
    if (!stats) return [];
    const days = RANGE_DAYS[range];
    return stats.daily.slice(-days).map((d) => ({
      date: d.date.slice(5),
      Requests: d.requests || 0,
      Errors: d.errors || 0,
      'Tokens (K)': Math.round((d.totalTokens || 0) / 1000),
      'Latency ms': Math.round(d.avgLatency || 0),
    }));
  }, [stats, range]);

  const barData = useMemo(() => {
    if (!stats) return [];
    return stats.topModels.totalTokens.slice(0, 8).map((r) => ({
      name: r.key.length > 18 ? r.key.slice(0, 18) + '…' : r.key,
      Tokens: Math.round(r.value / 1000),
    }));
  }, [stats]);

  if (loading) {
    return (
      <div className="dashboard-page">
        <div className="kpi-grid">{[1,2,3,4].map((i) => <div key={i} className="sk sk-card" />)}</div>
        <div className="sk sk-card" style={{ height: 280 }} />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="panel" style={{ maxWidth: 440, margin: '60px auto', textAlign: 'center', padding: 32 }}>
        <h2 className="section-title" style={{ marginBottom: 8 }}>Authentication Required</h2>
        <p className="muted-text">Sign in from the sidebar to view statistics.</p>
      </div>
    );
  }

  if (!stats) return <div className="panel">Could not load stats.</div>;

  const t = stats.today;

  return (
    <div className="dashboard-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Observability</h1>
          <p className="muted-text">Token accounting, request trends, and model utilization.</p>
        </div>
        <div className="toolbar-row">
          <div className="tab-bar">
            {(['today', '7d', '14d', '30d'] as Range[]).map((r) => (
              <button key={r} className={`tab${range === r ? ' active' : ''}`} onClick={() => setRange(r)}>{r}</button>
            ))}
          </div>
          <button className="btn" onClick={fetchStats}>↺ Refresh</button>
        </div>
      </header>

      {/* KPI cards */}
      <section className="kpi-grid">
        <article className="kpi-card kpi-card-ok">
          <p className="kpi-label">Total Tokens</p>
          <p className="kpi-value">{compact(stats.totalTokens)}</p>
          <p className="kpi-subtle">{fmt(stats.inputTokens)} in / {fmt(stats.outputTokens)} out</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Total Requests</p>
          <p className="kpi-value">{fmt(stats.requests)}</p>
          <p className="kpi-subtle">Today: {fmt(t.requests)}</p>
        </article>
        <article className={`kpi-card ${stats.errors > 0 ? 'kpi-card-warn' : ''}`}>
          <p className="kpi-label">Error Rate</p>
          <p className="kpi-value">{pct(stats.errors, stats.requests)}</p>
          <p className="kpi-subtle">Today: {pct(t.errors, t.requests)}</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Avg Latency</p>
          <p className="kpi-value">{fmt(stats.avgLatency)} ms</p>
          <p className="kpi-subtle">Today: {fmt(t.avgLatency)} ms</p>
        </article>
      </section>

      {/* Charts */}
      <section className="panel-grid two-col">
        <article className="panel">
          <div className="panel-header">
            <h2 className="section-title">Tokens/Day ({range})</h2>
            <span className="muted-text" style={{ fontSize: 11 }}>thousands</span>
          </div>
          <div className="chart-wrap-lg">
            <ResponsiveContainer width="100%" height="100%" minWidth={100} minHeight={100} debounce={50}>
              <LineChart data={slicedDaily} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1c2a3a" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9dacbf' }} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#9dacbf' }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#9dacbf' }} />
                <Line type="monotone" dataKey="Tokens (K)" stroke="#38bdf8" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <h2 className="section-title">Requests &amp; Errors ({range})</h2>
          </div>
          <div className="chart-wrap-lg">
            <ResponsiveContainer width="100%" height="100%" minWidth={100} minHeight={100} debounce={50}>
              <LineChart data={slicedDaily} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1c2a3a" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9dacbf' }} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#9dacbf' }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#9dacbf' }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#9dacbf' }} />
                <Line type="monotone" dataKey="Requests" stroke="#22c55e" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Errors" stroke="#f43f5e" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </article>
      </section>

      {/* Model bar chart */}
      {barData.length > 0 && (
        <section className="panel">
          <div className="panel-header">
            <h2 className="section-title">All-Time Token Distribution by Model</h2>
            <span className="muted-text" style={{ fontSize: 11 }}>thousands</span>
          </div>
          <div className="chart-wrap-lg">
            <ResponsiveContainer width="100%" height="100%" minWidth={100} minHeight={100} debounce={50}>
              <BarChart data={barData} margin={{ top: 4, right: 8, bottom: 40, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1c2a3a" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#9dacbf' }} angle={-30} textAnchor="end" interval={0} />
                <YAxis tick={{ fontSize: 10, fill: '#9dacbf' }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#9dacbf' }} />
                <Bar dataKey="Tokens" fill="#38bdf8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {/* Daily table */}
      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">Daily Breakdown</h2>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 700 }}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Requests</th>
                <th>Errors</th>
                <th>Input Tokens</th>
                <th>Output Tokens</th>
                <th>Total Tokens</th>
                <th>Avg Latency</th>
              </tr>
            </thead>
            <tbody>
              {stats.daily.slice(-RANGE_DAYS[range]).map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>{fmt(day.requests)}</td>
                  <td style={{ color: day.errors > 0 ? 'var(--bad)' : undefined }}>{fmt(day.errors)}</td>
                  <td>{fmt(day.inputTokens)}</td>
                  <td>{fmt(day.outputTokens)}</td>
                  <td>{compact(day.totalTokens)}</td>
                  <td>{fmt(day.avgLatency)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Model breakdown table */}
      <section className="panel-grid two-col">
        <article className="panel">
          <div className="panel-header"><h2 className="section-title">Model Usage Today</h2></div>
          <table className="data-table">
            <thead><tr><th>Model</th><th>Tokens</th><th>Requests</th><th>Errors</th></tr></thead>
            <tbody>
              {stats.topModels.todayTokens.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--text-muted)' }}>No activity yet.</td></tr>}
              {stats.topModels.todayTokens.map((row) => (
                <tr key={row.key}>
                  <td><code>{row.key}</code></td>
                  <td>{compact(row.value)}</td>
                  <td>{fmt(stats.topModels.todayRequests.find((r) => r.key === row.key)?.value || 0)}</td>
                  <td>{fmt(stats.topModels.todayErrors.find((r) => r.key === row.key)?.value || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
        <article className="panel">
          <div className="panel-header"><h2 className="section-title">Model Usage All Time</h2></div>
          <table className="data-table">
            <thead><tr><th>Model</th><th>Tokens</th><th>Requests</th><th>Errors</th></tr></thead>
            <tbody>
              {stats.topModels.totalTokens.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--text-muted)' }}>No data.</td></tr>}
              {stats.topModels.totalTokens.map((row) => (
                <tr key={row.key}>
                  <td><code>{row.key}</code></td>
                  <td>{compact(row.value)}</td>
                  <td>{fmt(stats.topModels.totalRequests.find((r) => r.key === row.key)?.value || 0)}</td>
                  <td>{fmt(stats.topModels.totalErrors.find((r) => r.key === row.key)?.value || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </section>
    </div>
  );
}
