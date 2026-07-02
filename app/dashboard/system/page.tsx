"use client";
import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/components/auth-provider';

type SystemData = {
  redis?: { ok: boolean; latencyMs?: number };
  keyPool?: { healthy: number; cooldown: number; disabled: number; revoked: number; total: number };
  settings?: { racingEnabled: boolean };
};

const ACTIONS = [
  {
    id: 'activate-all',
    title: 'Activate All Keys',
    desc: 'Reset cooldown state on all non-disabled provider keys in the pool.',
    label: 'Activate All',
    variant: 'btn-ok',
    confirm: false,
  },
  {
    id: 'clear-failed',
    title: 'Clear Failed Keys',
    desc: 'Reset failure counters on all provider keys back to zero.',
    label: 'Clear Failed',
    variant: '',
    confirm: false,
  },
  {
    id: 'flush-caches',
    title: 'Flush Gemini Context Caches',
    desc: 'Delete cached Gemini context prefixes. Will re-cache on next model query.',
    label: 'Flush Caches',
    variant: 'btn-warn',
    confirm: true,
  },
  {
    id: 'reset-metrics',
    title: 'Reset Observability Metrics',
    desc: 'Delete all token/request/error stats. Irreversible.',
    label: 'Reset Metrics',
    variant: 'btn-danger',
    confirm: true,
  },
  {
    id: 'clear-activity',
    title: 'Clear Activity Log Feed',
    desc: 'Empty the main dashboard activity feed history permanently.',
    label: 'Clear Log',
    variant: 'btn-danger',
    confirm: true,
  },
] as const;

