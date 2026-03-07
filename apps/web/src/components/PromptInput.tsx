'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { streamPrompt, classifyPrompt, createDraft, fetchEntities, fetchEntityDetail, fetchFile, createSession, uploadFile } from '@/lib/api';
import { toast } from '@/stores/toast-store';
import { extractKeywords } from '@/lib/keyword-extractor';
import ContextualHintsPanel from '@/components/ContextualHintsPanel';
import FileUploadButton from '@/components/FileUploadButton';
import FileChip from '@/components/FileChip';
import type { ClassificationResult, KnowledgeHintMatch, UploadedFile } from '@prism/shared';

export default function PromptInput() {
  const [prompt, setPrompt] = useState('');
  const [suggestion, setSuggestion] = useState<ClassificationResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [commDrafting, setCommDrafting] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const mode = useChatStore((s) => s.mode);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const selectedModels = useChatStore((s) => s.selectedModels);
  const toggleModel = useChatStore((s) => s.toggleModel);
  const commSelectedThreadId = useChatStore((s) => s.commSelectedThreadId);
  const hintsEnabled = useChatStore((s) => s.knowledgeHintsEnabled);
  const sessionId = useChatStore((s) => s.sessionId);

  const isCommMode = mode === 'communication';

  // --- Drag-and-drop state ---
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0); // track nested enter/leave events

  const ACCEPTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.docx', '.xlsx', '.pptx'];
  const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

  const isAcceptedFile = useCallback((file: File) => {
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    return ACCEPTED_EXTENSIONS.includes(ext);
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    dragCounter.current = 0;

    if (isCommMode) return; // no file upload in comm mode

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    // Ensure session exists
    let sid = useChatStore.getState().sessionId;
    if (!sid) {
      sid = await createSession();
      if (sid) {
        useChatStore.getState().setSessionId(sid);
      } else {
        toast.error('Failed to create session for file upload.');
        return;
      }
    }

    let successCount = 0;
    let failCount = 0;

    for (const file of files) {
      if (!isAcceptedFile(file)) {
        toast.error(`"${file.name}" is not a supported file type.`);
        failCount++;
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        toast.error(`"${file.name}" exceeds 100MB limit.`);
        failCount++;
        continue;
      }

      const result = await uploadFile(sid, file);
      if (result) {
        handleFileUploaded(result);
        successCount++;
      } else {
        toast.error(`Failed to upload "${file.name}".`);
        failCount++;
      }
    }

    if (successCount > 0 && failCount === 0) {
      const msg = successCount === 1
        ? `"${files[0].name}" uploaded successfully.`
        : `${successCount} files uploaded successfully.`;
      toast.success(msg);
    } else if (successCount > 0 && failCount > 0) {
      toast.info(`${successCount} uploaded, ${failCount} failed.`);
    }
  }, [isCommMode, isAcceptedFile]);

  // Debounced classification (only in parallel mode)
  useEffect(() => {
    if (isCommMode) return;

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    const trimmed = prompt.trim();
    if (trimmed.length < 10) {
      setSuggestion(null);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      const result = await classifyPrompt(trimmed);
      setSuggestion(result);
      setDismissed(false);
    }, 500);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [prompt, isCommMode]);

  // Debounced Knowledge Hints (Scenario 1)
  useEffect(() => {
    if (isCommMode || !hintsEnabled) return;

    if (hintsDebounceRef.current) {
      clearTimeout(hintsDebounceRef.current);
    }

    const trimmed = prompt.trim();
    if (trimmed.length < 10) {
      useChatStore.getState().clearKnowledgeHints();
      return;
    }

    hintsDebounceRef.current = setTimeout(async () => {
      const store = useChatStore.getState();
      const keywords = extractKeywords(trimmed, 3);
      if (keywords.length === 0) {
        store.clearKnowledgeHints();
        return;
      }

      store.setKnowledgeHintLoading(true);

      try {
        // Search entities for each keyword and collect unique matches
        const entityMap = new Map<string, any>();
        const entityKeywordMap = new Map<string, string>(); // entityId → matched keyword

        for (const keyword of keywords) {
          try {
            const result = await fetchEntities({ search: keyword, limit: 3 });
            const entities = result.entities ?? [];
            for (const entity of entities) {
              if (!entityMap.has(entity.id)) {
                entityMap.set(entity.id, entity);
                entityKeywordMap.set(entity.id, keyword);
              }
            }
          } catch {
            // skip failed keyword search
          }
        }

        if (entityMap.size === 0) {
          store.setKnowledgeHintMatches([]);
          store.setKnowledgeHintLoading(false);
          return;
        }

        // Fetch details (mentions) for top 5 matched entities
        const topEntities = Array.from(entityMap.values()).slice(0, 5);
        const matches: KnowledgeHintMatch[] = [];

        for (const entity of topEntities) {
          try {
            const detail = await fetchEntityDetail(entity.id);
            const mentions = detail.mentions ?? [];

            // Count unique conversations/sessions
            const uniqueConversations = new Set<string>();
            for (const m of mentions) {
              if (m.sessionId) uniqueConversations.add(`s:${m.sessionId}`);
              if (m.conversationId) uniqueConversations.add(`c:${m.conversationId}`);
            }

            if (uniqueConversations.size > 0) {
              matches.push({
                entity,
                mentions,
                totalConversations: uniqueConversations.size,
                matchedKeyword: entityKeywordMap.get(entity.id),
              });
            }
          } catch {
            // skip failed entity detail fetch
          }
        }

        store.setKnowledgeHintMatches(matches);
      } catch (err) {
        console.error('[PromptInput] hints fetch error:', err);
        store.clearKnowledgeHints();
      } finally {
        store.setKnowledgeHintLoading(false);
      }
    }, 600); // slightly longer debounce than classification to avoid overloading

    return () => {
      if (hintsDebounceRef.current) {
        clearTimeout(hintsDebounceRef.current);
      }
    };
  }, [prompt, isCommMode, hintsEnabled]);

  // Clear uploaded files when session changes
  useEffect(() => {
    setUploadedFiles([]);
  }, [sessionId]);

  // Poll for file analysis status updates
  useEffect(() => {
    const pending = uploadedFiles.filter((f) => f.status === 'pending' || f.status === 'processing');
    if (pending.length === 0) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    if (!pollRef.current) {
      pollRef.current = setInterval(async () => {
        const updates = await Promise.all(
          uploadedFiles.map(async (f) => {
            if (f.status === 'pending' || f.status === 'processing') {
              const updated = await fetchFile(f.id);
              return updated ?? f;
            }
            return f;
          })
        );
        setUploadedFiles(updates);
      }, 2000);
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [uploadedFiles]);

  const handleFileUploaded = (file: UploadedFile) => {
    setUploadedFiles((prev) => [...prev, file]);
  };

  const handleFileRemoved = (fileId: string) => {
    setUploadedFiles((prev) => prev.filter((f) => f.id !== fileId));
  };

  // Clear hints on submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) return;

    if (isCommMode) {
      // Communication mode: trigger draft with the prompt as instruction
      if (!commSelectedThreadId || commDrafting) return;
      setCommDrafting(true);
      setPrompt('');
      const { draft } = await createDraft(commSelectedThreadId, { instruction: trimmed });
      if (draft) {
        // Store the draft so ThreadDetail can pick it up
        useChatStore.getState().setCommDrafts([draft]);
      }
      setCommDrafting(false);
    } else {
      // Parallel mode: send to selected models
      if (isStreaming || selectedModels.length === 0) return;
      setPrompt('');
      setSuggestion(null);
      setDismissed(false);
      useChatStore.getState().clearKnowledgeHints();
      streamPrompt(trimmed);
    }
  };

  const handleAccept = () => {
    if (suggestion) {
      toggleModel(suggestion.recommendedModel);
    }
    setDismissed(true);
  };

  const showChip =
    !isCommMode &&
    suggestion !== null &&
    !dismissed &&
    !isStreaming &&
    !selectedModels.includes(suggestion.recommendedModel);

  const isDisabled = isCommMode
    ? !prompt.trim() || !commSelectedThreadId || commDrafting
    : isStreaming || !prompt.trim() || selectedModels.length === 0;

  const buttonLabel = isCommMode
    ? commDrafting
      ? 'Drafting...'
      : 'Draft Reply'
    : isStreaming
      ? 'Streaming...'
      : 'Send';

  const placeholder = isCommMode
    ? 'Type an instruction for the reply (e.g. "politely decline this meeting")...'
    : 'Type your prompt...';

  return (
    <div
      className={`flex flex-col gap-2 relative rounded-xl transition-all ${
        dragOver ? 'ring-2 ring-indigo-500 bg-indigo-500/5' : ''
      }`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-indigo-900/20 border-2 border-dashed border-indigo-500 pointer-events-none">
          <div className="flex items-center gap-2 text-indigo-300 text-sm font-medium bg-gray-900/80 px-4 py-2 rounded-lg">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            Drop files to upload
          </div>
        </div>
      )}

      {showChip && suggestion && (
        <div className="flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm">
          <span className="text-indigo-400 font-medium whitespace-nowrap">
            {suggestion.displayName}
          </span>
          <span className="text-gray-400 truncate">{suggestion.reason}</span>
          <div className="flex items-center gap-2 ml-auto shrink-0">
            <button
              type="button"
              onClick={handleAccept}
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-1 rounded font-medium transition-colors"
            >
              + Add
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="text-gray-500 hover:text-gray-300 transition-colors"
            >
              &times;
            </button>
          </div>
        </div>
      )}

      {/* Knowledge Hints Panel (Scenario 1) */}
      {!isCommMode && hintsEnabled && <ContextualHintsPanel />}

      {/* Uploaded files */}
      {uploadedFiles.length > 0 && (
        <div className="px-1 py-1.5">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">
              Attached files ({uploadedFiles.length})
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {uploadedFiles.map((f) => (
              <FileChip key={f.id} file={f} onRemoved={handleFileRemoved} />
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        {!isCommMode && (
          <FileUploadButton
            onUploaded={handleFileUploaded}
            disabled={isStreaming}
          />
        )}
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={placeholder}
          disabled={isCommMode ? commDrafting : isStreaming}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={isDisabled}
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {buttonLabel}
        </button>
      </form>
    </div>
  );
}
