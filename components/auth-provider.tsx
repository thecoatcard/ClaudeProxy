"use client";
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

interface AuthContextValue {
  isAuthenticated: boolean | null;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  isAuthenticated: null,
  refresh: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/session/me', { cache: 'no-store' });
      setIsAuthenticated(res.ok);
    } catch {
      setIsAuthenticated(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ isAuthenticated, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}
