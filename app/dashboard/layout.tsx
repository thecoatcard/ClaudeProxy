"use client";
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import '@/app/globals.css';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  
  return (
    <div className="dashboard-layout">
      <aside className="sidebar">
        <h1>CoatCard Gateway</h1>
        <nav>
          <Link href="/dashboard/keys" className={pathname === '/dashboard/keys' ? 'active' : ''}>
            Provider Keys
          </Link>
          <Link href="/dashboard/user-keys" className={pathname === '/dashboard/user-keys' ? 'active' : ''}>
            User Keys
          </Link>
          <Link href="/dashboard/models" className={pathname === '/dashboard/models' ? 'active' : ''}>
            Model Routing
          </Link>
          <Link href="/dashboard/stats" className={pathname === '/dashboard/stats' ? 'active' : ''}>
            Statistics
          </Link>
        </nav>
      </aside>
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
