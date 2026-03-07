'use client';

import { useEffect, useState } from 'react';
import { toast } from '@/stores/toast-store';

interface FileTextModalProps {
  filename: string;
  text: string;
  onClose: () => void;
}

export default function FileTextModal({ filename, text, onClose }: FileTextModalProps) {
  const [copied, setCopied] = useState(false);

  // Close on ESC
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
      className="fixed inset-0 z-[9998] bg-black/60 flex items-center justify-center p-6 animate-fade-in-scale"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-base">{'\u{1F4C4}'}</span>
            <span className="text-sm font-medium text-gray-200 truncate">{filename}</span>
            <span className="text-xs text-gray-500 flex-shrink-0">
              {text.length.toLocaleString()} chars
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={handleCopy}
              className="px-3 py-1 text-xs font-medium rounded-md border transition-colors
                         border-gray-600 text-gray-300 hover:bg-gray-800 hover:text-gray-100"
            >
              {copied ? '\u2713 Copied' : 'Copy All'}
            </button>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Text content */}
        <div className="flex-1 overflow-y-auto p-5">
          <pre className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap font-mono break-words">
            {text}
          </pre>
        </div>
      </div>
    </div>
  );
}
