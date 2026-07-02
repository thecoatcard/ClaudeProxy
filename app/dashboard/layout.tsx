"use client";
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import '@/app/globals.css';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { DashboardErrorBoundary } from '@/components/error-boundary';

const NAV_ITEMS = [
  { href: '/dashboard',                 label: 'Overview',       icon: '⬡' },
  { href: '/dashboard/stats',           label: 'Observability',  icon: '📈' },
  { href: '/dashboard/activity',        label: 'Activity Feed',  icon: '📋' },
  { href: '/dashboard/keys',            label: 'Provider Keys',  icon: '🔑' },
  { href: '/dashboard/user-keys',       label: 'Gateway Keys',   icon: '🛡' },
  { href: '/dashboard/models',          label: 'Model Routing',  icon: '🔀' },
  { href: '/dashboard/orchestrator',    label: 'Orchestrator',   icon: '🤖' },
  { href: '/dashboard/logs',            label: 'Logs',           icon: '📊' },
  { href: '/dashboard/system',          label: 'System',         icon: '⚙' },
];

interface LoginModalProps {
  onSuccess: () => void | Promise<void>;
  onClose: () => void;
}

function LoginModal({ onSuccess, onClose }: LoginModalProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/admin/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        await onSuccess();
      } else {
        const body = await res.json().catch(() => null);
        setErr(body?.error || 'Unable to sign in.');
      }
    } catch {
      setErr('Unable to reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="section-title">Admin Login</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="muted-text" style={{ marginBottom: 16 }}>
          Sign in to access gateway controls.
        </p>
        {err && <div className="alert alert-bad" style={{ marginBottom: 12 }}>{err}</div>}
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <input
            className="input"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardLayoutInner>{children}</DashboardLayoutInner>
    </AuthProvider>
  );
}

