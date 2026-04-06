'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MODELS, type RichPreviewArtifact } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import {
  deletePreviewArtifact,
  fetchPreviewArtifact,
  getObsidianSettings,
  promoteToMemory,
  retryModelResponse,
  saveObsidianSettings,
  savePreviewArtifact,
  saveQueryArtifactToWiki,
} from '@/lib/api';
import { buildPreviewDoc, extractRichPreview, isRichLikeContent, isValidPreviewSelection, previewArtifactToExtraction, repairStructuredOutput } from '@/lib/rich-preview';
import CopyWithProvenance from './CopyWithProvenance';
import SendToNotion from './SendToNotion';
import MarkdownContent from './MarkdownContent';

interface ResponsePanelProps {
  model: string;
  content: string;
  done: boolean;
  error?: string;
  stopReason?: string;
  modeLabel?: string | null;
  responseMode?: string | null;
  streamTarget?: 'observer' | 'parallel' | 'compare' | 'synthesize' | 'handoff';
  messageId?: string;
  sessionId?: string;
  streamStatus?: 'streaming' | 'stalled' | 'completed' | 'error' | 'retrying';
  retryable?: boolean;
  partialRetained?: boolean;
  attempt?: number;
  debug?: {
    chunkCount: number;
    contentChars: number;
    thinkingChars: number;
    stopReason?: string;
    providerError?: string;
    lastEvent?: string;
    note?: string;
  };
  /** Chain-of-thought / thinking content (separate from main response) */
  thinkingContent?: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  estimatedCostUsd?: number | null;
  pricingSource?: 'static_registry_estimate' | 'provider_usage_estimate' | 'provider_reconciled' | null;
  onHide?: () => void;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: () => void;
}

