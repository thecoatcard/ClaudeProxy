"use client";
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import '@/app/globals.css';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/stats', label: 'Usage & Stats' },
  { href: '/dashboard/keys', label: 'Provider Keys' },
  { href: '/dashboard/user-keys', label: 'Gateway Keys' },
  { href: '/dashboard/models', label: 'Model Routing' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <div className="brand-block">
          <p className="brand-eyebrow">Gateway Control</p>
          <h1 className="brand-title">CoatCard AI</h1>
        </div>
        <nav className="sidebar-nav" aria-label="Dashboard">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link key={item.href} href={item.href} className={`nav-link${active ? ' active' : ''}`}>
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="dashboard-main">{children}</main>
    </div>
  );
}
