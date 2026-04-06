'use client';

import { useEffect, useState } from 'react';
import { toast } from '@/stores/toast-store';

interface UrlTextModalProps {
  title: string;
  url: string;
  text: string;
  onClose: () => void;
}

export default function UrlTextModal({ title, url, text, onClose }: UrlTextModalProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 p-6 animate-fade-in-scale"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-800 px-5 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-gray-100">{title}</div>
            <div className="truncate text-xs text-gray-500">{url}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="rounded-md border border-gray-600 px-3 py-1 text-xs font-medium text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-100"
            >
              {copied ? '\u2713 Copied' : 'Copy All'}
            </button>
            <button
              onClick={onClose}
              className="text-lg leading-none text-gray-500 transition-colors hover:text-gray-300"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-gray-300">
            {text}
          </pre>
        </div>
      </div>
    </div>
  );
}