export default function SystemPage() {
  const { toast, ToastContainer } = useToast();
  const { isAuthenticated } = useAuth();
  const [data, setData] = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    const res = await fetch('/api/admin/system', { cache: 'no-store' });
    if (res.ok) setData((await res.json()).data ?? null);
  }, []);

  useEffect(() => {
    if (isAuthenticated === null) return;
    if (!isAuthenticated) { setLoading(false); return; }
    (async () => {
      await fetchStatus();
      setLoading(false);
    })();
  }, [fetchStatus, isAuthenticated]);

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

  const toggleRacing = async () => {
    const enabled = !(data?.settings?.racingEnabled ?? false);
    setBusy('toggle-racing');
    const res = await fetch('/api/admin/system', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update-settings', racingEnabled: enabled }),
    });
    setBusy(null);
    if (!res.ok) {
      toast.err('Failed to update racing setting.');
      return;
    }
    const payload = await res.json();
    toast.ok(payload.message || `Racing ${enabled ? 'enabled' : 'disabled'}.`);
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

  if (!isAuthenticated) {
    return (
      <div className="panel" style={{ maxWidth: 440, margin: '60px auto', textAlign: 'center', padding: 32 }}>
        <h2 className="section-title" style={{ marginBottom: 12 }}>Authentication Required</h2>
        <p className="muted-text">Sign in from the sidebar to access system controls.</p>
      </div>
    );
  }

  const kp = data?.keyPool;
  const racingEnabled = data?.settings?.racingEnabled ?? false;

  return (
    <div className="dashboard-page">
      <ToastContainer />
      <header className="page-header" style={{ border: 'none', paddingBottom: 0 }}>
        <div>
          <p className="brand-eyebrow" style={{ fontSize: '13px', color: 'var(--primary)' }}>Admin Operations</p>
          <h1 className="page-title" style={{ fontSize: '32px' }}>System Controls</h1>
          <p className="muted-text">Gateway status, parallel racing toggle, and administrative maintenance tools.</p>
        </div>
        <button className="btn" onClick={fetchStatus}>↺ Refresh Status</button>
      </header>

      {/* Health status grids */}
      <section className="panel-grid two-col">
        <article className="panel">
          <div className="panel-header" style={{ marginBottom: '16px' }}>
            <h2 className="section-title">Redis Status</h2>
          </div>
          {data?.redis ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-elev-2)', padding: '16px', borderRadius: 'var(--radius)', border: '1px solid var(--line)' }}>
              <span className={`status-dot ${data.redis.ok ? 'status-dot-ok' : 'status-dot-bad'}`} style={{ width: '12px', height: '12px' }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>{data.redis.ok ? 'Online & Linked' : 'Offline / Error'}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Caching and key pools are synchronized</div>
              </div>
              {data.redis.latencyMs !== undefined && (
                <span style={{ marginLeft: 'auto', fontWeight: 'bold', fontSize: '14px', color: 'var(--primary)' }}>{data.redis.latencyMs} ms</span>
              )}
            </div>
          ) : (
            <span className="muted-text">Status telemetry is unavailable</span>
          )}
        </article>

        <article className="panel">
          <div className="panel-header" style={{ marginBottom: '16px' }}>
            <h2 className="section-title">Key Pool Status</h2>
          </div>
          {kp ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, background: 'var(--bg-elev-2)', padding: '16px', borderRadius: 'var(--radius)', border: '1px solid var(--line)' }}>
              {[
                { label: 'Healthy', val: kp.healthy, cls: 'status-dot-ok' },
                { label: 'Cooldown', val: kp.cooldown, cls: 'status-dot-warn' },
                { label: 'Disabled', val: kp.disabled, cls: 'status-dot-muted' },
                { label: 'Revoked', val: kp.revoked, cls: 'status-dot-bad' },
              ].map(({ label, val, cls }) => (
                <div key={label} style={{ textAlign: 'center' }}>
                  <span className={`status-dot ${cls}`} style={{ display: 'block', margin: '0 auto 6px' }} />
                  <div style={{ fontWeight: 700, fontSize: '20px', letterSpacing: '-0.02em' }}>{val}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>{label}</div>
                </div>
              ))}
            </div>
          ) : (
            <span className="muted-text">Status telemetry is unavailable</span>
          )}
        </article>
      </section>

      {/* Model Racing Engine controls */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="section-title">Cognitive Routing Control</h2>
            <p className="muted-text" style={{ fontSize: '12px' }}>Configure parallel latency racing across key subsets</p>
          </div>
        </div>
        <div className="action-card" style={{ padding: '20px', background: 'var(--bg-elev-2)' }}>
          <div className="action-card-info">
            <div className="action-card-title" style={{ fontSize: '16px', fontWeight: 700 }}>Parallel Key &amp; Model Racing</div>
            <div className="action-card-desc" style={{ fontSize: '13px' }}>
              {racingEnabled
                ? 'Racing is currently ENABLED. Requests will race multiple keys simultaneously for maximum speed.'
                : 'Racing is currently DISABLED. Requests will follow a serial failover path on key pools.'}
            </div>
          </div>
          <button
            className={`btn ${racingEnabled ? 'btn-warn' : 'btn-ok'}`}
            onClick={toggleRacing}
            disabled={busy === 'toggle-racing'}
            style={{ minWidth: '130px' }}
          >
            {busy === 'toggle-racing' ? 'Updating…' : racingEnabled ? 'Disable Racing' : 'Enable Racing'}
          </button>
        </div>
      </section>

      {/* Administrative Action cards */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="section-title">Administrative Actions</h2>
            <p className="muted-text" style={{ fontSize: '12px' }}>Operational controls for database maintenance</p>
          </div>
        </div>
        <div className="actions-grid">
          {ACTIONS.map((action) => (
            <div key={action.id} className="action-card" style={{ padding: '16px' }}>
              <div className="action-card-info">
                <div className="action-card-title" style={{ fontWeight: 600 }}>{action.title}</div>
                <div className="action-card-desc">{action.desc}</div>
              </div>
              <button
                className={`btn btn-sm ${action.variant}`}
                onClick={() => runAction(action.id, action.confirm, action.label)}
                disabled={busy === action.id}
                style={{ minWidth: '120px' }}
              >
                {busy === action.id ? 'Running…' : action.label}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
