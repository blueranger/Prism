'use client';

import { useState, useEffect, useRef } from 'react';
import type { DraftReply } from '@prism/shared';
import { approveDraft, rejectDraft, createDraft } from '@/lib/api';

const TONE_OPTIONS = ['auto', 'formal', 'casual', 'friendly', 'technical'] as const;
const LANGUAGE_OPTIONS = ['auto', 'English', 'Chinese', 'Japanese', 'Korean'] as const;

interface DraftEditorProps {
  draft: DraftReply | null;
  threadId: string;
  onDone: () => void;
  onDraftCreated: (draft: DraftReply) => void;
  /** Per-chat config defaults (from LineChatSettings) */
  chatConfig?: { tone?: string; language?: string } | null;
}

export default function DraftEditor({ draft, threadId, onDone, onDraftCreated, chatConfig }: DraftEditorProps) {
  const [editing, setEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(draft?.draftContent ?? '');
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Initialize from: existing draft > per-chat config > 'auto'
  const [tone, setTone] = useState<string>(
    draft?.tone ?? chatConfig?.tone ?? 'auto'
  );
  const [language, setLanguage] = useState<string>(
    draft?.language ?? chatConfig?.language ?? 'auto'
  );

  // Track if user has manually changed tone/language (don't override user choices)
  const userChangedTone = useRef(false);
  const userChangedLanguage = useRef(false);

  // Sync with chatConfig when it loads asynchronously (only if user hasn't manually changed)
  useEffect(() => {
    if (chatConfig?.tone && !userChangedTone.current && tone === 'auto') {
      // LineChatSettings uses '' for auto, DraftEditor uses 'auto'
      const mappedTone = chatConfig.tone || 'auto';
      setTone(mappedTone);
    }
    if (chatConfig?.language && !userChangedLanguage.current && language === 'auto') {
      const mappedLang = chatConfig.language || 'auto';
      setLanguage(mappedLang);
    }
  }, [chatConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToneChange = (value: string) => {
    userChangedTone.current = true;
    setTone(value);
  };

  const handleLanguageChange = (value: string) => {
    userChangedLanguage.current = true;
    setLanguage(value);
  };

  const handleGenerate = async () => {
    setGenerating(true);
    const opts: { tone?: string; language?: string } = {};
    if (tone !== 'auto') opts.tone = tone;
    if (language !== 'auto') opts.language = language;
    const { draft: newDraft } = await createDraft(threadId, opts);
    if (newDraft) {
      onDraftCreated(newDraft);
      setEditedContent(newDraft.draftContent);
      setEditing(false);
    }
    setGenerating(false);
  };

  const handleApprove = async () => {
    if (!draft) return;
    setSending(true);
    const userEdit = editing && editedContent !== draft.draftContent ? editedContent : undefined;
    const ok = await approveDraft(draft.id, userEdit);
    setSending(false);
    if (ok) onDone();
  };

  const handleReject = async () => {
    if (!draft) return;
    setSending(true);
    const ok = await rejectDraft(draft.id);
    setSending(false);
    if (ok) onDone();
  };

  return (
    <div className="border border-indigo-500/30 bg-indigo-600/10 rounded-lg p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-indigo-400 uppercase tracking-wider">
          AI Draft
        </span>
        <span className="text-[10px] text-gray-500">
          {draft ? `via ${draft.modelUsed}` : chatConfig?.tone || chatConfig?.language ? 'Using chat preferences' : ''}
        </span>
      </div>

      {/* Tone & Language controls */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-500 uppercase">Tone</span>
          <select
            value={tone}
            onChange={(e) => handleToneChange(e.target.value)}
            className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {TONE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-500 uppercase">Language</span>
          <select
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value)}
            className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {LANGUAGE_OPTIONS.map((l) => (
              <option key={l} value={l}>
                {l === 'auto' ? 'Auto-detect' : l}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="text-xs px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50 ml-auto"
        >
          {generating ? 'Generating...' : draft ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {/* Draft content (only shown when a draft exists) */}
      {draft && (
        <>
          {editing ? (
            <textarea
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              rows={6}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
            />
          ) : (
            <p className="text-sm text-gray-200 whitespace-pre-wrap break-words bg-gray-800/50 rounded-lg px-3 py-2">
              {draft.draftContent}
            </p>
          )}

          {/* Instruction context */}
          {draft.instruction && (
            <p className="text-[11px] text-gray-500">
              Instruction: {draft.instruction}
            </p>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              disabled
              title="Sending is disabled during testing"
              className="text-xs px-4 py-2 rounded-lg bg-green-600/30 text-white/50 cursor-not-allowed opacity-50"
            >
              Approve & Send (disabled)
            </button>
            <button
              onClick={() => setEditing(!editing)}
              disabled={sending}
              className="text-xs px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors disabled:opacity-50"
            >
              {editing ? 'Preview' : 'Edit'}
            </button>
            <button
              onClick={handleReject}
              disabled={sending}
              className="text-xs px-4 py-2 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-400 transition-colors disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </>
      )}
    </div>
  );
}
