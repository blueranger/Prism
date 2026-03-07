'use client';

import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { fetchCommThreadMessages, fetchDrafts, fetchTriageResults, fetchLineChatConfigs, addManualMessage, type LineChatConfig } from '@/lib/api';
import DraftEditor from './DraftEditor';
import type { DraftReply, TriageResult } from '@prism/shared';
import type { ExternalMessage } from '@prism/shared';

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ThreadDetail() {
  const selectedId = useChatStore((s) => s.commSelectedThreadId);
  const threads = useChatStore((s) => s.commThreads);
  const messages = useChatStore((s) => s.commThreadMessages);
  const setMessages = useChatStore((s) => s.setCommThreadMessages);

  const commDrafts = useChatStore((s) => s.commDrafts);
  const setCommDrafts = useChatStore((s) => s.setCommDrafts);

  const contentLoading = useChatStore((s) => s.commContentLoading);
  const setContentLoading = useChatStore((s) => s.setCommContentLoading);
  const queueTask = useChatStore((s) => s.commQueueTask);
  const queuePending = useChatStore((s) => s.commQueuePending);

  const [pendingDraft, setPendingDraft] = useState<DraftReply | null>(null);
  const [showDraftEditor, setShowDraftEditor] = useState(false);
  const [triageResults, setTriageResults] = useState<TriageResult[]>([]);
  const [chatConfig, setChatConfig] = useState<LineChatConfig | null>(null);

  // Manual message add state
  const [showAddMessage, setShowAddMessage] = useState(false);
  const [addMsgContent, setAddMsgContent] = useState('');
  const [addMsgSenderName, setAddMsgSenderName] = useState('');
  const [addMsgIsInbound, setAddMsgIsInbound] = useState(true);
  const [addingMessage, setAddingMessage] = useState(false);

  const thread = threads.find((t) => t.id === selectedId);
  const connectors = useChatStore((s) => s.commConnectors);
  const isManualThread = thread?.provider === 'manual';

  // Ref for the scrollable message container — used to auto-scroll to bottom
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedId) return;
    setShowDraftEditor(false);
    setPendingDraft(null);
    setContentLoading(false);
    fetchCommThreadMessages(selectedId).then(({ messages: msgs, contentLoading: loading }) => {
      setMessages(msgs);
      setContentLoading(loading);
    });
    // Also check for existing pending drafts
    fetchDrafts({ threadId: selectedId, status: 'pending' }).then((drafts) => {
      if (drafts.length > 0) {
        setPendingDraft(drafts[0]);
        setShowDraftEditor(true);
      }
    });
    // Load triage results for this thread
    fetchTriageResults({ threadId: selectedId }).then(setTriageResults);

    // Load per-chat config for LINE threads
    setChatConfig(null);
    const currentThread = threads.find((t) => t.id === selectedId);
    if (currentThread?.provider === 'line') {
      fetchLineChatConfigs(currentThread.accountId).then((configs) => {
        if (configs) {
          const chatName = currentThread.displayName || currentThread.senderName || '';
          const match = configs.find((c) => c.name === chatName);
          if (match) setChatConfig(match);
        }
      });
    }
  }, [selectedId, setMessages, threads]);

  // Auto-scroll to the latest (bottom) message when messages load or thread changes
  useEffect(() => {
    if (messages.length > 0 && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, selectedId]);

  // Pick up drafts triggered via PromptInput (active mode)
  useEffect(() => {
    if (commDrafts.length > 0 && selectedId) {
      const relevantDraft = commDrafts.find((d) => d.threadId === selectedId && d.status === 'pending');
      if (relevantDraft) {
        setPendingDraft(relevantDraft);
        setShowDraftEditor(true);
        setCommDrafts([]);
      }
    }
  }, [commDrafts, selectedId, setCommDrafts]);

  const handleDraftReply = () => {
    if (!selectedId) return;
    // Show DraftEditor without a draft — user picks tone/language then generates
    setPendingDraft(null);
    setShowDraftEditor(true);
  };

  const handleDraftDone = () => {
    setPendingDraft(null);
    setShowDraftEditor(false);
    // Refresh messages to show the sent reply
    if (selectedId) {
      fetchCommThreadMessages(selectedId).then(({ messages: msgs }) => setMessages(msgs));
    }
  };

  const handleAddMessage = async () => {
    if (!selectedId || !addMsgContent.trim()) return;
    setAddingMessage(true);

    const senderName = addMsgIsInbound
      ? (addMsgSenderName.trim() || thread?.senderName || thread?.displayName || 'Unknown')
      : 'Me';

    const msg = await addManualMessage(selectedId, {
      content: addMsgContent.trim(),
      senderName,
      isInbound: addMsgIsInbound,
    });

    if (msg) {
      setMessages([...messages, msg]);
      setAddMsgContent('');
      setAddMsgSenderName('');
      setShowAddMessage(false);
    }
    setAddingMessage(false);
  };

  if (!selectedId || !thread) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-gray-600">Select a thread to view messages</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Thread header */}
      <div className="shrink-0 border-b border-gray-800 pb-3 mb-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-200">
              {thread.senderName ?? 'Unknown'}
            </h3>
            {thread.senderEmail && (
              <p className="text-xs text-gray-500">{thread.senderEmail}</p>
            )}
          </div>
          <span className="text-xs text-gray-600 bg-gray-800 px-2 py-1 rounded capitalize">
            {thread.provider}
          </span>
        </div>
        {thread.subject && (
          <p className="text-xs text-gray-400 mt-1">
            Subject: {thread.subject}
          </p>
        )}
      </div>

      {/* Content loading banner with queue status */}
      {contentLoading && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-indigo-900/30 border border-indigo-500/20 rounded-lg text-xs text-indigo-300">
          <span className="inline-block w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin shrink-0" />
          <span>
            {queueTask?.startsWith('content-') ? (
              '正在載入郵件內容...'
            ) : queueTask?.startsWith('sync-') ? (
              <>正在同步郵件列表，郵件內容載入排隊中{queuePending > 0 ? `（前方 ${queuePending} 個任務）` : ''}...</>
            ) : queueTask ? (
              <>正在處理其他任務，郵件內容載入排隊中...</>
            ) : (
              '正在載入郵件內容，請稍候...'
            )}
          </span>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3">
        {messages.length === 0 && !contentLoading && (
          <p className="text-sm text-gray-600 text-center py-4">No messages loaded.</p>
        )}

        {messages.map((msg) => {
          const isInbound = msg.isInbound;
          return (
            <div
              key={msg.id}
              className={`flex ${isInbound ? 'justify-start' : 'justify-end'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-3 ${
                  isInbound
                    ? 'bg-gray-800 text-gray-200'
                    : 'bg-indigo-600/20 text-gray-200 border border-indigo-500/20'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-gray-400">
                    {isInbound ? msg.senderName : 'You'}
                  </span>
                  <span className="text-[10px] text-gray-600">
                    {formatTimestamp(msg.timestamp)}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap break-words">
                  {msg.content || (
                    contentLoading ? (
                      <span className="text-gray-500 italic flex items-center gap-2">
                        <span className="inline-block w-2.5 h-2.5 border border-gray-500 border-t-transparent rounded-full animate-spin" />
                        載入中...
                      </span>
                    ) : (
                      <span className="text-gray-500 italic">
                        {msg.subject ? `[${msg.subject}]` : '[Content not available]'}
                      </span>
                    )
                  )}
                </p>
              </div>
            </div>
          );
        })}
        {/* Invisible anchor at the bottom — scrollIntoView target */}
        <div ref={messagesEndRef} />
      </div>

      {/* Triage classification (if any) */}
      {triageResults.length > 0 && (
        <div className="shrink-0 mt-3 pt-3 border-t border-gray-800">
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Triage Analysis
          </p>
          <div className="space-y-1.5">
            {triageResults.map((tr) => (
              <div
                key={tr.id}
                className="flex items-center gap-2 text-xs bg-gray-900/50 rounded-lg px-3 py-2"
              >
                <span
                  className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                    tr.importance === 'urgent'
                      ? 'bg-red-500/20 text-red-300'
                      : tr.importance === 'important'
                        ? 'bg-yellow-500/20 text-yellow-300'
                        : tr.importance === 'normal'
                          ? 'bg-blue-500/20 text-blue-300'
                          : 'bg-gray-700 text-gray-400'
                  }`}
                >
                  {tr.importance}
                </span>
                <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-gray-700 text-gray-300">
                  {tr.senderRole}
                </span>
                {tr.isCommercial && (
                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-orange-500/20 text-orange-300">
                    commercial
                  </span>
                )}
                <span className="text-gray-400 truncate flex-1">
                  {tr.reasoning}
                </span>
                {tr.suggestedAction === 'auto_draft' && tr.draftId && (
                  <span className="shrink-0 text-[10px] text-green-400">
                    auto-drafted
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Draft editor (when shown) */}
      {showDraftEditor && selectedId && (
        <div className="shrink-0 mt-3">
          <DraftEditor
            draft={pendingDraft}
            threadId={selectedId}
            onDone={handleDraftDone}
            onDraftCreated={(d) => setPendingDraft(d)}
            chatConfig={chatConfig}
          />
        </div>
      )}

      {/* Add Message panel (manual threads) */}
      {isManualThread && showAddMessage && (
        <div className="shrink-0 mt-3 pt-3 border-t border-gray-800">
          <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-400">Add Message</span>
              <button
                onClick={() => setShowAddMessage(false)}
                className="text-gray-600 hover:text-gray-400 text-sm leading-none"
              >
                &times;
              </button>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="msgDirection"
                  checked={addMsgIsInbound}
                  onChange={() => setAddMsgIsInbound(true)}
                  className="accent-indigo-500"
                />
                <span className="text-xs text-gray-400">Received (inbound)</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="msgDirection"
                  checked={!addMsgIsInbound}
                  onChange={() => setAddMsgIsInbound(false)}
                  className="accent-indigo-500"
                />
                <span className="text-xs text-gray-400">Sent (outbound)</span>
              </label>
            </div>
            {addMsgIsInbound && (
              <input
                type="text"
                value={addMsgSenderName}
                onChange={(e) => setAddMsgSenderName(e.target.value)}
                placeholder={`Sender name (default: ${thread?.senderName || thread?.displayName || 'Unknown'})`}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            )}
            <textarea
              value={addMsgContent}
              onChange={(e) => setAddMsgContent(e.target.value)}
              placeholder="Paste the message content here..."
              rows={4}
              autoFocus
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
            />
            <div className="flex justify-end">
              <button
                onClick={handleAddMessage}
                disabled={addingMessage || !addMsgContent.trim()}
                className="text-xs px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
              >
                {addingMessage ? 'Adding...' : 'Add Message'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="shrink-0 mt-3 pt-3 border-t border-gray-800 flex gap-2">
        {(() => {
          const lastInbound = [...messages].reverse().find((m) => m.isInbound);
          const canDraft = !!lastInbound;
          return (
            <button
              onClick={handleDraftReply}
              disabled={showDraftEditor || !canDraft}
              title={canDraft ? 'Generate AI draft reply' : 'No inbound message to reply to'}
              className="text-xs px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Draft Reply
            </button>
          );
        })()}
        {isManualThread && (
          <button
            onClick={() => setShowAddMessage(!showAddMessage)}
            className={`text-xs px-4 py-2 rounded-lg transition-colors ${
              showAddMessage
                ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
            }`}
          >
            + Add Message
          </button>
        )}
        {!isManualThread && (
          <button
            className="text-xs px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
          >
            Manual Reply
          </button>
        )}
      </div>
    </div>
  );
}
