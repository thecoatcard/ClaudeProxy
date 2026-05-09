"use client";
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';

// ─── Types ───────────────────────────────────────────────────────────────────

type EventLog = {
  id: string;
  requestId?: string;
  parentTaskId?: string;
  subTaskId?: string;
  category: string;
  event: string;
  severity: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  timestamp: number;
  duration?: number;
  metadata?: Record<string, unknown>;
};

type TimelineEntry = {
  timestamp: number;
  phase: string;
  event: string;
  duration?: number;
  metadata?: Record<string, unknown>;
};

type EventSummary = {
  total: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
};

type ModelStats = {
  model: string;
  requests: number;
  errors: number;
  overloads: number;
  fallbacks: number;
  avgLatencyMs: number;
};

type KeyStats = {
  keyId: string;
  usage: number;
  cooldowns: number;
  restores: number;
  failures: number;
  health: 'healthy' | 'degraded' | 'cooldown';
};

type Tab = 'events' | 'models' | 'keys';

// ─── Colors ──────────────────────────────────────────────────────────────────

const SEVERITY_COLORS: Record<string, string> = {
  INFO: '#38bdf8',
  WARN: '#fbbf24',
  ERROR: '#ef4444',
  CRITICAL: '#c084fc',
};

const SEVERITY_BG: Record<string, string> = {
  INFO: 'rgba(56, 189, 248, 0.1)',
  WARN: 'rgba(251, 191, 36, 0.1)',
  ERROR: 'rgba(239, 68, 68, 0.1)',
  CRITICAL: 'rgba(192, 132, 252, 0.15)',
};

const CATEGORY_COLORS: Record<string, string> = {
  ORCHESTRATOR: '#818cf8',
  ROUTING: '#34d399',
  RETRY: '#fbbf24',
  OVERLOAD: '#f87171',
  KEY_ROTATION: '#a78bfa',
  WEB_SEARCH: '#2dd4bf',
  COMPACTION: '#f472b6',
  SUBAGENT: '#60a5fa',
  RECOVERY: '#fb923c',
  ACTIVITY: '#4ade80',
  STREAM: '#38bdf8',
  AUTH: '#94a3b8',
  MEMORY: '#c084fc',
  RETRIEVAL: '#22c55e',
  MODEL_CALL: '#a78bfa',
  SYSTEM: '#64748b',
};

const HEALTH_COLORS: Record<string, string> = {
  healthy: '#4ade80',
  degraded: '#fbbf24',
  cooldown: '#f87171',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('en-IN', { hour12: false, fractionalSecondDigits: 1 });
}

function formatDuration(ms: number | undefined) {
  if (!ms) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function ago(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  return `${Math.round(diff / 3600000)}h ago`;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: '#1e293b',
  borderRadius: '8px',
  padding: '16px',
  marginBottom: '12px',
  border: '1px solid #334155',
};

const badge = (color: string): React.CSSProperties => ({
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: '4px',
  fontSize: '0.7rem',
  fontWeight: 600,
  background: color + '22',
  color,
  border: `1px solid ${color}44`,
});

const filterBtn = (active: boolean): React.CSSProperties => ({
  padding: '4px 12px',
  borderRadius: '4px',
  fontSize: '0.8rem',
  border: active ? '1px solid #3b82f6' : '1px solid #475569',
  background: active ? '#3b82f6' : 'transparent',
  color: active ? '#fff' : '#94a3b8',
  cursor: 'pointer',
});

// ─── Components ──────────────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
  return <span style={badge(SEVERITY_COLORS[severity] || '#64748b')}>{severity}</span>;
}

function CategoryChip({ category }: { category: string }) {
  return <span style={badge(CATEGORY_COLORS[category] || '#64748b')}>{category}</span>;
}

