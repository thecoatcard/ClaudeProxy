"use client";
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type StatsData = {
  requests: number;
  errors: number;
  avgLatency: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  today: {
    date: string;
    requests: number;
    errors: number;
    avgLatency: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  daily: Array<{
    date: string;
    requests: number;
    errors: number;
    avgLatency: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
  topModels: {
    totalRequests: Array<{ key: string; value: number }>;
    totalErrors: Array<{ key: string; value: number }>;
    totalTokens: Array<{ key: string; value: number }>;
    todayRequests: Array<{ key: string; value: number }>;
    todayErrors: Array<{ key: string; value: number }>;
    todayTokens: Array<{ key: string; value: number }>;
  };
};

function n(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(value || 0)));
}

function compact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, value || 0));
}

function percent(a: number, b: number): string {
  if (!b) return '0%';
  return `${((a / b) * 100).toFixed(2)}%`;
}

export default function StatsPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<StatsData | null>(null);

  const fetchStats = async () => {
    const res = await fetch('/api/admin/stats', { cache: 'no-store' });
    if (res.ok) {
      setStats(await res.json());
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
      await fetchStats();
      setLoading(false);
    };
    load();
  }, []);

  const topRows = useMemo(() => stats?.topModels?.todayTokens || [], [stats]);

  if (loading) return <div className="panel">Loading usage data...</div>;

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

  if (!stats) return <div className="panel">Could not load stats.</div>;

  return (
    <div className="dashboard-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Usage & Statistics</h1>
          <p className="muted-text">Daily token accounting and model-level utilization.</p>
        </div>
        <div className="toolbar-row">
          <button className="btn btn-primary" onClick={fetchStats}>Refresh</button>
        </div>
      </header>

      <section className="kpi-grid">
        <article className="kpi-card">
          <p className="kpi-label">Total Tokens</p>
          <p className="kpi-value">{compact(stats.totalTokens)}</p>
          <p className="kpi-subtle">{n(stats.inputTokens)} input / {n(stats.outputTokens)} output</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Total Requests</p>
          <p className="kpi-value">{n(stats.requests)}</p>
          <p className="kpi-subtle">Errors {n(stats.errors)}</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Error Rate</p>
          <p className="kpi-value">{percent(stats.errors, stats.requests)}</p>
          <p className="kpi-subtle">Today {percent(stats.today.errors, stats.today.requests)}</p>
        </article>
        <article className="kpi-card">
          <p className="kpi-label">Latency</p>
          <p className="kpi-value">{n(stats.avgLatency)} ms</p>
          <p className="kpi-subtle">Today {n(stats.today.avgLatency)} ms</p>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">Daily Usage (IST)</h2>
        </div>
        <table className="data-table">
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
            {stats.daily.map((day) => (
              <tr key={day.date}>
                <td>{day.date}</td>
                <td>{n(day.requests)}</td>
                <td>{n(day.errors)}</td>
                <td>{n(day.inputTokens)}</td>
                <td>{n(day.outputTokens)}</td>
                <td>{compact(day.totalTokens)}</td>
                <td>{n(day.avgLatency)} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel-grid two-col">
        <article className="panel">
          <div className="panel-header">
            <h2 className="section-title">Model Usage Today</h2>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Tokens</th>
                <th>Requests</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {topRows.length === 0 && <tr><td colSpan={4}>No model activity yet.</td></tr>}
              {topRows.map((row) => (
                <tr key={row.key}>
                  <td><code>{row.key}</code></td>
                  <td>{compact(row.value)}</td>
                  <td>{n(stats.topModels.todayRequests.find((r) => r.key === row.key)?.value || 0)}</td>
                  <td>{n(stats.topModels.todayErrors.find((r) => r.key === row.key)?.value || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <article className="panel">
          <div className="panel-header">
            <h2 className="section-title">Model Usage All Time</h2>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Tokens</th>
                <th>Requests</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {stats.topModels.totalTokens.length === 0 && <tr><td colSpan={4}>No data available.</td></tr>}
              {stats.topModels.totalTokens.map((row) => (
                <tr key={row.key}>
                  <td><code>{row.key}</code></td>
                  <td>{compact(row.value)}</td>
                  <td>{n(stats.topModels.totalRequests.find((r) => r.key === row.key)?.value || 0)}</td>
                  <td>{n(stats.topModels.totalErrors.find((r) => r.key === row.key)?.value || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </section>
    </div>
  );
}
