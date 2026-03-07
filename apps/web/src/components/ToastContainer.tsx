'use client';

import { useEffect, useCallback } from 'react';
import { useToastStore, type Toast } from '@/stores/toast-store';

function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  useEffect(() => {
    if (t.duration > 0) {
      const timer = setTimeout(() => onDismiss(t.id), t.duration);
      return () => clearTimeout(timer);
    }
  }, [t.id, t.duration, onDismiss]);

  const bgColor =
    t.type === 'success'
      ? 'bg-green-900/90 border-green-600/50'
      : t.type === 'error'
        ? 'bg-red-900/90 border-red-600/50'
        : 'bg-gray-800/90 border-gray-600/50';

  const icon =
    t.type === 'success'
      ? '\u2713'
      : t.type === 'error'
        ? '\u2717'
        : '\u2139';

  const iconColor =
    t.type === 'success'
      ? 'text-green-400'
      : t.type === 'error'
        ? 'text-red-400'
        : 'text-blue-400';

  return (
    <div
      className={`flex items-start gap-2.5 px-4 py-3 rounded-lg border shadow-lg backdrop-blur-sm text-sm animate-slide-in-right ${bgColor}`}
      style={{ minWidth: 280, maxWidth: 420 }}
    >
      <span className={`${iconColor} text-base font-bold flex-shrink-0 mt-0.5`}>{icon}</span>
      <span className="text-gray-200 flex-1 break-words">{t.message}</span>
      <button
        onClick={() => onDismiss(t.id)}
        className="text-gray-500 hover:text-gray-300 transition-colors flex-shrink-0 ml-1"
      >
        &times;
      </button>
    </div>
  );
}

export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  const handleDismiss = useCallback(
    (id: string) => removeToast(id),
    [removeToast]
  );

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-auto">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={handleDismiss} />
      ))}
    </div>
  );
}
