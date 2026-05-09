"use client";
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';

type SubagentTaskView = {
  id: string;
  description: string;
  model: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  latencyMs: number | null;
  artifacts: string[];
  dependencies: string[];
};

type SessionView = {
  parentId: string;
  totalTasks: number;
  completed: number;
  failed: number;
  pending: number;
  tasks: SubagentTaskView[];
};

type PerformanceRow = {
  model: string;
  taskType: string;
  totalCalls: number;
  successRate: number;
  avgLatencyMs: number;
  failureRate: number;
};

type OrchestratorData = {
  sessions: SessionView[];
  performance: PerformanceRow[];
  generatedAt: string;
};

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: '#4ade80',
  FAILED: '#f87171',
  RUNNING: '#facc15',
  PENDING: '#94a3b8',
};

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}

function ms(v: number | null) {
  if (v === null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
}

export default function OrchestratorPage() {
  const { isAuthenticated } = useAuth();
  const [data, setData] = useState<OrchestratorData | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/orchestrator', { cache: 'no-store' });
      if (!res.ok) {
        setError(res.status === 401 ? 'Not authenticated — please sign in from the sidebar' : 'Failed to load');
        return;
      }
      const json: OrchestratorData = await res.json();
      setData(json);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated === null || !isAuthenticated) return;
    load();
  }, [isAuthenticated, load]);

  // Auto-refresh every 30s
  useEffect(() => {
    if (!isAuthenticated) return;
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [isAuthenticated, load]);

  return (
    <div style={{ padding: '24px', maxWidth: '1100px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '16px' }}>
        🤖 Orchestrator Monitor
      </h1>

      {/* Refresh button */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', alignItems: 'center' }}>
        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: '8px 20px',
            borderRadius: '6px',
            background: '#3b82f6',
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        {isAuthenticated === false && (
          <span style={{ color: '#f87171', fontSize: '0.85rem' }}>
            Sign in from the sidebar to view orchestrator data
          </span>
        )}
      </div>

      {error && (
        <div style={{ color: '#f87171', marginBottom: '16px' }}>{error}</div>
      )}

      {data && (
        <>
          <p style={{ color: '#64748b', fontSize: '0.8rem', marginBottom: '20px' }}>
            Last updated: {new Date(data.generatedAt).toLocaleTimeString()} — auto-refreshes every 30s
          </p>

          {/* ── Performance table ─────────────────────────────────────────── */}
          <section style={{ marginBottom: '32px' }}>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '12px' }}>
              Model Performance
            </h2>
            {data.performance.length === 0 ? (
              <p style={{ color: '#64748b' }}>No performance data yet — starts recording on first subagent execution.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #334155', color: '#94a3b8' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>Model</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>Role</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px' }}>Calls</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px' }}>Success</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px' }}>Avg Latency</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px' }}>Failure</th>
                  </tr>
                </thead>
                <tbody>
                  {data.performance.map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #1e293b' }}>
                      <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#93c5fd' }}>{row.model}</td>
                      <td style={{ padding: '6px 8px', color: '#94a3b8' }}>{row.taskType}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{row.totalCalls}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', color: '#4ade80' }}>{pct(row.successRate)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{ms(row.avgLatencyMs)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', color: row.failureRate > 0.1 ? '#f87171' : '#64748b' }}>{pct(row.failureRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ── Recent sessions ─────────────────────────────────────────────── */}
          <section>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '12px' }}>
              Recent Orchestration Sessions ({data.sessions.length})
            </h2>
            {data.sessions.length === 0 ? (
              <p style={{ color: '#64748b' }}>No orchestration sessions found.</p>
            ) : (
              data.sessions.map((session) => (
                <div
                  key={session.parentId}
                  style={{
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    marginBottom: '12px',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      background: '#1e293b',
                      cursor: 'pointer',
                    }}
                    onClick={() =>
                      setExpandedSession(
                        expandedSession === session.parentId ? null : session.parentId
                      )
                    }
                  >
                    <div>
                      <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: '#94a3b8' }}>
                        {session.parentId}
                      </span>
                      <span style={{ marginLeft: '12px', fontSize: '0.85rem' }}>
                        {session.totalTasks} tasks
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '10px', fontSize: '0.8rem' }}>
                      <span style={{ color: '#4ade80' }}>✓ {session.completed}</span>
                      {session.failed > 0 && (
                        <span style={{ color: '#f87171' }}>✗ {session.failed}</span>
                      )}
                      {session.pending > 0 && (
                        <span style={{ color: '#facc15' }}>⌛ {session.pending}</span>
                      )}
                      <span style={{ color: '#64748b' }}>{expandedSession === session.parentId ? '▲' : '▼'}</span>
                    </div>
                  </div>

                  {expandedSession === session.parentId && (
                    <div style={{ padding: '12px 14px' }}>
                      {session.tasks.map((task) => (
                        <div
                          key={task.id}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '10px',
                            padding: '6px 0',
                            borderBottom: '1px solid #1e293b',
                          }}
                        >
                          <span
                            style={{
                              display: 'inline-block',
                              width: '80px',
                              textAlign: 'center',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              fontSize: '0.7rem',
                              background: STATUS_COLOR[task.status] + '22',
                              color: STATUS_COLOR[task.status],
                              flexShrink: 0,
                            }}
                          >
                            {task.status}
                          </span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: '0.85rem' }}>{task.description}</div>
                            <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '2px' }}>
                              Model: <span style={{ color: '#93c5fd' }}>{task.model}</span>
                              {task.latencyMs !== null && (
                                <span style={{ marginLeft: '10px' }}>Latency: {ms(task.latencyMs)}</span>
                              )}
                              {task.dependencies.length > 0 && (
                                <span style={{ marginLeft: '10px' }}>Deps: {task.dependencies.length}</span>
                              )}
                              {task.artifacts.length > 0 && (
                                <span style={{ marginLeft: '10px' }}>Artifacts: {task.artifacts.length}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}
