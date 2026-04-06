'use client';

import { useEffect, useState } from 'react';
import { MODELS } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import { streamHandoff, updateObserverConfigApi } from '@/lib/api';
import ResponsePanel from './ResponsePanel';

export default function HandoffPanel() {
  const [instruction, setInstruction] = useState('');
  const selectedModels = useChatStore((s) => s.selectedModels);
  const handoffFrom = useChatStore((s) => s.handoffFromModel);
  const handoffTo = useChatStore((s) => s.handoffToModel);
  const setHandoffFrom = useChatStore((s) => s.setHandoffFrom);
  const setHandoffTo = useChatStore((s) => s.setHandoffTo);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sessionId = useChatStore((s) => s.sessionId);
  const responses = useChatStore((s) => s.handoffResponses);
  const setMode = useChatStore((s) => s.setMode);
  const setObserverConfig = useChatStore((s) => s.setObserverConfig);
  const setSelectedModels = useChatStore((s) => s.setSelectedModels);
  const setCurrentSession = useChatStore((s) => s.setCurrentSession);
  const reconcileCompletedResponse = useChatStore((s) => s.reconcileCompletedResponse);
  const [continueLoading, setContinueLoading] = useState(false);

  const modelIds = selectedModels;

  const canHandoff = sessionId && handoffFrom && handoffTo && handoffFrom !== handoffTo && !isStreaming;

  const handleHandoff = () => {
    if (!canHandoff) return;
    const trimmed = instruction.trim();
    setInstruction('');
    streamHandoff(trimmed || undefined);
  };

  const handleContinueWithRecipient = async () => {
    if (!sessionId || !handoffTo) return;
    setContinueLoading(true);
    try {
      const nextObservers = [handoffFrom, ...selectedModels]
        .filter(Boolean)
        .filter((model, index, array): model is string => Boolean(model) && model !== handoffTo && array.indexOf(model) === index)
        .slice(0, 2);
      const updated = await updateObserverConfigApi(sessionId, {
        activeModel: handoffTo,
        observerModels: nextObservers,
      });
      const resolvedActive = updated?.activeModel ?? handoffTo;
      const resolvedObservers = updated?.observerModels ?? nextObservers;
      setObserverConfig(resolvedActive, resolvedObservers);
      if (updated) {
        setCurrentSession(updated);
      }
      setSelectedModels(
        [resolvedActive, ...resolvedObservers, ...selectedModels]
          .filter((model, index, array): model is string => Boolean(model) && array.indexOf(model) === index)
          .slice(0, 3),
      );
      setMode('observer');
    } finally {
      setContinueLoading(false);
    }
  };

  const resp = handoffTo ? responses[handoffTo] : null;
  const fromLabel = handoffFrom ? (MODELS[handoffFrom]?.displayName ?? handoffFrom) : null;
  const toLabel = handoffTo ? (MODELS[handoffTo]?.displayName ?? handoffTo) : null;

  useEffect(() => {
    if (!handoffTo || !resp?.done || !resp.content.trim()) return;
    if (resp.streamStatus !== 'stalled' && resp.streamStatus !== 'retrying') return;
    if (!['stop', 'STOP', 'end_turn'].includes(resp.stopReason ?? resp.debug?.stopReason ?? '')) return;
    reconcileCompletedResponse(handoffTo, 'handoff');
  }, [handoffTo, reconcileCompletedResponse, resp]);

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0 overflow-hidden">
      {/* Handoff controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400">From:</label>
          <select
            value={handoffFrom ?? ''}
            onChange={(e) => setHandoffFrom(e.target.value || null)}
            disabled={isStreaming}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 disabled:opacity-50"
          >
            <option value="">Select model</option>
            {modelIds.map((id) => (
              <option key={id} value={id}>
                {MODELS[id].displayName}
              </option>
            ))}
          </select>
        </div>

        <span className="text-gray-600">-&gt;</span>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400">To:</label>
          <select
            value={handoffTo ?? ''}
            onChange={(e) => setHandoffTo(e.target.value || null)}
            disabled={isStreaming}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 disabled:opacity-50"
          >
            <option value="">Select model</option>
            {modelIds
              .filter((id) => id !== handoffFrom)
              .map((id) => (
                <option key={id} value={id}>
                  {MODELS[id].displayName}
                </option>
              ))}
          </select>
        </div>

        {!sessionId && (
          <span className="text-xs text-yellow-500">
            Start or reopen a shared session first
          </span>
        )}
      </div>

      {sessionId && handoffFrom && handoffTo && handoffFrom !== handoffTo && (
        <div className="rounded-lg border border-orange-900/50 bg-orange-950/20 px-4 py-3 text-xs text-orange-100">
          <div className="mb-1 font-semibold text-orange-300">What gets handed off</div>
          <div className="leading-relaxed text-orange-100/90">
            We pass the shared session context to <span className="font-semibold">{toLabel}</span>, including your conversation history, the latest formal outputs already stored in this session, and a handoff framing that says it is continuing work from <span className="font-semibold">{fromLabel}</span>.
            {instruction.trim() ? ' Your optional instruction is also appended as the explicit handoff request.' : ' You can add an optional instruction to tell the receiving model what kind of continuation or transformation you want.'}
          </div>
        </div>
      )}

      {/* Instruction input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Optional instruction for the handoff..."
          disabled={isStreaming || !canHandoff}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleHandoff();
          }}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
        />
        <button
          onClick={handleHandoff}
          disabled={!canHandoff}
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isStreaming ? 'Streaming...' : 'Handoff'}
        </button>
      </div>

      {/* Handoff response */}
      {resp && handoffTo && (
        <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-hidden">
          {resp.done && !resp.error && (
            <div className="flex items-center justify-between rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-emerald-300">Continue With Recipient</div>
                <div className="text-xs text-emerald-100/80">
                  Switch back to Observer mode and keep working directly with {toLabel} in this same shared session.
                </div>
              </div>
              <button
                type="button"
                onClick={handleContinueWithRecipient}
                disabled={continueLoading}
                className="rounded-lg border border-emerald-700 bg-emerald-900/30 px-3 py-2 text-sm font-medium text-emerald-100 transition-colors hover:bg-emerald-900/50 disabled:opacity-50"
              >
                {continueLoading ? 'Switching...' : `Continue with ${toLabel}`}
              </button>
            </div>
          )}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <ResponsePanel
              model={handoffTo}
              content={resp.content}
              done={resp.done}
              error={resp.error}
              stopReason={resp.stopReason}
              modeLabel={resp.mode === 'handoff' ? 'Handoff' : resp.mode ?? 'Handoff'}
              responseMode={resp.mode}
              streamTarget="handoff"
              messageId={resp.messageId}
              sessionId={sessionId ?? undefined}
              streamStatus={resp.streamStatus}
              retryable={resp.retryable}
              partialRetained={resp.partialRetained}
              attempt={resp.attempt}
              debug={resp.debug}
              promptTokens={resp.promptTokens}
              completionTokens={resp.completionTokens}
              reasoningTokens={resp.reasoningTokens}
              cachedTokens={resp.cachedTokens}
              estimatedCostUsd={resp.estimatedCostUsd}
              pricingSource={resp.pricingSource}
            />
          </div>
        </div>
      )}
    </div>
  );
}
