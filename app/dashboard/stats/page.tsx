"use client";
import { useState, useEffect } from 'react';
import Link from 'next/link';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export default function StatsPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      setIsAuthenticated(true);
      fetchStats();
    }
  };

  const fetchStats = async () => {
    const res = await fetch('/api/admin/stats', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      setStats(data);
    }
  };

  if (!isAuthenticated) {
    return (
      <div style={{ maxWidth: '400px', margin: '4rem auto', textAlign: 'center' }}>
        <p>You must be logged in to view this page.</p>
        <Link href="/dashboard/keys"><button className="btn" style={{ marginTop: '1rem' }}>Go to Login</button></Link>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>Statistics</h1>
        <button className="btn" onClick={fetchStats}>Refresh Stats</button>
      </div>

      {stats && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
            <div className="card" style={{ textAlign: 'center' }}>
              <h3>Total Requests</h3>
              <p style={{ fontSize: '3rem', fontWeight: 'bold', color: 'var(--accent)' }}>{stats.requests}</p>
            </div>
            <div className="card" style={{ textAlign: 'center' }}>
              <h3>Total Errors</h3>
              <p style={{ fontSize: '3rem', fontWeight: 'bold', color: 'var(--danger)' }}>{stats.errors}</p>
            </div>
            <div className="card" style={{ textAlign: 'center' }}>
              <h3>Avg Latency</h3>
              <p style={{ fontSize: '3rem', fontWeight: 'bold', color: 'var(--success)' }}>{stats.avgLatency} ms</p>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
            <div className="card" style={{ textAlign: 'center' }}>
              <h3>Input Tokens</h3>
              <p style={{ fontSize: '2rem', fontWeight: 'bold', color: 'var(--accent)' }}>{formatTokens(stats.inputTokens || 0)}</p>
            </div>
            <div className="card" style={{ textAlign: 'center' }}>
              <h3>Output Tokens</h3>
              <p style={{ fontSize: '2rem', fontWeight: 'bold', color: 'var(--accent)' }}>{formatTokens(stats.outputTokens || 0)}</p>
            </div>
            <div className="card" style={{ textAlign: 'center' }}>
              <h3>Total Tokens</h3>
              <p style={{ fontSize: '2rem', fontWeight: 'bold', color: 'var(--success)' }}>{formatTokens(stats.totalTokens || 0)}</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