function EventRow({ event, onClickRequest }: { event: EventLog; onClickRequest: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        ...card,
        background: SEVERITY_BG[event.severity] || '#1e293b',
        padding: '10px 14px',
        marginBottom: '4px',
        cursor: event.metadata ? 'pointer' : 'default',
      }}
      onClick={() => event.metadata && setExpanded(!expanded)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ color: '#64748b', fontSize: '0.75rem', minWidth: '80px' }}>
          {formatTime(event.timestamp)}
        </span>
        <SeverityBadge severity={event.severity} />
        <CategoryChip category={event.category} />
        <span style={{ color: '#e2e8f0', fontSize: '0.85rem', flex: 1 }}>
          {event.event}
        </span>
        {event.duration && (
          <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>
            {formatDuration(event.duration)}
          </span>
        )}
        {event.requestId && (
          <button
            onClick={(e) => { e.stopPropagation(); onClickRequest(event.requestId!); }}
            style={{
              background: 'transparent',
              border: '1px solid #475569',
              color: '#60a5fa',
              borderRadius: '4px',
              padding: '2px 6px',
              fontSize: '0.7rem',
              cursor: 'pointer',
            }}
          >
            req:{event.requestId.slice(0, 8)}
          </button>
        )}
      </div>
      {expanded && event.metadata && (
        <pre style={{
          marginTop: '8px',
          padding: '8px',
          background: '#0f172a',
          borderRadius: '4px',
          fontSize: '0.75rem',
          color: '#94a3b8',
          overflow: 'auto',
          maxHeight: '200px',
        }}>
          {JSON.stringify(event.metadata, null, 2)}
        </pre>
      )}
    </div>
  );
}

