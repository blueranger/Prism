'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useChatStore } from '@/stores/chat-store';
import type { ImportPlatform, ImportProjectTarget, ImportSyncRun } from '@prism/shared';

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
  const [chatgptMode, setChatgptMode] = useState<'upload' | 'sync'>('upload');
  const [projectName, setProjectName] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState<{ status: string; totalConversations?: number; totalMessages?: number; overwrittenConversations?: number; error?: string } | null>(null);
  const [projects, setProjects] = useState<ImportProjectTarget[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [syncRuns, setSyncRuns] = useState<ImportSyncRun[]>([]);
  const [syncRunsLoading, setSyncRunsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importFile = useChatStore((s) => s.importFile);
  const libraryImporting = useChatStore((s) => s.libraryImporting);

  const handleImport = useCallback(async () => {
    if (!selectedFile) return;
    setResult(null);
    try {
      const res = await importFile(selectedFile, selectedPlatform, projectName);
      setResult(res);
      setSelectedFile(null);
    } catch (err: any) {
      setResult({ status: 'failed', error: err.message });
    }
  }, [importFile, selectedFile, selectedPlatform, projectName]);

  const handleFile = useCallback((file: File) => {
    setResult(null);
    setSelectedFile(file);
  }, []);

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

  useEffect(() => {
    if (!open || selectedPlatform !== 'chatgpt' || chatgptMode !== 'sync') return;
    let cancelled = false;

    async function loadProjects() {
      setProjectsLoading(true);
      try {
        const { fetchImportProjects } = await import('@/lib/api');
        const result = await fetchImportProjects();
        if (!cancelled) setProjects(result);
      } catch (err) {
        console.error('[import] fetch projects error:', err);
        if (!cancelled) setProjects([]);
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    }

    loadProjects();
    return () => {
      cancelled = true;
    };
  }, [open, selectedPlatform, chatgptMode]);

  useEffect(() => {
    if (!open || selectedPlatform !== 'chatgpt' || chatgptMode !== 'sync') return;
    let cancelled = false;

    async function loadSyncRuns() {
      setSyncRunsLoading(true);
      try {
        const { fetchChatGPTSyncRuns } = await import('@/lib/api');
        const runs = await fetchChatGPTSyncRuns(6);
        if (!cancelled) setSyncRuns(runs);
      } catch (err) {
        console.error('[import] fetch sync runs error:', err);
        if (!cancelled) setSyncRuns([]);
      } finally {
        if (!cancelled) setSyncRunsLoading(false);
      }
    }

    loadSyncRuns();
    return () => {
      cancelled = true;
    };
  }, [open, selectedPlatform, chatgptMode]);

  if (!open) return null;

  const platformInfo = PLATFORMS.find(p => p.id === selectedPlatform)!;

  const formatSyncTime = (value?: string) => {
    if (!value) return '';
    return new Date(value).toLocaleString('zh-TW', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

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

        {selectedPlatform === 'chatgpt' && (
          <div className="mb-4 rounded-lg border border-gray-800 bg-gray-950/60 p-2">
            <div className="flex gap-2">
              <button
                onClick={() => setChatgptMode('upload')}
                className={`flex-1 rounded px-3 py-2 text-xs font-medium transition-colors ${
                  chatgptMode === 'upload'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-900 text-gray-400 hover:text-gray-200'
                }`}
              >
                Upload Archive
              </button>
              <button
                onClick={() => setChatgptMode('sync')}
                className={`flex-1 rounded px-3 py-2 text-xs font-medium transition-colors ${
                  chatgptMode === 'sync'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-gray-900 text-gray-400 hover:text-gray-200'
                }`}
              >
                Sync from ChatGPT
              </button>
            </div>
          </div>
        )}

        {selectedPlatform === 'chatgpt' && chatgptMode === 'sync' ? (
          <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-4 text-sm">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-emerald-200">Browser Sync (Experimental)</h3>
              <p className="mt-1 text-xs leading-relaxed text-emerald-100/70">
                Use the local Chrome extension to send selected ChatGPT conversations directly into Prism Library.
                Prism API must be running on <span className="font-mono">http://localhost:3001</span>.
              </p>
            </div>

            <div className="space-y-1 text-xs text-gray-300">
              <p>1. Load the extension from <span className="font-mono">extensions/chatgpt-sync</span>.</p>
              <p>2. Open ChatGPT in Chrome.</p>
              <p>3. Click the Prism sync button, pick conversations, then choose a Prism project.</p>
              <p>4. Sync to your local Prism API.</p>
            </div>

            <div className="mt-4">
              <label className="mb-1 block text-xs text-gray-400">Suggested project for sync</label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Optional default project name"
                className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:border-emerald-600"
              />
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-gray-400">Recent Prism projects</span>
                {projectsLoading ? <span className="text-[10px] text-gray-500">Loading...</span> : null}
              </div>
              <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                {projects.length === 0 ? (
                  <p className="text-xs text-gray-500">No titled sessions yet. You can still type a project name manually.</p>
                ) : (
                  projects.map((project) => (
                    <button
                      key={project.id}
                      onClick={() => setProjectName(project.title)}
                      className="flex w-full items-center justify-between rounded border border-gray-800 bg-gray-900/70 px-2 py-2 text-left text-xs text-gray-300 hover:border-emerald-700 hover:text-white"
                    >
                      <span className="truncate">{project.title}</span>
                      <span className="ml-3 shrink-0 text-[10px] uppercase text-gray-500">{project.sessionType}</span>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-gray-400">Recent sync history</span>
                {syncRunsLoading ? <span className="text-[10px] text-gray-500">Loading...</span> : null}
              </div>
              <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                {syncRuns.length === 0 ? (
                  <p className="text-xs text-gray-500">No ChatGPT sync runs recorded yet.</p>
                ) : (
                  syncRuns.map((run) => (
                    <div
                      key={run.id}
                      className="rounded border border-gray-800 bg-gray-900/70 px-2.5 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                          run.status === 'completed'
                            ? 'bg-emerald-900/50 text-emerald-300'
                            : run.status === 'failed'
                              ? 'bg-red-900/50 text-red-300'
                              : 'bg-amber-900/50 text-amber-300'
                        }`}>
                          {run.status}
                        </span>
                        <span className="text-gray-300">{formatSyncTime(run.completedAt || run.updatedAt)}</span>
                        {run.projectName ? (
                          <span className="truncate text-gray-500">· {run.projectName}</span>
                        ) : null}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-gray-500">
                        <span>Requested {run.requestedConversations}</span>
                        <span>Processed {run.processedConversations}</span>
                        <span>Imported {run.importedConversations}</span>
                        {run.overwrittenConversations > 0 ? <span>Updated {run.overwrittenConversations}</span> : null}
                        {run.skippedConversations > 0 ? <span>Skipped {run.skippedConversations}</span> : null}
                        {run.failedConversations > 0 ? <span>Failed {run.failedConversations}</span> : null}
                        <span>{run.totalMessages} messages</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : null}

        <div className={`mb-4 ${selectedPlatform === 'chatgpt' && chatgptMode === 'sync' ? 'hidden' : ''}`}>
          <label className="mb-1 block text-xs text-gray-400">Project name (optional)</label>
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="e.g. Agentic IDP / APAC Strategy"
            className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
          />
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            dragOver ? 'border-indigo-500 bg-indigo-500/10' : 'border-gray-700 hover:border-gray-600'
          } ${libraryImporting || (selectedPlatform === 'chatgpt' && chatgptMode === 'sync') ? 'opacity-50 pointer-events-none hidden' : ''}`}
        >
          {libraryImporting ? (
            <div className="text-gray-400">
              <div className="animate-spin inline-block w-6 h-6 border-2 border-gray-400 border-t-indigo-500 rounded-full mb-2" />
              <p className="text-sm">Importing...</p>
            </div>
          ) : selectedFile ? (
            <>
              <p className="text-gray-200 text-sm mb-1">{selectedFile.name}</p>
              <p className="text-gray-500 text-xs">
                {(selectedFile.size / 1024 / 1024).toFixed(1)} MB · Ready to import
              </p>
            </>
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

        {selectedFile && !libraryImporting && !(selectedPlatform === 'chatgpt' && chatgptMode === 'sync') ? (
          <div className="mt-3 flex items-center justify-between rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2 text-xs">
            <span className="truncate text-gray-400">Selected file: {selectedFile.name}</span>
            <button
              onClick={() => setSelectedFile(null)}
              className="ml-3 text-gray-500 hover:text-gray-300"
            >
              Clear
            </button>
          </div>
        ) : null}

        {/* Result */}
        {result && (
          <div className={`mt-4 p-3 rounded-lg text-sm ${
            result.status === 'completed'
              ? 'bg-green-900/30 text-green-300 border border-green-800'
              : 'bg-red-900/30 text-red-300 border border-red-800'
          }`}>
            {result.status === 'completed' ? (
              <p>
                Imported {result.totalConversations} conversations ({result.totalMessages} messages)
                {(result.overwrittenConversations ?? 0) > 0 ? ` · ${result.overwrittenConversations} overwritten` : ''}
              </p>
            ) : (
              <p>Import failed: {result.error}</p>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
          >
            Cancel
          </button>
          {selectedPlatform === 'chatgpt' && chatgptMode === 'sync' ? (
            <span className="text-xs text-emerald-300">
              Complete sync from the Chrome extension on ChatGPT
            </span>
          ) : (
            <button
              onClick={handleImport}
              disabled={!selectedFile || libraryImporting}
              className="px-3 py-2 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {libraryImporting ? 'Importing...' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
