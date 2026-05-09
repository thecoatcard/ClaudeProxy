"use client";
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import '@/app/globals.css';

const NAV_ITEMS = [
  { href: '/dashboard',                 label: 'Overview',       icon: '⬡' },
  { href: '/dashboard/stats',           label: 'Observability',  icon: '📈' },
  { href: '/dashboard/activity',        label: 'Activity Feed',  icon: '📋' },
  { href: '/dashboard/keys',            label: 'Provider Keys',  icon: '🔑' },
  { href: '/dashboard/user-keys',       label: 'Gateway Keys',   icon: '🛡' },
  { href: '/dashboard/models',          label: 'Model Routing',  icon: '🔀' },
  { href: '/dashboard/orchestrator',    label: 'Orchestrator',   icon: '🤖' },
  { href: '/dashboard/system',          label: 'System',         icon: '⚙' },
];

interface LoginModalProps {
  onSuccess: () => void;
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
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (res.ok) {
      onSuccess();
    } else {
      setErr('Invalid credentials.');
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
        <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
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
  const pathname = usePathname();
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' }).then((r) => {
      setIsAuthenticated(r.ok);
    });
  }, []);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setIsAuthenticated(false);
  };

  const handleLoginSuccess = () => {
    setIsAuthenticated(true);
    setShowLogin(false);
  };

  return (
    <div className="dashboard-shell">
      {showLogin && (
        <LoginModal onSuccess={handleLoginSuccess} onClose={() => setShowLogin(false)} />
      )}

      <aside className="dashboard-sidebar">
        {/* Brand */}
        <div className="brand-block">
          <p className="brand-eyebrow">Gateway Control</p>
          <h1 className="brand-title">CoatCard AI</h1>
        </div>

        {/* Navigation */}
        <nav className="sidebar-nav-section" aria-label="Dashboard navigation">
          <div className="nav-group-label">Navigation</div>
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className={`nav-link${active ? ' active' : ''}`}>
                <span className="nav-link-icon">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Footer: auth state + actions */}
        <div className="sidebar-footer">
          {isAuthenticated === null ? (
            <div className="sidebar-user">Checking auth…</div>
          ) : isAuthenticated ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="status-dot status-dot-ok" />
                <span className="sidebar-user">Admin session active</span>
              </div>
              <button className="btn btn-sm" style={{ width: '100%' }} onClick={handleLogout}>
                Sign Out
              </button>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="status-dot status-dot-muted" />
                <span className="sidebar-user">Not signed in</span>
              </div>
              <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={() => setShowLogin(true)}>
                Sign In
              </button>
            </>
          )}
        </div>
      </aside>

      <main className="dashboard-main">
        {children}
      </main>
    </div>
  );
}