export default function ResponsePanel({
  model,
  content,
  done,
  error,
  stopReason,
  modeLabel,
  responseMode,
  streamTarget,
  messageId,
  sessionId,
  streamStatus,
  retryable,
  partialRetained,
  attempt,
  debug,
  thinkingContent,
  promptTokens,
  completionTokens,
  reasoningTokens,
  cachedTokens,
  estimatedCostUsd,
  pricingSource,
  onHide,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
}: ResponsePanelProps) {
  const config = MODELS[model];
  const displayName = config?.displayName ?? model;
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const timeline = useChatStore((s) => s.timeline);
  const autoExtraction = useMemo(() => extractRichPreview(content), [content]);
  const richLike = useMemo(() => isRichLikeContent(content), [content]);
  const truncatedByStopReason = stopReason === 'max_tokens' || stopReason === 'max_output_tokens';
  const [manualArtifact, setManualArtifact] = useState<RichPreviewArtifact | null>(null);
  const [previewMode, setPreviewMode] = useState<'preview' | 'source'>(autoExtraction.kind ? 'preview' : 'source');
  const [previewSource, setPreviewSource] = useState<'auto' | 'manual'>(manualArtifact ? 'manual' : 'auto');
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number; text: string } | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAutoKind = useRef(autoExtraction.kind);
  const keepPartial = useChatStore((s) => s.keepPartial);
  const currentSession = useChatStore((s) => s.currentSession);
  const [wikiSaving, setWikiSaving] = useState(false);
  const [wikiStatus, setWikiStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const inferredArtifactType = useMemo(() => {
    if (streamTarget === 'compare') return 'comparison' as const;
    if (streamTarget === 'synthesize') return 'synthesis' as const;
    return 'analysis' as const;
  }, [streamTarget]);

  const resolvedMessageId = useMemo(() => {
    if (messageId) return messageId;
    if (!sessionId) return null;
    const candidates = [...timeline]
      .reverse()
      .filter((entry) => entry.type === 'message' && entry.role === 'assistant' && entry.sourceModel === model);
    const exact = candidates.find((entry) => entry.content === content);
    return exact?.id ?? candidates[0]?.id ?? null;
  }, [content, messageId, model, sessionId, timeline]);

  const previousStructuredContent = useMemo(() => {
    if (!resolvedMessageId) return null;
    const currentIndex = timeline.findIndex((entry) => entry.type === 'message' && entry.id === resolvedMessageId);
    if (currentIndex <= 0) return null;
    for (let i = currentIndex - 1; i >= 0; i -= 1) {
      const entry = timeline[i];
      if (entry.type !== 'message' || entry.role !== 'assistant') continue;
      if (entry.sourceModel !== model) continue;
      return entry.content;
    }
    return null;
  }, [model, resolvedMessageId, timeline]);

  const repairResult = useMemo(
    () =>
      repairStructuredOutput({
        current: content,
        previous: previousStructuredContent,
        stopReason,
      }),
    [content, previousStructuredContent, stopReason],
  );
  const displayContent = repairResult.displayContent;
  const displayRichLike = useMemo(() => isRichLikeContent(displayContent), [displayContent]);
  const displayStructuredIssue = repairResult.issue;

  const effectiveAutoExtraction = useMemo(
    () => (manualArtifact ? autoExtraction : extractRichPreview(displayContent)),
    [autoExtraction, displayContent, manualArtifact],
  );
  const effectiveExtraction = manualArtifact ? previewArtifactToExtraction(manualArtifact) : effectiveAutoExtraction;
  const richPreview = effectiveExtraction.kind;
  const previewDoc = useMemo(
    () => (effectiveExtraction.kind && effectiveExtraction.document ? buildPreviewDoc(effectiveExtraction.document, effectiveExtraction.kind) : ''),
    [effectiveExtraction],
  );

  useEffect(() => {
    if (effectiveAutoExtraction.kind && !lastAutoKind.current && !manualArtifact) {
      setPreviewMode('preview');
    }
    if (!effectiveAutoExtraction.kind && !manualArtifact) {
      setPreviewMode('source');
    }
    lastAutoKind.current = effectiveAutoExtraction.kind;
  }, [effectiveAutoExtraction.kind, manualArtifact]);

  useEffect(() => {
    if (!resolvedMessageId || !sessionId) {
      setManualArtifact(null);
      return;
    }
    let cancelled = false;
    fetchPreviewArtifact(sessionId, resolvedMessageId).then((artifact) => {
      if (cancelled) return;
      setManualArtifact(artifact);
      if (artifact) {
        setPreviewSource('manual');
        setPreviewMode('preview');
      } else {
        setPreviewSource('auto');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [resolvedMessageId, sessionId]);

  useEffect(() => {
    if (!streamTarget || !sessionId || error || !done || retrying) return;
    if (!truncatedByStopReason) return;
    if (repairResult.recoveredTail) return;
    if (repairResult.issue?.kind !== 'missing_tail') return;
    if ((attempt ?? 1) > 1) return;

    const autoKey = `prism:auto-cont:${sessionId}:${streamTarget}:${model}:${attempt ?? 1}`;
    try {
      if (sessionStorage.getItem(autoKey)) return;
      sessionStorage.setItem(autoKey, '1');
    } catch {}

    setRetrying(true);
    retryModelResponse(streamTarget, model, {
      continuationFrom: displayContent,
      richOutput: true,
      auto: true,
    }).finally(() => setRetrying(false));
  }, [
    attempt,
    displayContent,
    done,
    error,
    model,
    repairResult.issue?.kind,
    repairResult.recoveredTail,
    retrying,
    sessionId,
    streamTarget,
    truncatedByStopReason,
  ]);

  const showSourceAsTextarea = Boolean(displayRichLike || effectiveAutoExtraction.kind || manualArtifact);
  const showManualPreviewTools = showSourceAsTextarea && previewMode === 'source';

  const handleSelectionChange = () => {
    if (!sourceRef.current) return;
    const start = sourceRef.current.selectionStart ?? 0;
    const end = sourceRef.current.selectionEnd ?? 0;
    const text = sourceRef.current.value.slice(start, end);
    if (text.trim().length === 0) {
      setSelectionRange(null);
      return;
    }
    setSelectionRange({ start, end, text });
    setSelectionError(null);
  };

  const handleManualPreview = async (kind: 'html' | 'svg') => {
    if (!selectionRange || !resolvedMessageId || !sessionId) return;
    if (!isValidPreviewSelection(selectionRange.text, kind)) {
      setSelectionError(`Selected content is not valid ${kind.toUpperCase()}.`);
      return;
    }
    const artifact = await savePreviewArtifact(sessionId, resolvedMessageId, {
      previewKind: kind,
      selectedText: selectionRange.text,
      selectionStart: selectionRange.start,
      selectionEnd: selectionRange.end,
    });
    if (!artifact) {
      setSelectionError('Failed to save manual preview.');
      return;
    }
    setManualArtifact(artifact);
    setPreviewSource('manual');
    setPreviewMode('preview');
    setSelectionError(null);
  };

  const handleBackToAuto = async () => {
    if (resolvedMessageId && sessionId) {
      await deletePreviewArtifact(sessionId, resolvedMessageId);
    }
    setManualArtifact(null);
    setPreviewSource('auto');
    setPreviewMode(effectiveAutoExtraction.kind ? 'preview' : 'source');
  };

  const handleRetry = async () => {
    if (!streamTarget) return;
    setRetrying(true);
    try {
      await retryModelResponse(streamTarget, model, {
        continuationFrom: displayContent,
        richOutput: Boolean(displayRichLike || displayStructuredIssue),
      });
    } finally {
      setRetrying(false);
    }
  };

  const handlePromoteToMemory = async () => {
    if (!sessionId || !resolvedMessageId || !content.trim()) return;
    setPromoting(true);
    try {
      const result = await promoteToMemory({
        sessionId,
        messageId: resolvedMessageId,
        content,
        title: `${displayName} response`,
        summary: content.slice(0, 220),
      });
      try {
        const candidates = result?.candidates ?? [];
        if (candidates.length > 0) {
          sessionStorage.setItem('prism:memory:focus-candidates', JSON.stringify(candidates.map((candidate) => candidate.id)));
        }
        if (result) {
          sessionStorage.setItem(
            'prism:memory:last-action',
            JSON.stringify({
              message: result.added > 0
                ? `Added ${result.added} memory candidate${result.added === 1 ? '' : 's'}${result.skippedDuplicates > 0 ? ` and skipped ${result.skippedDuplicates} duplicate${result.skippedDuplicates === 1 ? '' : 's'}` : ''}.`
                : `No new memory candidates were added${result.skippedDuplicates > 0 ? `; skipped ${result.skippedDuplicates} duplicate${result.skippedDuplicates === 1 ? '' : 's'}` : ''}.`,
            }),
          );
        }
      } catch {}
      useChatStore.getState().setMode('memory');
    } finally {
      setPromoting(false);
    }
  };

  const ensureObsidianVaultPath = async (): Promise<string | null> => {
    const settings = await getObsidianSettings();
    if (settings?.vaultPath) return settings.vaultPath;
    const next = window.prompt('Set your Obsidian vault path for Prism wiki exports');
    if (!next?.trim()) return null;
    const saved = await saveObsidianSettings(next.trim());
    return saved.vaultPath;
  };

  const handleSaveToWiki = async () => {
    if (!sessionId || !content.trim()) return;
    setWikiSaving(true);
    setWikiStatus(null);
    try {
      const vaultPath = await ensureObsidianVaultPath();
      if (!vaultPath) {
        setWikiStatus({ type: 'error', message: 'Obsidian vault path is required before saving to the wiki.' });
        return;
      }
      const titleBase = currentSession?.title || `${displayName} ${inferredArtifactType}`;
      const result = await saveQueryArtifactToWiki({
        sessionId,
        messageId: resolvedMessageId || undefined,
        sourceModel: model,
        title: `${titleBase} - ${displayName}`,
        content,
        artifactType: inferredArtifactType,
        streamTarget: (streamTarget ?? 'prompt') as 'prompt' | 'observer' | 'parallel' | 'compare' | 'synthesize',
        vaultPath,
      });
      setWikiStatus({ type: 'success', message: `Saved to wiki: ${result.relativePath}` });
    } catch (error: any) {
      setWikiStatus({ type: 'error', message: error?.message || 'Failed to save this response to the wiki.' });
    } finally {
      setWikiSaving(false);
    }
  };

  const statusLabel =
    streamStatus === 'retrying'
      ? 'Retrying...'
      : streamStatus === 'stalled'
        ? retryable
          ? 'Stalled'
          : 'Looks stuck...'
        : !done
          ? 'Streaming...'
          : done && error
            ? 'error'
            : done && content
              ? 'done'
              : null;
  const hasUsage = (promptTokens ?? 0) > 0 || (completionTokens ?? 0) > 0 || (reasoningTokens ?? 0) > 0 || (estimatedCostUsd ?? 0) > 0;
  const costLabel = typeof estimatedCostUsd === 'number' ? `$${estimatedCostUsd.toFixed(4)}` : null;
  const pricingLabel =
    pricingSource === 'provider_reconciled'
      ? 'Reconciled'
      : pricingSource === 'provider_usage_estimate'
        ? 'Usage-based'
        : pricingSource === 'static_registry_estimate'
          ? 'Estimated'
          : null;

  return (
    <div
      className="flex-1 min-w-0 min-h-0 h-full max-h-full overflow-hidden bg-gray-900 border border-gray-800 rounded-lg flex flex-col"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-200">{displayName}</span>
          {modeLabel && (
            <span className="rounded bg-indigo-900/40 px-1.5 py-0.5 text-[10px] text-indigo-300">
              {modeLabel}
            </span>
          )}
          {richPreview && (
            <span className="rounded bg-cyan-900/40 px-1.5 py-0.5 text-[10px] text-cyan-300">
              {richPreview === 'svg' ? 'SVG Preview' : 'HTML Preview'}
            </span>
          )}
          {richPreview && (
            <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-300">
              {previewSource === 'manual' ? 'Preview selected manually' : 'Preview extracted automatically'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(richPreview || showSourceAsTextarea) && (
            <div className="mr-1 flex items-center gap-1 rounded border border-gray-700 bg-gray-950/60 p-0.5">
              {richPreview && (
                <button
                  type="button"
                  onClick={() => setPreviewMode('preview')}
                  className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${previewMode === 'preview' ? 'bg-cyan-900/50 text-cyan-200' : 'text-gray-400 hover:text-white'}`}
                >
                  Preview
                </button>
              )}
              <button
                type="button"
                onClick={() => setPreviewMode('source')}
                className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${previewMode === 'source' ? 'bg-gray-800 text-gray-200' : 'text-gray-400 hover:text-white'}`}
              >
                Source
              </button>
              {manualArtifact && (
                <button
                  type="button"
                  onClick={handleBackToAuto}
                  className="rounded px-1.5 py-0.5 text-[10px] text-amber-300 transition-colors hover:bg-amber-900/20"
                >
                  Back to Auto
                </button>
              )}
            </div>
          )}
          {draggable && (
            <span
              className="cursor-grab select-none rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-500"
              title="Drag to reorder"
            >
              Drag
            </span>
          )}
          {thinkingContent && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-400 font-medium">
              💭 Thinking
            </span>
          )}
          {attempt && attempt > 1 && (
            <span className="text-[10px] rounded bg-amber-900/30 px-1.5 py-0.5 text-amber-300">
              retry #{attempt}
            </span>
          )}
          {statusLabel && (
            <span
              className={`text-xs ${
                streamStatus === 'stalled'
                  ? 'text-amber-400'
                  : streamStatus === 'retrying' || !done
                    ? 'text-indigo-400'
                    : done && error
                      ? 'text-red-400'
                      : 'text-green-400'
              } ${streamStatus === 'retrying' || (!done && !error) ? 'animate-pulse' : ''}`}
            >
              {statusLabel}
            </span>
          )}
          {(retryable || (streamTarget && done && !error && (displayStructuredIssue || truncatedByStopReason))) && streamTarget && (
            <>
              <button
                type="button"
                onClick={handleRetry}
                disabled={retrying}
                className="rounded border border-amber-700 px-1.5 py-0.5 text-[10px] text-amber-200 transition-colors hover:bg-amber-900/20 disabled:opacity-50"
              >
                {(displayStructuredIssue || truncatedByStopReason) && !retryable ? 'Retry Output' : 'Retry'}
              </button>
              {retryable && (
                <button
                  type="button"
                  onClick={() => keepPartial(model, streamTarget)}
                  className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-300 transition-colors hover:bg-gray-800"
                >
                  Keep Partial
                </button>
              )}
            </>
          )}
          {partialRetained && !retryable && (
            <span className="text-[10px] rounded bg-gray-800 px-1.5 py-0.5 text-gray-300">
              partial kept
            </span>
          )}
          {done && !error && stopReason && (
            <span className="text-[10px] rounded bg-gray-800 px-1.5 py-0.5 text-gray-300">
              Stopped: {stopReason}
            </span>
          )}
          {done && !error && content && sessionId && resolvedMessageId && (
            <button
              type="button"
              onClick={handlePromoteToMemory}
              disabled={promoting}
              className="rounded border border-indigo-700 px-1.5 py-0.5 text-[10px] text-indigo-200 transition-colors hover:bg-indigo-900/20 disabled:opacity-50"
            >
              {promoting ? 'Promoting...' : 'Promote to Memory'}
            </button>
          )}
          {done && !error && content && sessionId && (
            <button
              type="button"
              onClick={handleSaveToWiki}
              disabled={wikiSaving}
              className="rounded border border-cyan-700 px-1.5 py-0.5 text-[10px] text-cyan-200 transition-colors hover:bg-cyan-900/20 disabled:opacity-50"
            >
              {wikiSaving ? 'Saving to Wiki...' : 'Save to Wiki'}
            </button>
          )}
          {onHide && (
            <button
              type="button"
              onClick={onHide}
              className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400 transition-colors hover:border-gray-600 hover:text-white"
              title="Hide this panel"
            >
              Hide
            </button>
          )}
        </div>
      </div>
      {hasUsage && (
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-800 px-4 py-2 text-[11px] text-gray-400">
          {costLabel && (
            <span className="rounded bg-emerald-950/50 px-1.5 py-0.5 text-emerald-300">
              {costLabel}
            </span>
          )}
          {promptTokens !== undefined && promptTokens !== null && <span>in {promptTokens.toLocaleString()} tok</span>}
          {completionTokens !== undefined && completionTokens !== null && <span>out {completionTokens.toLocaleString()} tok</span>}
          {(reasoningTokens ?? 0) > 0 && <span>reasoning {(reasoningTokens ?? 0).toLocaleString()} tok</span>}
          {(cachedTokens ?? 0) > 0 && <span>cached {(cachedTokens ?? 0).toLocaleString()} tok</span>}
          {pricingLabel && <span className="rounded bg-gray-800 px-1.5 py-0.5 text-gray-300">{pricingLabel}</span>}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden p-4 flex flex-col">
        {error ? (
          <p className="text-red-400 text-sm">{error}</p>
        ) : (
          <>
            {/* Thinking / Chain-of-Thought section */}
            {thinkingContent && (
              <div className="mb-3">
                <button
                  onClick={() => setThinkingExpanded(!thinkingExpanded)}
                  className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 transition-colors mb-1"
                >
                  <svg
                    className={`w-3 h-3 transition-transform ${thinkingExpanded ? 'rotate-90' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="font-medium">Chain of Thought</span>
                  <span className="text-[10px] text-purple-600">
                    ({(thinkingContent.length / 4).toFixed(0)} tokens est.)
                  </span>
                </button>
                {thinkingExpanded && (
                  <div className="bg-gray-950 border border-purple-900/30 rounded-md p-3 text-xs text-gray-500 font-mono whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
                    {thinkingContent}
                  </div>
                )}
              </div>
            )}

            {(displayStructuredIssue || truncatedByStopReason) && done && !error && (
              <div className="mb-3 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
                <div className="font-semibold text-amber-300">
                  {displayStructuredIssue?.title ?? 'Structured output may be incomplete'}
                </div>
                <div className="mt-1 text-amber-100/90">
                  {truncatedByStopReason
                    ? `The model stopped because it hit its output token limit (${stopReason}).`
                    : displayStructuredIssue?.reason}
                </div>
                <div className="mt-1 text-[11px] text-amber-100/80">
                  You can retry this step, or keep the current partial output and manually preview the usable portion.
                </div>
              </div>
            )}

            {debug && (error || stopReason || streamStatus === 'stalled' || streamStatus === 'retrying') && (
              <div className="mb-3 rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-2 text-[11px] text-gray-300">
                <div className="mb-1 font-semibold uppercase tracking-wider text-gray-400">Debug</div>
                <div className="font-mono">
                  chunks {debug.chunkCount} · content {debug.contentChars} chars · thinking {debug.thinkingChars} chars
                  {debug.stopReason ? ` · stop ${debug.stopReason}` : ''}
                  {debug.lastEvent ? ` · event ${debug.lastEvent}` : ''}
                </div>
                {debug.providerError && (
                  <div className="mt-1 font-mono text-red-300">provider error: {debug.providerError}</div>
                )}
                {debug.note && (
                  <div className="mt-1 text-gray-400">{debug.note}</div>
                )}
              </div>
            )}

            {repairResult.mergedWithPrevious && (
              <div className="mb-3 rounded-lg border border-cyan-900/40 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-200">
                <div className="font-semibold text-cyan-300">
                  {repairResult.recoveredHeader && repairResult.recoveredTail
                    ? 'Recovered header and tail from neighboring outputs'
                    : repairResult.recoveredHeader
                      ? 'Recovered header from previous output'
                      : repairResult.recoveredTail
                        ? 'Recovered tail via continuation'
                        : 'Merged with previous partial output'}
                </div>
                <div className="mt-1 text-cyan-100/90">
                  Prism detected this reply as part of the same structured artifact and combined it with the adjacent incomplete output for preview and source rendering.
                </div>
              </div>
            )}

            {wikiStatus && (
              <div
                className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
                  wikiStatus.type === 'success'
                    ? 'border-emerald-900/40 bg-emerald-950/20 text-emerald-200'
                    : 'border-red-900/40 bg-red-950/20 text-red-200'
                }`}
              >
                {wikiStatus.message}
              </div>
            )}

            {/* Main response */}
            <div className="flex items-start gap-2 flex-1 min-h-0 overflow-hidden">
              <div className="flex-1 min-h-0 h-full overflow-y-auto pr-1">
                {content ? (
                  richPreview && previewMode === 'preview' ? (
                    <div className="h-full min-h-[320px] overflow-hidden rounded-lg border border-cyan-900/40 bg-gray-950/70">
                      <iframe
                        title={`${displayName} preview`}
                        sandbox="allow-scripts allow-same-origin"
                        srcDoc={previewDoc}
                        className="h-full min-h-[320px] w-full bg-white"
                      />
                    </div>
                  ) : (
                    showSourceAsTextarea ? (
                      <div className="space-y-2">
                        <textarea
                          ref={sourceRef}
                          readOnly
                          value={displayContent}
                          onMouseUp={handleSelectionChange}
                          onKeyUp={handleSelectionChange}
                          className="h-full min-h-[320px] w-full resize-none rounded-lg border border-gray-800 bg-gray-950/70 p-3 font-mono text-xs leading-relaxed text-gray-300 outline-none"
                        />
                        {!richPreview && displayRichLike && (
                          <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200">
                            Prism detected possible HTML/SVG content in this mixed response. You can select the rich block below and use
                            {' '}<span className="font-semibold">Preview as HTML</span> or{' '}
                            <span className="font-semibold">Preview as SVG</span>.
                          </div>
                        )}
                        {showManualPreviewTools && (
                          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-2">
                            <span className="text-[11px] text-gray-400">
                              {selectionRange
                                ? `Selected ${selectionRange.text.length} chars`
                                : 'Select a block from the source to preview it as HTML or SVG'}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleManualPreview('html')}
                              disabled={!selectionRange}
                              className="rounded border border-cyan-800 px-2 py-1 text-[11px] text-cyan-200 transition-colors hover:bg-cyan-900/20 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Preview as HTML
                            </button>
                            <button
                              type="button"
                              onClick={() => handleManualPreview('svg')}
                              disabled={!selectionRange}
                              className="rounded border border-cyan-800 px-2 py-1 text-[11px] text-cyan-200 transition-colors hover:bg-cyan-900/20 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Preview as SVG
                            </button>
                            {selectionError && (
                              <span className="text-[11px] text-red-400">{selectionError}</span>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <MarkdownContent content={displayContent} />
                    )
                  )
                ) : (
                  <p className="text-gray-600 text-sm">Waiting for response...</p>
                )}
              </div>
              {done && !error && content && sessionId && (
                <div className="flex flex-col gap-1 flex-shrink-0 mt-1">
                  <CopyWithProvenance
                    content={content}
                    messageId={resolvedMessageId || `response-${model}-${Date.now()}`}
                    sourceType="native"
                    sourceId={sessionId}
                    sourceModel={model}
                  />
                  <SendToNotion
                    content={content}
                    sessionId={sessionId}
                    messageId={resolvedMessageId || `response-${model}-${Date.now()}`}
                    sourceModel={model}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
