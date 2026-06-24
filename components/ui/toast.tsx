"use client";
/**
 * components/ui/toast.tsx
 *
 * Lightweight toast notification system.
 * Usage:
 *   const { toast, ToastContainer } = useToast();
 *   toast.ok('Saved!');
 *   toast.err('Failed!');
 *   <ToastContainer />
 */
import { useState, useCallback, useRef } from 'react';

interface Toast {
  id: number;
  message: string;
  type: 'ok' | 'warn' | 'err' | 'info';
}

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const push = useCallback((message: string, type: Toast['type']) => {
    const id = ++counter.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const toast = {
    ok:   (msg: string) => push(msg, 'ok'),
    warn: (msg: string) => push(msg, 'warn'),
    err:  (msg: string) => push(msg, 'err'),
    info: (msg: string) => push(msg, 'info'),
  };

  const ToastContainer = () => (
    <div className="toast-root" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`} role="alert">
          {t.message}
        </div>
      ))}
    </div>
  );

  return { toast, ToastContainer };
}
