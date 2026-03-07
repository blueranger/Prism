'use client';

import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  /** Auto-dismiss after this many ms (0 = manual dismiss only) */
  duration: number;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, duration?: number) => string;
  removeToast: (id: string) => void;
}

let _nextId = 1;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (type, message, duration = 4000) => {
    const id = `toast-${_nextId++}`;
    set((s) => ({ toasts: [...s.toasts, { id, type, message, duration }] }));
    return id;
  },
  removeToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Convenience helpers */
export const toast = {
  success: (msg: string, duration?: number) => useToastStore.getState().addToast('success', msg, duration),
  error: (msg: string, duration?: number) => useToastStore.getState().addToast('error', msg, duration ?? 6000),
  info: (msg: string, duration?: number) => useToastStore.getState().addToast('info', msg, duration),
};
