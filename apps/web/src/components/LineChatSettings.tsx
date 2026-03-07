'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  fetchLineChats,
  updateLineChatConfig,
  updateLineChatConfigs,
  controlLineMonitor,
  type LineChatConfig,
} from '@/lib/api';

interface LineChatInfo {
  name: string;
  lastMessage: string;
  time: string;
  unreadCount: number;
  index: number;
  isMonitored: boolean;
  config: LineChatConfig | null;
}

const TONE_OPTIONS = [
  { value: '', label: 'Auto (自動)' },
  { value: 'formal', label: 'Formal (正式)' },
  { value: 'casual', label: 'Casual (輕鬆)' },
  { value: 'friendly', label: 'Friendly (友善)' },
  { value: 'technical', label: 'Technical (專業)' },
] as const;

const LANGUAGE_OPTIONS = [
  { value: '', label: 'Auto-detect' },
  { value: 'Chinese', label: '中文 (Chinese)' },
  { value: 'English', label: 'English' },
  { value: 'Japanese', label: '日本語 (Japanese)' },
  { value: 'Korean', label: '한국어 (Korean)' },
] as const;

/** Local draft for editing a chat's config before saving */
interface ChatConfigDraft {
  persona: string;
  tone: string;
  instruction: string;
  language: string;
}

interface LineChatSettingsProps {
  accountId: string;
  onClose: () => void;
}

