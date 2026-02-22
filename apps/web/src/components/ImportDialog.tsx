'use client';

import { useState, useRef, useCallback } from 'react';
import { useChatStore } from '@/stores/chat-store';
import type { ImportPlatform } from '@prism/shared';

const PLATFORMS: { id: ImportPlatform; label: string; color: string; instructions: string }[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    color: 'bg-green-600',
    instructions: 'Settings > Data controls > Export data. You\'ll receive a ZIP with conversations.json.',
  },
  {
    id: 'claude',
    label: 'Claude',
    color: 'bg-orange-600',
    instructions: 'Settings > Account > Export Data. You\'ll receive a ZIP with JSON files.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    color: 'bg-blue-600',
    instructions: 'Google Takeout > select "Gemini Apps". You\'ll receive a ZIP with JSON files.',
  },
];

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function ImportDialog({ open, onClose }: ImportDialogProps) {
  const [selectedPlatform, setSelectedPlatform] = useState<ImportPlatform>('chatgpt');
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState<{ status: string; totalConversations?: number; totalMessages?: number; error?: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importFile = useChatStore((s) => s.importFile);
  const libraryImporting = useChatStore((s) => s.libraryImporting);

  const handleFile = useCallback(async (file: File) => {
    setResult(null);
    try {
      const res = await importFile(file, selectedPlatform);
      setResult(res);
    } catch (err: any) {
      setResult({ status: 'failed', error: err.message });
    }
  }, [importFile, selectedPlatform]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset so same file can be selected again
    e.target.value = '';
  }, [handleFile]);

  if (!open) return null;

  const platformInfo = PLATFORMS.find(p => p.id === selectedPlatform)!;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-100">Import Conversations</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">&times;</button>
        </div>

        {/* Platform selector */}
        <div className="flex gap-2 mb-4">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              onClick={() => { setSelectedPlatform(p.id); setResult(null); }}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                selectedPlatform === p.id
                  ? `${p.color} text-white border-transparent`
                  : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-gray-200'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Instructions */}
        <p className="text-xs text-gray-500 mb-4">
          {platformInfo.instructions}
        </p>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            dragOver ? 'border-indigo-500 bg-indigo-500/10' : 'border-gray-700 hover:border-gray-600'
          } ${libraryImporting ? 'opacity-50 pointer-events-none' : ''}`}
        >
          {libraryImporting ? (
            <div className="text-gray-400">
              <div className="animate-spin inline-block w-6 h-6 border-2 border-gray-400 border-t-indigo-500 rounded-full mb-2" />
              <p className="text-sm">Importing...</p>
            </div>
          ) : (
            <>
              <p className="text-gray-400 text-sm mb-1">
                Drag & drop a .json or .zip file here
              </p>
              <p className="text-gray-600 text-xs">or click to browse</p>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.zip"
            className="hidden"
            onChange={handleFileInput}
          />
        </div>

        {/* Result */}
        {result && (
          <div className={`mt-4 p-3 rounded-lg text-sm ${
            result.status === 'completed'
              ? 'bg-green-900/30 text-green-300 border border-green-800'
              : 'bg-red-900/30 text-red-300 border border-red-800'
          }`}>
            {result.status === 'completed' ? (
              <p>Imported {result.totalConversations} conversations ({result.totalMessages} messages)</p>
            ) : (
              <p>Import failed: {result.error}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