function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isAuthenticated, refresh } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>('system');
  const [navSearch, setNavSearch] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('theme') as 'dark' | 'light' | 'system' || 'system';
    setTheme(saved);
    applyTheme(saved);
  }, []);

  const applyTheme = (t: 'dark' | 'light' | 'system') => {
    const root = document.documentElement;
    root.classList.remove('theme-light', 'theme-dark');
    if (t === 'system') {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.add(isDark ? 'theme-dark' : 'theme-light');
    } else {
      root.classList.add(`theme-${t}`);
    }
  };

  const handleThemeChange = (newTheme: 'dark' | 'light' | 'system') => {
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    applyTheme(newTheme);
  };

  const handleLogout = async () => {
    await fetch('/api/admin/session/logout', { method: 'POST' });
    refresh();
  };

  const handleLoginSuccess = async () => {
    await refresh();
    setShowLogin(false);
  };

  const filteredNavItems = NAV_ITEMS.filter((item) =>
    item.label.toLowerCase().includes(navSearch.toLowerCase())
  );

  // Generate breadcrumbs from pathname
  const segments = pathname.split('/').filter(Boolean);
  const breadcrumbs = segments.map((seg, i) => {
    const href = '/' + segments.slice(0, i + 1).join('/');
    const label = seg === 'dashboard' ? 'Home' : seg.charAt(0).toUpperCase() + seg.slice(1);
    return { href, label };
  });

  return (
    <div className="dashboard-shell" style={{
      gridTemplateColumns: sidebarCollapsed ? '72px minmax(0, 1fr)' : '260px minmax(0, 1fr)',
      transition: 'grid-template-columns 0.3s ease'
    }}>
      {showLogin && (
        <LoginModal onSuccess={handleLoginSuccess} onClose={() => setShowLogin(false)} />
      )}

      <aside className="dashboard-sidebar" style={{
        padding: sidebarCollapsed ? '24px 8px' : '24px 16px',
        alignItems: sidebarCollapsed ? 'center' : 'stretch'
      }}>
        {/* Brand */}
        <div className="brand-block" style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: sidebarCollapsed ? '0' : '0 12px',
          marginBottom: '16px'
        }}>
          {!sidebarCollapsed && (
            <div>
              <p className="brand-eyebrow">Gateway Control</p>
              <h1 className="brand-title">CoatCard AI</h1>
            </div>
          )}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="btn-xs"
            style={{
              padding: '6px 8px',
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--line)',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
            title={sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          >
            {sidebarCollapsed ? '→' : '←'}
          </button>
        </div>

        {/* Sidebar Search */}
        {!sidebarCollapsed && (
          <div style={{ padding: '0 12px', marginBottom: '16px' }}>
            <input
              type="text"
              placeholder="Quick search..."
              value={navSearch}
              onChange={(e) => setNavSearch(e.target.value)}
              className="search-input"
              style={{
                minHeight: '32px',
                fontSize: '12px',
                borderRadius: 'var(--radius-sm)'
              }}
            />
          </div>
        )}

        {/* Navigation */}
        <nav className="sidebar-nav-section" aria-label="Dashboard navigation">
          {!sidebarCollapsed && <div className="nav-group-label">Navigation</div>}
          {filteredNavItems.map((item) => {
            const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link${active ? ' active' : ''}`}
                style={{
                  justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                  padding: sidebarCollapsed ? '10px 0' : '8px 12px'
                }}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <span className="nav-link-icon" style={{ margin: sidebarCollapsed ? '0' : '0 10px 0 0' }}>{item.icon}</span>
                {!sidebarCollapsed && item.label}
              </Link>
            );
          })}
        </nav>

        {/* Footer: auth state + actions */}
        <div className="sidebar-footer">
          {/* Theme Switcher */}
          {!sidebarCollapsed && (
            <div className="theme-toggle-row" style={{
              display: 'flex',
              gap: 4,
              background: 'var(--bg-elev-2)',
              padding: 4,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--line)'
            }}>
              {(['dark', 'light', 'system'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => handleThemeChange(t)}
                  className={`btn-xs`}
                  style={{
                    flex: 1,
                    textAlign: 'center',
                    padding: '4px 0',
                    borderRadius: 6,
                    fontSize: '11px',
                    background: theme === t ? 'var(--bg-elev-1)' : 'transparent',
                    border: 'none',
                    color: theme === t ? 'var(--text)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: theme === t ? '600' : '400'
                  }}
                >
                  {t === 'dark' ? '🌙' : t === 'light' ? '☀️' : '💻'}
                </button>
              ))}
            </div>
          )}

          {isAuthenticated === null ? (
            <div className="sidebar-user" style={{ textAlign: sidebarCollapsed ? 'center' : 'left' }}>Checking auth…</div>
          ) : isAuthenticated ? (
            <>
              {!sidebarCollapsed && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px' }}>
                  <span className="status-dot status-dot-ok" />
                  <span className="sidebar-user">Admin Active</span>
                </div>
              )}
              <button
                className="btn btn-sm"
                style={{ width: '100%', padding: sidebarCollapsed ? '6px 0' : '6px 12px' }}
                onClick={handleLogout}
              >
                {sidebarCollapsed ? '✕' : 'Sign Out'}
              </button>
            </>
          ) : (
            <>
              {!sidebarCollapsed && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px' }}>
                  <span className="status-dot status-dot-muted" />
                  <span className="sidebar-user">Not signed in</span>
                </div>
              )}
              <button
                className="btn btn-primary btn-sm"
                style={{ width: '100%', padding: sidebarCollapsed ? '6px 0' : '6px 12px' }}
                onClick={() => setShowLogin(true)}
              >
                {sidebarCollapsed ? '🔑' : 'Sign In'}
              </button>
            </>
          )}
        </div>
      </aside>

      <main className="dashboard-main">
        {/* Breadcrumbs Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: '12px',
          color: 'var(--text-muted)',
          marginBottom: '-8px'
        }}>
          {breadcrumbs.map((bc, idx) => (
            <span key={bc.href} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {idx > 0 && <span>/</span>}
              <Link href={bc.href} style={{
                color: idx === breadcrumbs.length - 1 ? 'var(--text)' : 'inherit',
                fontWeight: idx === breadcrumbs.length - 1 ? '600' : '400'
              }}>
                {bc.label}
              </Link>
            </span>
          ))}
        </div>

        <DashboardErrorBoundary>
          {children}
        </DashboardErrorBoundary>
      </main>
    </div>
  );
}