export default function LineChatSettings({ accountId, onClose }: LineChatSettingsProps) {
  const [chats, setChats] = useState<LineChatInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [monitorRunning, setMonitorRunning] = useState(false);
  const [expandedChat, setExpandedChat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [bulkAction, setBulkAction] = useState<string | null>(null);

  // Local draft state per chat: { chatName: { persona, tone, instruction, language } }
  const [drafts, setDrafts] = useState<Record<string, ChatConfigDraft>>({});

  const loadChats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLineChats(accountId);
      if (data.chats.length === 0) {
        setError('No chats returned. Make sure the backend API (port 3001) is running and Chrome with LINE Extension is open.');
      }
      setChats(data.chats);
    } catch {
      setError('Cannot connect to backend API. Make sure the API server is running on port 3001.');
    }
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    loadChats();
    controlLineMonitor(accountId, 'status').then((r) => setMonitorRunning(r.running));
  }, [accountId, loadChats]);

  /** Get or create a draft for a chat, initializing from its current config */
  const getDraft = (chat: LineChatInfo): ChatConfigDraft => {
    if (drafts[chat.name]) return drafts[chat.name];
    return {
      persona: chat.config?.persona ?? '',
      tone: chat.config?.tone ?? '',
      instruction: chat.config?.instruction ?? '',
      language: chat.config?.language ?? '',
    };
  };

  /** Update a single field in a chat's draft */
  const updateDraft = (chatName: string, field: keyof ChatConfigDraft, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [chatName]: {
        ...getDraftForName(chatName),
        [field]: value,
      },
    }));
  };

  /** Helper to get draft by name (used inside setDrafts) */
  const getDraftForName = (chatName: string): ChatConfigDraft => {
    if (drafts[chatName]) return drafts[chatName];
    const chat = chats.find((c) => c.name === chatName);
    return {
      persona: chat?.config?.persona ?? '',
      tone: chat?.config?.tone ?? '',
      instruction: chat?.config?.instruction ?? '',
      language: chat?.config?.language ?? '',
    };
  };

  /** Check if a chat's draft has unsaved changes */
  const isDirty = (chat: LineChatInfo): boolean => {
    const draft = drafts[chat.name];
    if (!draft) return false;
    const config = chat.config;
    return (
      draft.persona !== (config?.persona ?? '') ||
      draft.tone !== (config?.tone ?? '') ||
      draft.instruction !== (config?.instruction ?? '') ||
      draft.language !== (config?.language ?? '')
    );
  };

  const handleToggleMonitor = async (chatName: string, enabled: boolean) => {
    setSaving(chatName);
    await updateLineChatConfig(accountId, chatName, { enabled });
    setChats((prev) =>
      prev.map((c) =>
        c.name === chatName
          ? { ...c, isMonitored: enabled, config: { ...(c.config ?? { name: chatName, enabled }), enabled } }
          : c
      )
    );
    setSaving(null);
  };

  /** Save all draft fields for a specific chat */
  const handleSaveConfig = async (chatName: string) => {
    const draft = drafts[chatName];
    if (!draft) return;

    setSaving(chatName);
    setSavedMsg(null);
    const result = await updateLineChatConfig(accountId, chatName, {
      persona: draft.persona,
      tone: draft.tone,
      instruction: draft.instruction,
      language: draft.language,
    });

    if (result) {
      // Update the chat's config in state
      setChats((prev) =>
        prev.map((c) =>
          c.name === chatName ? { ...c, config: result } : c
        )
      );
      // Clear the draft (it's now saved)
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[chatName];
        return next;
      });
      setSavedMsg(chatName);
      setTimeout(() => setSavedMsg(null), 2000);
    }
    setSaving(null);
  };

  const handleEnableAll = async () => {
    setBulkAction('enableAll');
    await updateLineChatConfigs(accountId, null);
    // Update local state immediately — null config = all monitored
    setChats((prev) => prev.map((c) => ({ ...c, isMonitored: true, config: null })));
    setDrafts({});
    setBulkAction(null);
  };

  const handleDisableAll = async () => {
    setBulkAction('disableAll');
    const configs: LineChatConfig[] = chats.map((c) => ({
      ...(c.config ?? { name: c.name, enabled: false }),
      name: c.name,
      enabled: false,
    }));
    await updateLineChatConfigs(accountId, configs);
    // Update local state immediately
    setChats((prev) =>
      prev.map((c) => ({
        ...c,
        isMonitored: false,
        config: { ...(c.config ?? { name: c.name, enabled: false }), name: c.name, enabled: false },
      }))
    );
    setDrafts({});
    setBulkAction(null);
  };

  const handleToggleMonitorAgent = async () => {
    const action = monitorRunning ? 'stop' : 'start';
    const result = await controlLineMonitor(accountId, action);
    setMonitorRunning(result.running);
  };

  /** When expanding a chat, initialize its draft from current config */
  const handleExpand = (chatName: string) => {
    if (expandedChat === chatName) {
      setExpandedChat(null);
      return;
    }
    setExpandedChat(chatName);
    // Initialize draft if not already present
    if (!drafts[chatName]) {
      const chat = chats.find((c) => c.name === chatName);
      if (chat) {
        setDrafts((prev) => ({
          ...prev,
          [chatName]: {
            persona: chat.config?.persona ?? '',
            tone: chat.config?.tone ?? '',
            instruction: chat.config?.instruction ?? '',
            language: chat.config?.language ?? '',
          },
        }));
      }
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-gray-100">LINE Chat Settings</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Select chats to monitor and configure per-chat personas
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Monitor Agent Control */}
        <div className="px-6 py-3 border-b border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${monitorRunning ? 'bg-green-400' : 'bg-gray-600'}`} />
            <span className="text-xs text-gray-400">
              Monitor Agent: {monitorRunning ? 'Running (30s poll)' : 'Stopped'}
            </span>
          </div>
          <button
            onClick={handleToggleMonitorAgent}
            className={`text-xs px-3 py-1.5 rounded transition-colors ${
              monitorRunning
                ? 'bg-red-900/50 hover:bg-red-800/50 text-red-400'
                : 'bg-green-900/50 hover:bg-green-800/50 text-green-400'
            }`}
          >
            {monitorRunning ? 'Stop' : 'Start'}
          </button>
        </div>

        {/* Quick actions */}
        <div className="px-6 py-2 border-b border-gray-800 flex items-center gap-2">
          <button
            onClick={handleEnableAll}
            disabled={bulkAction !== null}
            className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors disabled:opacity-50"
          >
            {bulkAction === 'enableAll' ? 'Enabling...' : 'Monitor All'}
          </button>
          <button
            onClick={handleDisableAll}
            disabled={bulkAction !== null}
            className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors disabled:opacity-50"
          >
            {bulkAction === 'disableAll' ? 'Disabling...' : 'Disable All'}
          </button>
          <button
            onClick={loadChats}
            className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors ml-auto"
          >
            Refresh
          </button>
        </div>

        {error && (
          <div className="px-6 py-2">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        {/* Chat List */}
        <div className="flex-1 overflow-y-auto px-6 py-3 space-y-2">
          {loading ? (
            <p className="text-sm text-gray-500 text-center py-4">Loading chats...</p>
          ) : chats.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-4">No chats found</p>
          ) : (
            chats.map((chat) => {
              const isExpanded = expandedChat === chat.name;
              const config = chat.config;
              const draft = getDraft(chat);
              const dirty = isDirty(chat);
              const isSaving = saving === chat.name;
              const justSaved = savedMsg === chat.name;

              return (
                <div
                  key={chat.name}
                  className="bg-gray-800 rounded-lg overflow-hidden"
                >
                  {/* Chat row */}
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    {/* Monitor toggle */}
                    <input
                      type="checkbox"
                      checked={chat.isMonitored}
                      onChange={(e) => handleToggleMonitor(chat.name, e.target.checked)}
                      disabled={isSaving}
                      className="w-3.5 h-3.5 accent-green-500 shrink-0"
                    />

                    {/* Chat info */}
                    <div
                      className="flex-1 min-w-0 cursor-pointer"
                      onClick={() => handleExpand(chat.name)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-200 truncate">
                          {chat.name}
                        </span>
                        {chat.unreadCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-600 text-white font-medium">
                            {chat.unreadCount}
                          </span>
                        )}
                        {config?.persona && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-900/50 text-indigo-400 border border-indigo-800/50 truncate max-w-[100px]">
                            {config.persona}
                          </span>
                        )}
                        {config?.language && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-400 border border-green-800/50">
                            {config.language}
                          </span>
                        )}
                        {config?.tone && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-400 border border-yellow-800/50">
                            {config.tone}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 truncate">
                        {chat.lastMessage || 'No messages'}
                        {chat.time ? ` · ${chat.time}` : ''}
                      </p>
                    </div>

                    {/* Expand arrow */}
                    <button
                      onClick={() => handleExpand(chat.name)}
                      className="text-gray-600 hover:text-gray-400 text-xs shrink-0"
                    >
                      {isExpanded ? '\u25B2' : '\u25BC'}
                    </button>
                  </div>

                  {/* Expanded config panel */}
                  {isExpanded && (
                    <div className="px-4 pb-3 pt-1 border-t border-gray-700/50 space-y-2">
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase tracking-wider">Persona / Role</label>
                        <input
                          value={draft.persona}
                          onChange={(e) => updateDraft(chat.name, 'persona', e.target.value)}
                          placeholder="e.g. Product Manager, 朋友"
                          className="mt-0.5 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase tracking-wider">Tone</label>
                        <select
                          value={draft.tone}
                          onChange={(e) => updateDraft(chat.name, 'tone', e.target.value)}
                          className="mt-0.5 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        >
                          {TONE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase tracking-wider">Language</label>
                        <select
                          value={draft.language}
                          onChange={(e) => updateDraft(chat.name, 'language', e.target.value)}
                          className="mt-0.5 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        >
                          {LANGUAGE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase tracking-wider">Instruction</label>
                        <textarea
                          value={draft.instruction}
                          onChange={(e) => updateDraft(chat.name, 'instruction', e.target.value)}
                          placeholder="e.g. 用中文回覆，保持簡短"
                          rows={2}
                          className="mt-0.5 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
                        />
                      </div>

                      {/* Save button */}
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={() => handleSaveConfig(chat.name)}
                          disabled={!dirty || isSaving}
                          className={`text-xs px-3 py-1.5 rounded transition-colors ${
                            dirty && !isSaving
                              ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                              : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                          }`}
                        >
                          {isSaving ? 'Saving...' : 'Save'}
                        </button>
                        {justSaved && (
                          <span className="text-[11px] text-green-400">Saved!</span>
                        )}
                        {dirty && !isSaving && (
                          <span className="text-[11px] text-yellow-500">Unsaved changes</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex justify-end">
          <button
            onClick={onClose}
            className="text-sm px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
