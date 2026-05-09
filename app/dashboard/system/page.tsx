"use client";
import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/ui/toast';

type SystemData = {
  redis?: { ok: boolean; latencyMs?: number };
  keyPool?: { healthy: number; cooldown: number; disabled: number; revoked: number; total: number };
};

const ACTIONS = [
  {
    id: 'activate-all',
    title: 'Activate All Keys',
    desc: 'Reset cooldown state on all non-disabled provider keys. Safe to run at any time.',
    label: 'Activate All',
    variant: 'btn-ok',
    confirm: false,
  },
  {
    id: 'clear-failed',
    title: 'Clear Failed Keys',
    desc: 'Reset failure counters on all provider keys.',
    label: 'Clear Failed',
    variant: '',
    confirm: false,
  },
  {
    id: 'flush-caches',
    title: 'Flush Gemini Context Caches',
    desc: 'Delete all cached Gemini context prefixes. Requests will re-cache on next use.',
    label: 'Flush Caches',
    variant: 'btn-warn',
    confirm: true,
  },
  {
    id: 'reset-metrics',
    title: 'Reset All Metrics',
    desc: 'Delete 30 days of token/request/error stats. This is irreversible.',
    label: 'Reset Metrics',
    variant: 'btn-danger',
    confirm: true,
  },
  {
    id: 'clear-activity',
    title: 'Clear Activity Log',
    desc: 'Delete all activity log entries. The feed will be empty after this.',
    label: 'Clear Log',
    variant: 'btn-danger',
    confirm: true,
  },
] as const;

export default function SystemPage() {
  const { toast, ToastContainer } = useToast();
  const [auth, setAuth] = useState<boolean | null>(null);
  const [data, setData] = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    const res = await fetch('/api/admin/system', { cache: 'no-store' });
    if (res.ok) setData((await res.json()).data ?? null);
  }, []);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/auth/me');
      if (!res.ok) { setAuth(false); setLoading(false); return; }
      setAuth(true);
      await fetchStatus();
      setLoading(false);
    })();
  }, [fetchStatus]);

  const runAction = async (id: string, confirm_: boolean, label: string) => {
    if (confirm_ && !confirm(`Run "${label}"? This may be irreversible.`)) return;
    setBusy(id);
    const res = await fetch('/api/admin/system', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: id }),
    });
    setBusy(null);
    if (!res.ok) { toast.err(`Action failed: ${id}`); return; }
    const d = await res.json();
    toast.ok(d.message || `${label} complete.`);
    await fetchStatus();
  };

  if (loading) {
    return (
      <div className="dashboard-page">
        <div className="sk sk-card" style={{ height: 120 }} />
        <div className="sk sk-card" style={{ height: 300 }} />
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="panel" style={{ maxWidth: 440, margin: '60px auto', textAlign: 'center', padding: 32 }}>
        <h2 className="section-title" style={{ marginBottom: 8 }}>Authentication Required</h2>
        <p className="muted-text">Sign in from the sidebar to access system controls.</p>
      </div>
    );
  }

  const kp = data?.keyPool;

  return (
    <div className="dashboard-page">
      <ToastContainer />
      <header className="page-header">
        <div>
          <h1 className="page-title">System Controls</h1>
          <p className="muted-text">Gateway health, key pool status, and administrative actions.</p>
        </div>
        <button className="btn" onClick={fetchStatus}>↺ Refresh</button>
      </header>

      {/* Health status */}
      <section className="panel-grid two-col">
        <article className="panel">
          <div className="panel-header">
            <h2 className="section-title">Redis Health</h2>
          </div>
          {data?.redis ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className={`status-dot ${data.redis.ok ? 'status-dot-ok' : 'status-dot-bad'}`} />
              <span>{data.redis.ok ? 'Connected' : 'Unreachable'}</span>
              {data.redis.latencyMs !== undefined && (
                <span className="muted-text" style={{ marginLeft: 'auto' }}>{data.redis.latencyMs}ms</span>
              )}
            </div>
          ) : (
            <span className="muted-text">Unavailable</span>
          )}
        </article>

        <article className="panel">
          <div className="panel-header">
            <h2 className="section-title">Provider Key Pool</h2>
          </div>
          {kp ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {[
                { label: 'Healthy', val: kp.healthy, cls: 'status-dot-ok' },
                { label: 'Cooldown', val: kp.cooldown, cls: 'status-dot-warn' },
                { label: 'Disabled', val: kp.disabled, cls: 'status-dot-muted' },
                { label: 'Revoked', val: kp.revoked, cls: 'status-dot-bad' },
              ].map(({ label, val, cls }) => (
                <div key={label} style={{ textAlign: 'center' }}>
                  <span className={`status-dot ${cls}`} style={{ display: 'block', margin: '0 auto 4px' }} />
                  <div style={{ fontWeight: 600, fontSize: 18 }}>{val}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
                </div>
              ))}
            </div>
          ) : (
            <span className="muted-text">Unavailable</span>
          )}
        </article>
      </section>

      {/* Action cards */}
      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">Administrative Actions</h2>
          <span className="muted-text" style={{ fontSize: 12 }}>Destructive actions require confirmation.</span>
        </div>
        <div className="actions-grid">
          {ACTIONS.map((action) => (
            <div key={action.id} className="action-card">
              <div className="action-card-info">
                <div className="action-card-title">{action.title}</div>
                <div className="action-card-desc">{action.desc}</div>
              </div>
              <button
                className={`btn btn-sm ${action.variant}`}
                onClick={() => runAction(action.id, action.confirm, action.label)}
                disabled={busy === action.id}
                style={{ whiteSpace: 'nowrap' }}
              >
                {busy === action.id ? '…' : action.label}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
