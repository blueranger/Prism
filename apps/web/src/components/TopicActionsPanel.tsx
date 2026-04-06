'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { createActionSession, fetchSessionApi, fetchTopicActions, streamPrompt, switchToSession, updateActionSessionApi, writeBackActionResult } from '@/lib/api';
import CreateActionModal from './CreateActionModal';

interface TopicActionsPanelProps {
  onHide?: () => void;
}

export default function TopicActionsPanel({ onHide }: TopicActionsPanelProps) {
  const sessionId = useChatStore((s) => s.sessionId);
  const currentSession = useChatStore((s) => s.currentSession);
  const topicActions = useChatStore((s) => s.topicActions);
  const setTopicActions = useChatStore((s) => s.setTopicActions);
  const setCurrentSession = useChatStore((s) => s.setCurrentSession);

  const [createOpen, setCreateOpen] = useState(false);
  const [writeBackText, setWriteBackText] = useState('');
  const [writeBackBusy, setWriteBackBusy] = useState(false);
  const [parentTitle, setParentTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !currentSession) return;
    if (currentSession.sessionType === 'topic') {
      fetchTopicActions(sessionId).then(setTopicActions);
      setParentTitle(null);
    } else if (currentSession.parentSessionId) {
      fetchSessionApi(currentSession.parentSessionId).then((session) => {
        setParentTitle(session?.title ?? session?.preview ?? session?.id.slice(0, 8) ?? null);
      });
    }
  }, [sessionId, currentSession, setTopicActions]);

  if (!sessionId || !currentSession) return null;
  const activeSessionId = sessionId;

  async function handleCreate(payload: Parameters<typeof createActionSession>[1]) {
    const created = await createActionSession(activeSessionId, payload);
    if (!created) return;

    setCreateOpen(false);
    const actions = await fetchTopicActions(activeSessionId);
    setTopicActions(actions);
    await switchToSession(created.id);
    const latest = await fetchSessionApi(created.id);
    setCurrentSession(latest);

    if (
      payload.actionScenario === 'reply' &&
      (payload.actionType === 'email' || payload.actionType === 'message')
    ) {
      await updateActionSessionApi(created.id, { actionStatus: 'in_progress' });
      await streamPrompt(buildReplyDraftPrompt(payload));
    }
  }

  async function handleWriteBack() {
    if (!currentSession || currentSession.sessionType !== 'action' || !writeBackText.trim()) return;

    setWriteBackBusy(true);
    try {
      const ok = await writeBackActionResult(currentSession.id, writeBackText.trim());
      if (!ok) return;
      await updateActionSessionApi(currentSession.id, {
        actionStatus: 'completed',
        resultSummary: writeBackText.trim(),
      });
      const refreshed = await fetchSessionApi(currentSession.id);
      setCurrentSession(refreshed);
      setWriteBackText('');
    } finally {
      setWriteBackBusy(false);
    }
  }

  return (
    <>
      <div className="w-72 flex-shrink-0 rounded-lg border border-gray-800 bg-gray-900/80 p-3">
        {currentSession.sessionType === 'topic' ? (
          <>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-100">Actions</h3>
                <p className="mt-1 text-[11px] text-gray-500">
                  Isolated execution threads derived from this topic.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {onHide && (
                  <button
                    onClick={onHide}
                    className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                  >
                    Hide
                  </button>
                )}
                <button
                  onClick={() => setCreateOpen(true)}
                  className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
                >
                  New Action
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {topicActions.length === 0 && (
                <div className="rounded border border-dashed border-gray-800 px-3 py-4 text-center text-xs text-gray-600">
                  No actions yet
                </div>
              )}

              {topicActions.map((action) => (
                <button
                  key={action.id}
                  onClick={() => switchToSession(action.id)}
                  className="w-full rounded-md border border-gray-800 bg-gray-950/60 px-3 py-2 text-left hover:border-gray-700 hover:bg-gray-800/70"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-gray-200">
                      {action.actionTitle ?? action.title ?? 'Untitled action'}
                    </span>
                    <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
                      {action.actionStatus ?? 'draft'}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-gray-500">
                    {(action.actionType ?? 'custom')} {action.actionTarget ? `· ${action.actionTarget}` : ''}
                  </div>
                  {action.resultSummary && (
                    <div className="mt-1 line-clamp-2 text-[11px] text-gray-400">
                      {action.resultSummary}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="mb-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-indigo-600/20 px-2 py-0.5 text-[10px] uppercase tracking-wide text-indigo-300">
                    Action
                  </span>
                  <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">
                    {currentSession.actionStatus ?? 'draft'}
                  </span>
                </div>
                {onHide && (
                  <button
                    onClick={onHide}
                    className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                  >
                    Hide
                  </button>
                )}
              </div>
              <h3 className="mt-2 text-sm font-semibold text-gray-100">
                {currentSession.actionTitle ?? currentSession.title ?? 'Untitled action'}
              </h3>
              <p className="mt-1 text-[11px] text-gray-500">
                Type: {currentSession.actionType ?? 'custom'}
                {currentSession.actionTarget ? ` · Target: ${currentSession.actionTarget}` : ''}
              </p>
              {currentSession.parentSessionId && (
                <p className="mt-1 text-[11px] text-gray-500">
                  Parent topic: {parentTitle ?? currentSession.parentSessionId.slice(0, 8)}
                </p>
              )}
            </div>

            <div className="rounded border border-gray-800 bg-gray-950/60 px-3 py-2 text-[11px] text-gray-400">
              <div className="mb-1 font-medium text-gray-300">
                {currentSession.contextSnapshot?.actionScenario === 'reply' ? 'Reply source' : 'Action context'}
              </div>
              <div className="max-h-56 overflow-auto whitespace-pre-wrap break-words leading-5">
                {currentSession.contextSnapshot?.sourceTemplate
                  ?? currentSession.contextSnapshot?.sourceSummary
                  ?? 'No context snapshot available.'}
              </div>
            </div>

            <div className="mt-3">
              <label className="block text-xs text-gray-400">
                Write back to topic
                <textarea
                  rows={4}
                  value={writeBackText}
                  onChange={(e) => setWriteBackText(e.target.value)}
                  placeholder="Summarize the outcome of this action for the main topic."
                  className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-2 text-sm text-gray-100"
                />
              </label>
              <button
                onClick={handleWriteBack}
                disabled={writeBackBusy || !writeBackText.trim()}
                className="mt-2 w-full rounded bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {writeBackBusy ? 'Writing back...' : 'Write Back Summary'}
              </button>
            </div>
          </>
        )}
      </div>

      <CreateActionModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
      />
    </>
  );
}

function buildReplyDraftPrompt(payload: Parameters<typeof createActionSession>[1]) {
  const medium = payload.actionType === 'message' ? 'message' : 'email';
  const lines = [
    `Draft a reply ${medium} based on the attached action context.`,
    'Use the reply source as the primary reference and produce a practical draft the user can send with minimal editing.',
  ];

  if (payload.target?.trim()) {
    lines.push(`Target audience: ${payload.target.trim()}`);
  }
  if (payload.outputExpectation?.trim()) {
    lines.push(`Output expectation: ${payload.outputExpectation.trim()}`);
  }
  if (payload.instruction?.trim()) {
    lines.push(`Additional instruction: ${payload.instruction.trim()}`);
  }

  lines.push(`Format: return the reply draft only${medium === 'email' ? ', with a subject line if useful.' : '.'}`);
  return lines.join('\n');
}