function TimelineView({ requestId, onBack }: { requestId: string; onBack: () => void }) {
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [duration, setDuration] = useState<number | null>(null);
  const [phases, setPhases] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/admin/logs?view=timeline&requestId=${encodeURIComponent(requestId)}`)
      .then(r => r.json())
      .then(data => {
        setTimeline(data.timeline || []);
        setDuration(data.duration);
        setPhases(data.phases);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [requestId]);

  const PHASE_COLORS: Record<string, string> = {
    REQUEST_STARTED: '#38bdf8',
    AUTH_VALIDATED: '#94a3b8',
    ORCHESTRATOR_ASSIGNED: '#818cf8',
    ROUTING_RESOLVED: '#34d399',
    SUBAGENT_STARTED: '#60a5fa',
    TOOL_EXECUTION: '#2dd4bf',
    MODEL_CALL: '#a78bfa',
    RETRY_TRIGGERED: '#fbbf24',
    FALLBACK_USED: '#fb923c',
    OVERLOAD_RECOVERY: '#f87171',
    COMPACTION: '#f472b6',
    WEB_SEARCH: '#2dd4bf',
    MERGE_COMPLETED: '#4ade80',
    STREAM_STARTED: '#38bdf8',
    REQUEST_COMPLETED: '#4ade80',
    REQUEST_FAILED: '#ef4444',
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={onBack} style={{
          background: 'transparent', border: '1px solid #475569', color: '#94a3b8',
          borderRadius: '4px', padding: '4px 12px', cursor: 'pointer',
        }}>← Back</button>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#e2e8f0' }}>
          Request Timeline: {requestId.slice(0, 12)}…
        </h2>
        {duration !== null && (
          <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
            Total: {formatDuration(duration)}
          </span>
        )}
      </div>

      {phases && (
        <div style={{ ...card, display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {phases.hasRetries && <span style={badge('#fbbf24')}>Has Retries</span>}
          {phases.hasFallbacks && <span style={badge('#fb923c')}>Has Fallbacks</span>}
          {phases.hasOverload && <span style={badge('#f87171')}>Overload Recovery</span>}
          {phases.hasWebSearch && <span style={badge('#2dd4bf')}>Web Search</span>}
          {phases.hasCompaction && <span style={badge('#f472b6')}>Compaction</span>}
        </div>
      )}

      {loading ? (
        <p style={{ color: '#94a3b8' }}>Loading timeline…</p>
      ) : timeline.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>No events found for this request.</p>
      ) : (
        <div style={{ position: 'relative', paddingLeft: '24px' }}>
          {/* Vertical line */}
          <div style={{
            position: 'absolute', left: '8px', top: '4px', bottom: '4px',
            width: '2px', background: '#334155',
          }} />

          {timeline.map((entry, i) => (
            <div key={i} style={{ position: 'relative', marginBottom: '8px' }}>
              {/* Dot */}
              <div style={{
                position: 'absolute', left: '-20px', top: '8px',
                width: '10px', height: '10px', borderRadius: '50%',
                background: PHASE_COLORS[entry.phase] || '#64748b',
                border: '2px solid #0f172a',
              }} />

              <div style={{
                ...card, marginBottom: '0', padding: '8px 12px',
                borderLeft: `3px solid ${PHASE_COLORS[entry.phase] || '#64748b'}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ color: '#64748b', fontSize: '0.75rem', minWidth: '80px' }}>
                    {formatTime(entry.timestamp)}
                  </span>
                  <span style={badge(PHASE_COLORS[entry.phase] || '#64748b')}>
                    {entry.phase.replace(/_/g, ' ')}
                  </span>
                  <span style={{ color: '#e2e8f0', fontSize: '0.85rem', flex: 1 }}>
                    {entry.event}
                  </span>
                  {entry.duration && (
                    <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>
                      {formatDuration(entry.duration)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelCard({ model }: { model: ModelStats }) {
  const errorRate = model.requests > 0 ? ((model.errors / model.requests) * 100).toFixed(1) : '0';
  return (
    <div style={{
      ...card,
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      gap: '12px',
    }}>
      <div style={{ gridColumn: '1 / -1' }}>
        <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.95rem' }}>
          {model.model}
        </span>
      </div>
      <div>
        <div style={{ color: '#64748b', fontSize: '0.75rem' }}>Requests</div>
        <div style={{ color: '#e2e8f0', fontSize: '1.2rem', fontWeight: 600 }}>{model.requests}</div>
      </div>
      <div>
        <div style={{ color: '#64748b', fontSize: '0.75rem' }}>Errors</div>
        <div style={{ color: model.errors > 0 ? '#f87171' : '#4ade80', fontSize: '1.2rem', fontWeight: 600 }}>
          {model.errors} <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>({errorRate}%)</span>
        </div>
      </div>
      <div>
        <div style={{ color: '#64748b', fontSize: '0.75rem' }}>Avg Latency</div>
        <div style={{ color: '#e2e8f0', fontSize: '1.2rem', fontWeight: 600 }}>
          {formatDuration(model.avgLatencyMs) || '—'}
        </div>
      </div>
      <div>
        <div style={{ color: '#64748b', fontSize: '0.75rem' }}>Overloads</div>
        <div style={{ color: model.overloads > 0 ? '#fbbf24' : '#94a3b8', fontSize: '1rem' }}>
          {model.overloads}
        </div>
      </div>
      <div>
        <div style={{ color: '#64748b', fontSize: '0.75rem' }}>Fallbacks</div>
        <div style={{ color: model.fallbacks > 0 ? '#fb923c' : '#94a3b8', fontSize: '1rem' }}>
          {model.fallbacks}
        </div>
      </div>
    </div>
  );
}

function KeyCard({ keyData }: { keyData: KeyStats }) {
  return (
    <div style={{
      ...card,
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      gap: '12px',
    }}>
      <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ color: '#e2e8f0', fontWeight: 600, fontFamily: 'monospace' }}>
          {keyData.keyId}
        </span>
        <span style={{
          ...badge(HEALTH_COLORS[keyData.health]),
          textTransform: 'uppercase',
        }}>
          {keyData.health}
        </span>
      </div>
      <div>
        <div style={{ color: '#64748b', fontSize: '0.75rem' }}>Usage</div>
        <div style={{ color: '#e2e8f0', fontSize: '1.1rem', fontWeight: 600 }}>{keyData.usage}</div>
      </div>
      <div>
        <div style={{ color: '#64748b', fontSize: '0.75rem' }}>Cooldowns</div>
        <div style={{ color: keyData.cooldowns > 0 ? '#fbbf24' : '#94a3b8', fontSize: '1.1rem' }}>
          {keyData.cooldowns}
        </div>
      </div>
      <div>
        <div style={{ color: '#64748b', fontSize: '0.75rem' }}>Failures</div>
        <div style={{ color: keyData.failures > 0 ? '#f87171' : '#4ade80', fontSize: '1.1rem' }}>
          {keyData.failures}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function LogsPage() {
  const { isAuthenticated } = useAuth();
  const [tab, setTab] = useState<Tab>('events');
  const [events, setEvents] = useState<EventLog[]>([]);
  const [models, setModels] = useState<ModelStats[]>([]);
  const [keys, setKeys] = useState<KeyStats[]>([]);
  const [summary, setSummary] = useState<EventSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Filters
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [severityFilter, setSeverityFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Request detail view
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ view: 'events', limit: '200' });
      if (categoryFilter) params.set('category', categoryFilter);
      if (severityFilter) params.set('severity', severityFilter);
      if (searchQuery) params.set('search', searchQuery);

      const res = await fetch(`/api/admin/logs?${params}`, { cache: 'no-store' });
      if (!res.ok) {
        setError(res.status === 401 ? 'Not authenticated' : 'Failed to load');
        return;
      }
      const data = await res.json();
      setEvents(data.events || []);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, isAuthenticated, severityFilter, searchQuery]);

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/logs?view=summary', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setSummary(data.summary);
      }
    } catch { /* ignore */ }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/logs?view=models', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setModels(data.models || []);
      }
    } catch { /* ignore */ }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/logs?view=keys', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setKeys(data.keys || []);
      }
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(async () => {
    if (!isAuthenticated) return;
    if (tab === 'events') {
      await Promise.all([loadEvents(), loadSummary()]);
    } else if (tab === 'models') {
      await loadModels();
    } else if (tab === 'keys') {
      await loadKeys();
    }
  }, [isAuthenticated, tab, loadEvents, loadSummary, loadModels, loadKeys]);

  useEffect(() => { if (isAuthenticated) load(); }, [isAuthenticated, load]);

  // Auto-refresh every 30s (reduced from 5s to prevent runtime overhead)
  useEffect(() => {
    if (!autoRefresh || !isAuthenticated) return;
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, isAuthenticated, load]);

  // If viewing a request detail, show timeline
  if (selectedRequestId) {
    return (
      <div style={{ padding: '24px', maxWidth: '1100px', margin: '0 auto', color: '#e2e8f0' }}>
        <TimelineView requestId={selectedRequestId} onBack={() => setSelectedRequestId(null)} />
      </div>
    );
  }

  const categories = [
    'ORCHESTRATOR', 'ROUTING', 'RETRY', 'OVERLOAD', 'KEY_ROTATION',
    'WEB_SEARCH', 'COMPACTION', 'RETRIEVAL', 'MODEL_CALL', 'SUBAGENT', 'RECOVERY', 'STREAM',
  ];

  return (
    <div style={{ padding: '24px', maxWidth: '1100px', margin: '0 auto', color: '#e2e8f0' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '16px' }}>
        📊 Observability Dashboard
      </h1>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
        {(['events', 'models', 'keys'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 20px',
              borderRadius: '6px 6px 0 0',
              background: tab === t ? '#1e293b' : 'transparent',
              color: tab === t ? '#e2e8f0' : '#64748b',
              border: tab === t ? '1px solid #334155' : '1px solid transparent',
              borderBottom: tab === t ? '1px solid #1e293b' : '1px solid #334155',
              cursor: 'pointer',
              fontWeight: tab === t ? 600 : 400,
              textTransform: 'capitalize',
            }}
          >
            {t === 'events' ? '📋 Events' : t === 'models' ? '🤖 Models' : '🔑 Keys'}
          </button>
        ))}
        <div style={{ flex: 1, borderBottom: '1px solid #334155' }} />
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: '6px 16px', borderRadius: '6px',
            background: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer',
          }}
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#94a3b8', fontSize: '0.8rem' }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={e => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh (30s)
        </label>
        {isAuthenticated === false && (
          <span style={{ color: '#f87171', fontSize: '0.85rem' }}>
            Sign in from the sidebar to view logs
          </span>
        )}
        {error && <span style={{ color: '#f87171', fontSize: '0.85rem' }}>{error}</span>}
      </div>

      {/* Events tab */}
      {tab === 'events' && (
        <>
          {/* Summary cards */}
          {summary && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginBottom: '16px' }}>
              <div style={card}>
                <div style={{ color: '#64748b', fontSize: '0.75rem' }}>Total Events</div>
                <div style={{ color: '#e2e8f0', fontSize: '1.4rem', fontWeight: 700 }}>{summary.total}</div>
              </div>
              {Object.entries(summary.bySeverity).map(([sev, count]) => (
                <div key={sev} style={card}>
                  <div style={{ color: '#64748b', fontSize: '0.75rem' }}>{sev}</div>
                  <div style={{ color: SEVERITY_COLORS[sev] || '#e2e8f0', fontSize: '1.4rem', fontWeight: 700 }}>
                    {count}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Filters */}
          <div style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '8px' }}>
              <button onClick={() => setSeverityFilter('')} style={filterBtn(!severityFilter)}>All</button>
              {['INFO', 'WARN', 'ERROR', 'CRITICAL'].map(s => (
                <button key={s} onClick={() => setSeverityFilter(s)} style={filterBtn(severityFilter === s)}>
                  {s}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '8px' }}>
              <button onClick={() => setCategoryFilter('')} style={filterBtn(!categoryFilter)}>All Categories</button>
              {categories.map(c => (
                <button key={c} onClick={() => setCategoryFilter(c)} style={filterBtn(categoryFilter === c)}>
                  {c}
                </button>
              ))}
            </div>
            <input
              type="text"
              placeholder="Search events…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{
                padding: '6px 12px', borderRadius: '6px', width: '100%',
                background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0',
                fontSize: '0.85rem',
              }}
            />
          </div>

          {/* Event list */}
          <div style={{ maxHeight: '600px', overflow: 'auto' }}>
            {events.length === 0 && !loading && (
              <p style={{ color: '#64748b', textAlign: 'center', padding: '40px' }}>
                No events found. Events will appear here as requests flow through the gateway.
              </p>
            )}
            {events.map(evt => (
              <EventRow key={evt.id} event={evt} onClickRequest={setSelectedRequestId} />
            ))}
          </div>
        </>
      )}

      {/* Models tab */}
      {tab === 'models' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '12px' }}>
          {models.length === 0 && !loading && (
            <p style={{ color: '#64748b', textAlign: 'center', padding: '40px', gridColumn: '1 / -1' }}>
              No model data available yet.
            </p>
          )}
          {models.map(m => <ModelCard key={m.model} model={m} />)}
        </div>
      )}

      {/* Keys tab */}
      {tab === 'keys' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '12px' }}>
          {keys.length === 0 && !loading && (
            <p style={{ color: '#64748b', textAlign: 'center', padding: '40px', gridColumn: '1 / -1' }}>
              No key health data available yet.
            </p>
          )}
          {keys.map(k => <KeyCard key={k.keyId} keyData={k} />)}
        </div>
      )}
    </div>
  );
}
