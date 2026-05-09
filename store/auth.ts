/**
 * store/auth.ts — Zustand global auth state
 *
 * Shared across all dashboard "use client" components.
 * Avoids each page having its own independent auth fetch.
 */
"use client";
import { create } from 'zustand';

interface AuthStore {
  /** null = not yet checked, true/false = result of /api/auth/me */
  isAuthenticated: boolean | null;
  isChecking: boolean;
  checkAuth: () => Promise<boolean>;
  setAuthenticated: (v: boolean) => void;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthStore>((set) => ({
  isAuthenticated: null,
  isChecking: false,

  checkAuth: async () => {
    set({ isChecking: true });
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      set({ isAuthenticated: res.ok, isChecking: false });
      return res.ok;
    } catch {
      set({ isAuthenticated: false, isChecking: false });
      return false;
    }
  },

  setAuthenticated: (v) => set({ isAuthenticated: v }),

  logout: async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    set({ isAuthenticated: false });
  },
}));
