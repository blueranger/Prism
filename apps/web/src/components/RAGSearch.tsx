'use client';

import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { bootstrapSessionFromKB, ragSearch, ragAsk, ragGetStats, ragGetInventory, ragIndexFile, ragIndexSession, ragIndexLibraryConversation, ragIndexAll, switchToSession } from '@/lib/api';
import { useChatStore } from '@/stores/chat-store';
import type { RAGSourceType } from '@prism/shared';

interface RAGResult {
  chunk: {
    id: string;
    sourceType: string;
    sourceId: string;
    sessionId?: string;
    content: string;
    tokenCount: number;
    createdAt?: number;
  };
  score: number;
  sourceLabel: string;
  snippet: string;
  matchType: string;
  sourceMeta?: {
    sourceType: string;
    sourceId: string;
    sessionId?: string | null;
    conversationId?: string | null;
    sourcePlatform?: string | null;
    projectName?: string | null;
    workspaceName?: string | null;
    model?: string | null;
    sourceCreatedAt?: string | number | null;
    sourceUpdatedAt?: string | number | null;
    sourceLastActivityAt?: string | number | null;
    sourceSyncedAt?: string | number | null;
    citedAt?: string | number | null;
  };
}

interface InventoryFile {
  id: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  analysisStatus: string;
  analyzedBy: string | null;
  isIndexed: boolean;
  chunkCount: number;
  embeddingCount: number;
  createdAt: number;
}

interface InventorySession {
  sessionId: string;
  sessionTitle: string;
  createdAt: number;
  updatedAt: number;
  messages: {
    count: number;
    chunksIndexed: number;
    embeddingsIndexed: number;
    isIndexed: boolean;
  };
  files: InventoryFile[];
}

interface LibraryConversation {
  conversationId: string;
  title: string;
  sourcePlatform: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string | null;
  isIndexed: boolean;
  chunkCount: number;
  embeddingCount: number;
}

interface KBHistoryItem {
  id: string;
  query: string;
  mode: 'search' | 'ask';
  createdAt: number;
  resultCount?: number;
  answerPreview?: string;
}

const KB_HISTORY_KEY = 'prism_kb_history_v1';
const KB_LAST_STATE_KEY = 'prism_kb_last_state_v1';
const KB_HISTORY_LIMIT = 12;

interface KBLastState {
  query: string;
  searchMode: 'search' | 'ask';
  results: RAGResult[];
  answer: string | null;
  answerSources: RAGResult[];
  queryTimeMs: number;
  total: number;
  expandedChunk: string | null;
  citationExcerpts: Record<string, string>;
  showUncitedSources: boolean;
  selectedSourceNums: number[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatMaybeDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Injects clickable citation badges into a text string.
 * Used as a building block inside the Markdown renderer.
 */
function injectCitations(
  text: string,
  onCitationClick: (index: number) => void,
  highlightedCitation: number | null,
): ReactNode[] {
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (match) {
      const num = parseInt(match[1], 10);
      const isHighlighted = highlightedCitation === num;
      return (
        <button
          key={i}
          onClick={() => onCitationClick(num)}
          className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 mx-0.5 text-[10px] font-bold rounded transition-colors ${
            isHighlighted
              ? 'bg-indigo-500 text-white'
              : 'bg-indigo-900/60 text-indigo-300 hover:bg-indigo-700/80 hover:text-white'
          }`}
          title={`Go to source [${num}]`}
        >
          {num}
        </button>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

/**
 * Renders markdown content with inline citation badges [1], [2], etc.
 * Uses react-markdown for formatting, with custom text node processing for citations.
 */
function MarkdownWithCitations({
  text,
  onCitationClick,
  highlightedCitation,
}: {
  text: string;
  onCitationClick: (index: number) => void;
  highlightedCitation: number | null;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Intercept all text nodes to inject citation buttons
        p: ({ children, ...props }) => (
          <p {...props} className="mb-3 last:mb-0">
            {processChildren(children, onCitationClick, highlightedCitation)}
          </p>
        ),
        li: ({ children, ...props }) => (
          <li {...props} className="mb-1">
            {processChildren(children, onCitationClick, highlightedCitation)}
          </li>
        ),
        strong: ({ children, ...props }) => (
          <strong {...props} className="font-semibold text-gray-100">
            {processChildren(children, onCitationClick, highlightedCitation)}
          </strong>
        ),
        em: ({ children, ...props }) => (
          <em {...props}>
            {processChildren(children, onCitationClick, highlightedCitation)}
          </em>
        ),
        // Style headings
        h1: ({ children }) => <h3 className="text-base font-bold text-gray-100 mt-4 mb-2">{children}</h3>,
        h2: ({ children }) => <h4 className="text-sm font-bold text-gray-100 mt-3 mb-2">{children}</h4>,
        h3: ({ children }) => <h5 className="text-sm font-semibold text-gray-200 mt-2 mb-1">{children}</h5>,
        // Style lists
        ul: ({ children }) => <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>,
        // Style code
        code: ({ children, className }) => {
          const isBlock = className?.includes('language-');
          if (isBlock) {
            return (
              <code className="block bg-gray-900 rounded-md p-3 text-xs text-gray-300 overflow-x-auto my-2">
                {children}
              </code>
            );
          }
          return <code className="bg-gray-700/50 rounded px-1.5 py-0.5 text-xs text-indigo-300">{children}</code>;
        },
        // Style blockquotes
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-indigo-500/50 pl-3 my-2 text-gray-400 italic">
            {children}
          </blockquote>
        ),
        // Style tables
        table: ({ children }) => (
          <div className="overflow-x-auto my-3">
            <table className="text-xs border-collapse border border-gray-700 w-full">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-gray-700 bg-gray-800 px-2 py-1 text-left text-gray-300 font-medium">{children}</th>
        ),
        td: ({ children }) => (
          <td className="border border-gray-700 px-2 py-1 text-gray-400">{children}</td>
        ),
        // Style horizontal rules
        hr: () => <hr className="border-gray-700 my-3" />,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/** Process React children to inject citation buttons into any string children */
function processChildren(
  children: ReactNode,
  onCitationClick: (index: number) => void,
  highlightedCitation: number | null,
): ReactNode {
  if (!children) return children;
  if (typeof children === 'string') {
    return injectCitations(children, onCitationClick, highlightedCitation);
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === 'string') {
        return <span key={i}>{injectCitations(child, onCitationClick, highlightedCitation)}</span>;
      }
      return child;
    });
  }
  return children;
}

/**
 * Renders chunk content with the cited excerpt highlighted in a distinct color.
 * Uses fuzzy substring matching to handle minor whitespace differences.
 */
function HighlightedChunk({ content, excerpt }: { content: string; excerpt: string }) {
  if (!excerpt) return <>{content}</>;

  // Normalize whitespace for matching
  const normalizedContent = content.replace(/\s+/g, ' ');
  const normalizedExcerpt = excerpt.replace(/\s+/g, ' ').trim();

  // Try to find the excerpt in content
  const idx = normalizedContent.indexOf(normalizedExcerpt);
  if (idx === -1) {
    // If exact match fails, try finding a significant substring (first 40 chars)
    const shortExcerpt = normalizedExcerpt.slice(0, Math.min(40, normalizedExcerpt.length));
    const shortIdx = normalizedContent.indexOf(shortExcerpt);
    if (shortIdx === -1) {
      // No match found — just return content as-is
      return <>{content}</>;
    }
    // Highlight from short match start to approximate end
    const endIdx = Math.min(shortIdx + normalizedExcerpt.length, normalizedContent.length);
    // Map back to original content positions
    const origStart = mapNormalizedIndex(content, shortIdx);
    const origEnd = mapNormalizedIndex(content, endIdx);
    return (
      <>
        {content.slice(0, origStart)}
        <mark className="bg-indigo-500/30 text-indigo-200 rounded px-0.5">{content.slice(origStart, origEnd)}</mark>
        {content.slice(origEnd)}
      </>
    );
  }

  // Map normalized indices back to original content
  const origStart = mapNormalizedIndex(content, idx);
  const origEnd = mapNormalizedIndex(content, idx + normalizedExcerpt.length);

  return (
    <>
      {content.slice(0, origStart)}
      <mark className="bg-indigo-500/30 text-indigo-200 rounded px-0.5">{content.slice(origStart, origEnd)}</mark>
      {content.slice(origEnd)}
    </>
  );
}

/** Maps an index in the whitespace-normalized string back to the original string */
function mapNormalizedIndex(original: string, normalizedIdx: number): number {
  let ni = 0;
  let oi = 0;
  while (oi < original.length && ni < normalizedIdx) {
    if (/\s/.test(original[oi])) {
      // Consume all whitespace in original, but only one space in normalized
      while (oi < original.length && /\s/.test(original[oi])) oi++;
      ni++; // One space in normalized
    } else {
      oi++;
      ni++;
    }
  }
  return oi;
}

export default function RAGSearch() {
  const setMode = useChatStore((s) => s.setMode);
  const selectLibraryConversation = useChatStore((s) => s.selectLibraryConversation);

  // Tab: 'search' or 'inventory'
  const [tab, setTab] = useState<'search' | 'inventory'>('search');

  // Search state
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'search' | 'ask'>('ask');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<RAGResult[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const [answerSources, setAnswerSources] = useState<RAGResult[]>([]);
  const [queryTimeMs, setQueryTimeMs] = useState(0);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<any>(null);
  const [expandedChunk, setExpandedChunk] = useState<string | null>(null);
  const [highlightedCitation, setHighlightedCitation] = useState<number | null>(null);
  const [citationExcerpts, setCitationExcerpts] = useState<Record<string, string>>({});
  const [showUncitedSources, setShowUncitedSources] = useState(false);
  const [history, setHistory] = useState<KBHistoryItem[]>([]);
  const [selectedSourceNums, setSelectedSourceNums] = useState<Set<number>>(new Set());
  const [bootstrapModalOpen, setBootstrapModalOpen] = useState(false);
  const [bootstrappingSession, setBootstrappingSession] = useState(false);
  const sourceRefs = useRef<Map<number, HTMLElement>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  const hasHydratedLastStateRef = useRef(false);
  const skipNextSelectionDefaultsRef = useRef(false);

  // Compute which citation numbers appear in the answer text
  const { citedNums, citedSources, uncitedSources } = useMemo(() => {
    const nums = new Set<number>();
    if (answer) {
      // Use exec loop for maximum compatibility
      const regex = /\[(\d+)\]/g;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(answer)) !== null) {
        nums.add(parseInt(m[1], 10));
      }
    }
    const cited = answerSources
      .map((r, i) => ({ r, citationNum: i + 1 }))
      .filter(({ citationNum }) => nums.has(citationNum));
    const uncited = answerSources
      .map((r, i) => ({ r, citationNum: i + 1 }))
      .filter(({ citationNum }) => !nums.has(citationNum));
    return { citedNums: nums, citedSources: cited, uncitedSources: uncited };
  }, [answer, answerSources]);

  useEffect(() => {
    if (answerSources.length === 0) {
      setSelectedSourceNums(new Set());
      return;
    }
    if (skipNextSelectionDefaultsRef.current) {
      skipNextSelectionDefaultsRef.current = false;
      return;
    }
    const defaults = new Set<number>(
      citedSources.length > 0
        ? citedSources.map(({ citationNum }) => citationNum)
        : answerSources.map((_, index) => index + 1)
    );
    setSelectedSourceNums(defaults);
  }, [answerSources, citedSources]);

  // Inventory state
  const [inventory, setInventory] = useState<InventorySession[]>([]);
  const [library, setLibrary] = useState<LibraryConversation[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [indexingItems, setIndexingItems] = useState<Set<string>>(new Set());
  const [indexAllLoading, setIndexAllLoading] = useState(false);
  const [indexAllResult, setIndexAllResult] = useState<any>(null);

  // Load stats on mount
  useEffect(() => {
    ragGetStats().then(setStats);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KB_HISTORY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as KBHistoryItem[];
      if (Array.isArray(parsed)) {
        setHistory(parsed);
      }
    } catch (err) {
      console.warn('[RAGSearch] Failed to load KB history:', err);
    }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KB_LAST_STATE_KEY);
      if (!raw) {
        hasHydratedLastStateRef.current = true;
        return;
      }
      const parsed = JSON.parse(raw) as Partial<KBLastState>;
      if (typeof parsed.query === 'string') setQuery(parsed.query);
      if (parsed.searchMode === 'search' || parsed.searchMode === 'ask') setSearchMode(parsed.searchMode);
      if (Array.isArray(parsed.results)) setResults(parsed.results as RAGResult[]);
      if (parsed.answer === null || typeof parsed.answer === 'string') setAnswer(parsed.answer ?? null);
      if (Array.isArray(parsed.answerSources)) setAnswerSources(parsed.answerSources as RAGResult[]);
      if (typeof parsed.queryTimeMs === 'number') setQueryTimeMs(parsed.queryTimeMs);
      if (typeof parsed.total === 'number') setTotal(parsed.total);
      if (parsed.expandedChunk === null || typeof parsed.expandedChunk === 'string') setExpandedChunk(parsed.expandedChunk ?? null);
      if (parsed.citationExcerpts && typeof parsed.citationExcerpts === 'object') setCitationExcerpts(parsed.citationExcerpts as Record<string, string>);
      if (typeof parsed.showUncitedSources === 'boolean') setShowUncitedSources(parsed.showUncitedSources);
      if (Array.isArray(parsed.selectedSourceNums)) {
        skipNextSelectionDefaultsRef.current = true;
        setSelectedSourceNums(new Set(parsed.selectedSourceNums.filter((num): num is number => typeof num === 'number')));
      }
    } catch (err) {
      console.warn('[RAGSearch] Failed to restore last KB state:', err);
    } finally {
      hasHydratedLastStateRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!hasHydratedLastStateRef.current) return;
    const hasPersistableResult = answer !== null || results.length > 0 || answerSources.length > 0;
    if (!hasPersistableResult) return;

    const snapshot: KBLastState = {
      query,
      searchMode,
      results,
      answer,
      answerSources,
      queryTimeMs,
      total,
      expandedChunk,
      citationExcerpts,
      showUncitedSources,
      selectedSourceNums: Array.from(selectedSourceNums).sort((a, b) => a - b),
    };

    try {
      localStorage.setItem(KB_LAST_STATE_KEY, JSON.stringify(snapshot));
    } catch (err) {
      console.warn('[RAGSearch] Failed to persist last KB state:', err);
    }
  }, [
    answer,
    answerSources,
    citationExcerpts,
    expandedChunk,
    query,
    queryTimeMs,
    results,
    searchMode,
    selectedSourceNums,
    showUncitedSources,
    total,
  ]);

  // Load inventory when switching to inventory tab
  useEffect(() => {
    if (tab === 'inventory') {
      loadInventory();
    }
  }, [tab]);

  const loadInventory = async () => {
    setInventoryLoading(true);
    try {
      const data = await ragGetInventory();
      setInventory(data.sessions ?? []);
      setLibrary(data.library ?? []);
    } catch (err) {
      console.error('[RAGSearch] Failed to load inventory:', err);
    } finally {
      setInventoryLoading(false);
    }
  };

  const persistHistory = useCallback((next: KBHistoryItem[]) => {
    setHistory(next);
    try {
      localStorage.setItem(KB_HISTORY_KEY, JSON.stringify(next));
    } catch (err) {
      console.warn('[RAGSearch] Failed to persist KB history:', err);
    }
  }, []);

  const addHistoryEntry = useCallback((entry: Omit<KBHistoryItem, 'id' | 'createdAt'>) => {
    const nextEntry: KBHistoryItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      ...entry,
    };
    const next = [
      nextEntry,
      ...history.filter((item) => !(item.query === entry.query && item.mode === entry.mode)),
    ].slice(0, KB_HISTORY_LIMIT);
    persistHistory(next);
  }, [history, persistHistory]);

  const clearHistory = useCallback(() => {
    persistHistory([]);
  }, [persistHistory]);

  const handleCitationClick = useCallback((citationNum: number) => {
    setHighlightedCitation(citationNum);
    // Auto-expand the corresponding source chunk
    if (answerSources[citationNum - 1]) {
      setExpandedChunk(answerSources[citationNum - 1].chunk.id);
    }
    // If the citation is in the uncited section, expand it first
    if (!citedNums.has(citationNum)) {
      setShowUncitedSources(true);
    }
    // Scroll to the corresponding source element (longer delay to allow section expand + chunk expand)
    setTimeout(() => {
      const el = sourceRefs.current.get(citationNum);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 150);
    // Clear highlight after 3 seconds
    setTimeout(() => setHighlightedCitation(null), 3000);
  }, [answerSources, citedNums]);

  const handleSourceNavigate = useCallback(async (result: RAGResult) => {
    const sourceMeta = result.sourceMeta;
    if (sourceMeta?.conversationId) {
      setMode('library');
      await selectLibraryConversation(sourceMeta.conversationId);
      return;
    }

    const sessionId = sourceMeta?.sessionId || result.chunk.sessionId;
    if (sessionId) {
      setMode('observer');
      await switchToSession(sessionId);
    }
  }, [selectLibraryConversation, setMode]);

  const toggleSourceSelection = useCallback((citationNum: number) => {
    setSelectedSourceNums((prev) => {
      const next = new Set(prev);
      if (next.has(citationNum)) next.delete(citationNum);
      else next.add(citationNum);
      return next;
    });
  }, []);

  const selectAllBootstrapSources = useCallback(() => {
    setSelectedSourceNums(new Set(answerSources.map((_, index) => index + 1)));
  }, [answerSources]);

  const deselectAllBootstrapSources = useCallback(() => {
    setSelectedSourceNums(new Set());
  }, []);

  const handleStartSessionFromKB = useCallback(async () => {
    if (!answer) return;
    const selectedSources = answerSources
      .map((source, index) => ({ source, citationNum: index + 1 }))
      .filter(({ citationNum }) => selectedSourceNums.has(citationNum))
      .map(({ source, citationNum }) => ({
        sourceType: source.chunk.sourceType as RAGSourceType,
        sourceId: source.chunk.sourceId,
        sessionId: source.sourceMeta?.sessionId ?? source.chunk.sessionId ?? null,
        conversationId: source.sourceMeta?.conversationId ?? null,
        sourceLabel: source.sourceLabel,
        sourcePlatform: source.sourceMeta?.sourcePlatform ?? null,
        excerpt: citationExcerpts[String(citationNum)] || source.snippet || '',
        sourceCreatedAt: source.sourceMeta?.sourceCreatedAt ?? null,
        sourceLastActivityAt: source.sourceMeta?.sourceLastActivityAt ?? null,
        citedAt: source.sourceMeta?.citedAt ?? null,
      }));

    if (selectedSources.length === 0) return;

    setBootstrappingSession(true);
    try {
      const result = await bootstrapSessionFromKB({
        origin: 'kb',
        query,
        answer,
        citations: citationExcerpts,
        selectedSources,
        suggestedTitle: query.trim() || undefined,
        activeModel: useChatStore.getState().selectedModels[0] ?? null,
        observerModels: useChatStore.getState().selectedModels.slice(1, 3),
      });
      if (!result?.sessionId) throw new Error('Failed to create session');
      setBootstrapModalOpen(false);
      setMode('observer');
      await switchToSession(result.sessionId);
    } catch (err) {
      console.error('[RAGSearch] bootstrap session error:', err);
    } finally {
      setBootstrappingSession(false);
    }
  }, [answer, answerSources, selectedSourceNums, citationExcerpts, query, setMode]);

  const handleSubmit = useCallback(async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setAnswer(null);
    setAnswerSources([]);
    setResults([]);
    setHighlightedCitation(null);
    setCitationExcerpts({});
    setShowUncitedSources(false);
    sourceRefs.current.clear();

    try {
      if (searchMode === 'search') {
        const res = await ragSearch(query.trim());
        setResults(res.results ?? []);
        setTotal(res.total ?? 0);
        setQueryTimeMs(res.queryTimeMs ?? 0);
        addHistoryEntry({
          query: query.trim(),
          mode: 'search',
          resultCount: res.total ?? 0,
        });
      } else {
        const res = await ragAsk(query.trim());
        if (res) {
          setAnswer(res.answer ?? '');
          setAnswerSources(res.sources ?? []);
          setCitationExcerpts(res.citations ?? {});
          setQueryTimeMs(res.queryTimeMs ?? 0);
          addHistoryEntry({
            query: query.trim(),
            mode: 'ask',
            resultCount: (res.sources ?? []).length,
            answerPreview: (res.answer ?? '').slice(0, 140),
          });
        }
      }
    } catch (err) {
      console.error('[RAGSearch] Error:', err);
    } finally {
      setLoading(false);
    }
  }, [query, searchMode, loading, addHistoryEntry]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleIndexFile = async (fileId: string) => {
    setIndexingItems((prev) => new Set(prev).add(`file:${fileId}`));
    try {
      await ragIndexFile(fileId);
      // Reload inventory to reflect changes
      await loadInventory();
      ragGetStats().then(setStats);
    } finally {
      setIndexingItems((prev) => {
        const next = new Set(prev);
        next.delete(`file:${fileId}`);
        return next;
      });
    }
  };

  const handleIndexLibrary = async (conversationId: string) => {
    setIndexingItems((prev) => new Set(prev).add(`lib:${conversationId}`));
    try {
      await ragIndexLibraryConversation(conversationId);
      await loadInventory();
      ragGetStats().then(setStats);
    } finally {
      setIndexingItems((prev) => {
        const next = new Set(prev);
        next.delete(`lib:${conversationId}`);
        return next;
      });
    }
  };

  const handleIndexSession = async (sessionId: string) => {
    setIndexingItems((prev) => new Set(prev).add(`session:${sessionId}`));
    try {
      await ragIndexSession(sessionId);
      await loadInventory();
      ragGetStats().then(setStats);
    } finally {
      setIndexingItems((prev) => {
        const next = new Set(prev);
        next.delete(`session:${sessionId}`);
        return next;
      });
    }
  };

  const handleIndexAll = async () => {
    setIndexAllLoading(true);
    setIndexAllResult(null);
    try {
      const result = await ragIndexAll();
      setIndexAllResult(result);
      // Reload inventory and stats to reflect changes
      await loadInventory();
      ragGetStats().then(setStats);
    } catch (err) {
      console.error('[RAGSearch] Index All failed:', err);
    } finally {
      setIndexAllLoading(false);
    }
  };

  const sourceIcon = (type: string) => {
    switch (type) {
      case 'uploaded_file': return '\u{1F4C4}';
      case 'message': return '\u{1F4AC}';
      default: return '\u{1F4CE}';
    }
  };

  const matchBadge = (type: string) => {
    switch (type) {
      case 'keyword': return { label: 'Keyword', cls: 'bg-blue-900/40 text-blue-400' };
      case 'semantic': return { label: 'Semantic', cls: 'bg-purple-900/40 text-purple-400' };
      default: return { label: 'Hybrid', cls: 'bg-green-900/40 text-green-400' };
    }
  };

  // Count totals for inventory summary
  const totalFiles = inventory.reduce((sum, s) => sum + s.files.length, 0);
  const indexedFiles = inventory.reduce((sum, s) => sum + s.files.filter((f) => f.isIndexed).length, 0);
  const unindexedFiles = totalFiles - indexedFiles;
  const totalLibrary = library.length;
  const indexedLibrary = library.filter((c) => c.isIndexed).length;
  const unindexedLibrary = totalLibrary - indexedLibrary;
  const totalUnindexed = unindexedFiles + unindexedLibrary;

  const canNavigateToSource = useCallback((result: RAGResult) => {
    return Boolean(result.sourceMeta?.conversationId || result.sourceMeta?.sessionId || result.chunk.sessionId);
  }, []);

  const renderSourceMetadata = useCallback((result: RAGResult, variant: 'default' | 'inline' = 'default') => {
    const meta = result.sourceMeta;
    if (!meta) return null;

    const rows: string[] = [];
    const citedAt = formatMaybeDate(meta.citedAt);
    const createdAt = formatMaybeDate(meta.sourceCreatedAt);
    const lastActivityAt = formatMaybeDate(meta.sourceLastActivityAt);
    const updatedAt = formatMaybeDate(meta.sourceUpdatedAt);
    const syncedAt = formatMaybeDate(meta.sourceSyncedAt);

    if (meta.projectName) rows.push(`Project: ${meta.projectName}`);
    if (meta.workspaceName) rows.push(`Workspace: ${meta.workspaceName}`);
    if (meta.model) rows.push(`Model: ${meta.model}`);
    if (citedAt) rows.push(`Cited discussion: ${citedAt}`);
    if (createdAt) rows.push(`Started: ${createdAt}`);
    if (lastActivityAt) rows.push(`Last discussed: ${lastActivityAt}`);
    if (!lastActivityAt && updatedAt) rows.push(`Last updated: ${updatedAt}`);
    if (syncedAt) rows.push(`Synced to Prism: ${syncedAt}`);

    if (rows.length === 0) return null;

    return (
      <div className={`flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-gray-500 ${variant === 'inline' ? '' : 'mt-2'}`}>
        {rows.map((row) => (
          <span key={row}>{row}</span>
        ))}
      </div>
    );
  }, []);

  const renderBootstrapSourceMetadata = useCallback((source: RAGResult, citationNum: number) => {
    const meta = source.sourceMeta;
    if (!meta) return null;

    const rows: string[] = [];
    const citedAt = formatMaybeDate(meta.citedAt);
    const createdAt = formatMaybeDate(meta.sourceCreatedAt);
    const lastActivityAt = formatMaybeDate(meta.sourceLastActivityAt);
    const updatedAt = formatMaybeDate(meta.sourceUpdatedAt);
    const syncedAt = formatMaybeDate(meta.sourceSyncedAt);

    if (meta.projectName) rows.push(`Project: ${meta.projectName}`);
    if (meta.workspaceName) rows.push(`Workspace: ${meta.workspaceName}`);
    if (meta.model) rows.push(`Model: ${meta.model}`);
    if (citedAt) rows.push(`Cited discussion: ${citedAt}`);
    if (createdAt) rows.push(`Started: ${createdAt}`);
    if (lastActivityAt) rows.push(`Last discussed: ${lastActivityAt}`);
    if (!lastActivityAt && updatedAt) rows.push(`Last updated: ${updatedAt}`);
    if (syncedAt) rows.push(`Synced to Prism: ${syncedAt}`);

    if (rows.length === 0) return null;

    return (
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-gray-500">
        {rows.map((row) => (
          <span key={`${citationNum}-${row}`}>{row}</span>
        ))}
      </div>
    );
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-200">Knowledge Base</h2>
          {stats && (
            <span className="text-xs text-gray-500">
              {stats.totalChunks} chunks · {stats.totalEmbeddings} embeddings · {stats.indexedFiles} files · {stats.indexedSessions} sessions · {stats.indexedLibrary ?? 0} library
            </span>
          )}
        </div>

        {/* Tab Toggle */}
        <div className="flex bg-gray-800 rounded-lg p-0.5">
          <button
            onClick={() => setTab('search')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              tab === 'search' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Search / Ask
          </button>
          <button
            onClick={() => setTab('inventory')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              tab === 'inventory' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Coverage
            {totalUnindexed > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 text-[9px] font-bold bg-amber-500/80 text-white rounded-full">
                {totalUnindexed}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ───── SEARCH TAB ───── */}
      {tab === 'search' && (
        <>
          {/* Search Bar */}
          <div className="flex gap-2 mb-4">
            <div className="flex bg-gray-800 rounded-lg p-0.5">
              <button
                onClick={() => { setSearchMode('ask'); setResults([]); setAnswer(null); setAnswerSources([]); setTotal(0); setQueryTimeMs(0); setExpandedChunk(null); setCitationExcerpts({}); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  searchMode === 'ask' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                Ask
              </button>
              <button
                onClick={() => { setSearchMode('search'); setResults([]); setAnswer(null); setAnswerSources([]); setTotal(0); setQueryTimeMs(0); setExpandedChunk(null); setCitationExcerpts({}); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  searchMode === 'search' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                Search
              </button>
            </div>

            <div className="flex-1 relative">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={searchMode === 'ask' ? 'Ask a question about your documents and conversations...' : 'Search your knowledge base...'}
                className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
              />
              {loading && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <span className="inline-block w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>

            <button
              onClick={handleSubmit}
              disabled={!query.trim() || loading}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {searchMode === 'ask' ? 'Ask' : 'Search'}
            </button>
          </div>

          {history.length > 0 && (
            <div className="mb-4 rounded-xl border border-gray-700 bg-gray-800/30 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                  Recent History
                </div>
                <button
                  onClick={clearHistory}
                  className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Clear
                </button>
              </div>
              <div className="space-y-1.5">
                {history.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setQuery(item.query);
                      setSearchMode(item.mode);
                      inputRef.current?.focus();
                    }}
                    className="w-full text-left rounded-lg px-2.5 py-2 hover:bg-gray-700/40 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                        item.mode === 'ask'
                          ? 'bg-indigo-900/50 text-indigo-300'
                          : 'bg-gray-700 text-gray-300'
                      }`}>
                        {item.mode === 'ask' ? 'Ask' : 'Search'}
                      </span>
                      <span className="text-xs text-gray-200 truncate">{item.query}</span>
                      <span className="ml-auto text-[10px] text-gray-500">
                        {formatDate(item.createdAt)}
                      </span>
                    </div>
                    {(item.answerPreview || item.resultCount !== undefined) && (
                      <div className="mt-1 text-[10px] text-gray-500 truncate">
                        {item.answerPreview || `${item.resultCount} result${item.resultCount === 1 ? '' : 's'}`}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Results Area */}
          <div className="flex-1 overflow-y-auto space-y-3">
            {/* Q&A Answer */}
            {answer !== null && (
              <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-indigo-400 text-sm font-medium">Answer</span>
                  <span className="text-xs text-gray-500">{queryTimeMs}ms</span>
                  <div className="ml-auto">
                    <button
                      onClick={() => setBootstrapModalOpen(true)}
                      disabled={selectedSourceNums.size === 0}
                      className="px-2.5 py-1 text-[11px] rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Start Session
                    </button>
                  </div>
                </div>
                <div className="text-sm text-gray-200 leading-relaxed">
                  <MarkdownWithCitations
                    text={answer}
                    onCitationClick={handleCitationClick}
                    highlightedCitation={highlightedCitation}
                  />
                </div>

                {answerSources.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-gray-700">
                    {/* Debug: show detected citations */}
                    {citedSources.length === 0 && answerSources.length > 0 && (
                      <div className="text-[10px] text-amber-500/70 mb-2">
                        {citedNums.size > 0
                          ? `Detected citations: [${Array.from(citedNums).join(', ')}]`
                          : 'No inline citations detected in answer'}
                      </div>
                    )}

                    {/* Cited Sources */}
                    {citedSources.length > 0 && (
                      <>
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-2">
                          Cited Sources ({citedSources.length})
                        </div>
                        <div className="space-y-1.5">
                          {citedSources.map(({ r, citationNum }) => {
                            const isHighlighted = highlightedCitation === citationNum;
                            const isExpanded = expandedChunk === r.chunk.id;
                            return (
                              <div
                                key={citationNum}
                                ref={(el) => { if (el) sourceRefs.current.set(citationNum, el); }}
                                className={`rounded-lg transition-all duration-300 ${
                                  isHighlighted
                                    ? 'bg-indigo-900/40 border border-indigo-500/60 ring-1 ring-indigo-500/30'
                                    : 'hover:bg-gray-700/50'
                                }`}
                              >
                                <button
                                  onClick={() => setExpandedChunk(isExpanded ? null : r.chunk.id)}
                                  className="w-full text-left flex items-center gap-2 px-2 py-1.5"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedSourceNums.has(citationNum)}
                                    onChange={(event) => {
                                      event.stopPropagation();
                                      toggleSourceSelection(citationNum);
                                    }}
                                    onClick={(event) => event.stopPropagation()}
                                    className="accent-emerald-500"
                                  />
                                  <span className={`inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold rounded ${
                                    isHighlighted ? 'bg-indigo-500 text-white' : 'bg-indigo-700 text-indigo-200'
                                  }`}>
                                    {citationNum}
                                  </span>
                                  <span className="text-xs">{sourceIcon(r.chunk.sourceType)}</span>
                                  <span className="text-xs text-gray-300 truncate flex-1">{r.sourceLabel}</span>
                                  <span className="text-[10px] text-gray-500">{(r.score * 100).toFixed(0)}%</span>
                                  <span className="text-[10px] text-gray-600">{isExpanded ? '\u25B2' : '\u25BC'}</span>
                                </button>
                                <div className="px-9 pb-2 pr-6">
                                  {renderSourceMetadata(r, 'inline')}
                                </div>
                                {isExpanded && (
                                  <div className="px-3 pb-2 pt-1 ml-7">
                                    {canNavigateToSource(r) && (
                                      <div className="flex justify-end mb-2">
                                        <button
                                          onClick={() => { void handleSourceNavigate(r); }}
                                          className="text-[10px] px-2 py-1 rounded bg-gray-700 text-gray-200 hover:bg-gray-600 transition-colors"
                                        >
                                          Open in {r.sourceMeta?.conversationId ? 'Library' : 'Session'}
                                        </button>
                                      </div>
                                    )}
                                    {citationExcerpts[String(citationNum)] && (
                                      <div className="mb-2 px-3 py-2 rounded-md bg-indigo-900/30 border-l-2 border-indigo-400">
                                        <div className="text-[10px] text-indigo-400 font-medium mb-1 uppercase tracking-wider">Cited excerpt</div>
                                        <div className="text-xs text-indigo-200 leading-relaxed whitespace-pre-wrap">
                                          {citationExcerpts[String(citationNum)]}
                                        </div>
                                      </div>
                                    )}
                                    <div className="text-[10px] text-gray-500 font-medium mb-1 uppercase tracking-wider">Full source</div>
                                    <div className="text-xs text-gray-400 leading-relaxed whitespace-pre-wrap border-l-2 border-gray-700 pl-3">
                                      <HighlightedChunk
                                        content={r.chunk.content}
                                        excerpt={citationExcerpts[String(citationNum)] || ''}
                                      />
                                    </div>
                                    <div className="text-[10px] text-gray-600 mt-1">
                                      {r.chunk.tokenCount} tokens
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}

                    {/* Uncited Sources (collapsed by default) */}
                    {uncitedSources.length > 0 && (
                      <div className={citedSources.length > 0 ? 'mt-3' : ''}>
                        <button
                          onClick={() => setShowUncitedSources(!showUncitedSources)}
                          className="text-[10px] text-gray-500 uppercase tracking-wider font-medium hover:text-gray-400 transition-colors flex items-center gap-1"
                        >
                          <span className="text-[8px]">{showUncitedSources ? '\u25BC' : '\u25B6'}</span>
                          {citedSources.length > 0 ? 'Other retrieved sources' : 'All sources'} ({uncitedSources.length})
                        </button>
                        {showUncitedSources && (
                          <div className="space-y-1 mt-1.5">
                            {uncitedSources.map(({ r, citationNum }) => {
                              const isExpanded = expandedChunk === r.chunk.id;
                              return (
                                <div
                                  key={citationNum}
                                  ref={(el) => { if (el) sourceRefs.current.set(citationNum, el); }}
                                  className="rounded-lg hover:bg-gray-700/30"
                                >
                                  <button
                                    onClick={() => setExpandedChunk(isExpanded ? null : r.chunk.id)}
                                    className="w-full text-left flex items-center gap-2 px-2 py-1"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={selectedSourceNums.has(citationNum)}
                                      onChange={(event) => {
                                        event.stopPropagation();
                                        toggleSourceSelection(citationNum);
                                      }}
                                      onClick={(event) => event.stopPropagation()}
                                      className="accent-emerald-500"
                                    />
                                    <span className="inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold rounded bg-gray-800 text-gray-500">
                                      {citationNum}
                                    </span>
                                    <span className="text-xs">{sourceIcon(r.chunk.sourceType)}</span>
                                    <span className="text-xs text-gray-500 truncate flex-1">{r.sourceLabel}</span>
                                    <span className="text-[10px] text-gray-600">{(r.score * 100).toFixed(0)}%</span>
                                    <span className="text-[10px] text-gray-600">{isExpanded ? '\u25B2' : '\u25BC'}</span>
                                  </button>
                                  <div className="px-9 pb-2 pr-6">
                                    {renderSourceMetadata(r, 'inline')}
                                  </div>
                                  {isExpanded && (
                                    <div className="px-3 pb-2 pt-1 ml-7">
                                      {canNavigateToSource(r) && (
                                        <div className="flex justify-end mb-2">
                                          <button
                                            onClick={() => { void handleSourceNavigate(r); }}
                                            className="text-[10px] px-2 py-1 rounded bg-gray-700 text-gray-200 hover:bg-gray-600 transition-colors"
                                          >
                                            Open in {r.sourceMeta?.conversationId ? 'Library' : 'Session'}
                                          </button>
                                        </div>
                                      )}
                                      <div className="text-xs text-gray-500 leading-relaxed whitespace-pre-wrap border-l-2 border-gray-700/50 pl-3">
                                        {r.chunk.content}
                                      </div>
                                      <div className="text-[10px] text-gray-600 mt-1">
                                        {r.chunk.tokenCount} tokens
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Search Results */}
            {results.map((r) => {
              const badge = matchBadge(r.matchType);
              const isExpanded = expandedChunk === r.chunk.id;

              return (
                <div
                  key={r.chunk.id}
                  className="bg-gray-800/30 border border-gray-700/50 rounded-lg p-4 hover:border-gray-600/60 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span>{sourceIcon(r.chunk.sourceType)}</span>
                    <span className="text-xs font-medium text-gray-200 truncate">{r.sourceLabel}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${badge.cls}`}>
                      {badge.label}
                    </span>
                    {canNavigateToSource(r) && (
                      <button
                        onClick={() => { void handleSourceNavigate(r); }}
                        className="text-[10px] px-2 py-0.5 rounded bg-gray-700 text-gray-200 hover:bg-gray-600 transition-colors"
                      >
                        Open
                      </button>
                    )}
                    <span className="text-[10px] text-gray-500 ml-auto">
                      Score: {r.score.toFixed(3)}
                    </span>
                  </div>
                  {renderSourceMetadata(r)}

                  <div
                    className={`text-xs text-gray-400 leading-relaxed ${isExpanded ? '' : 'line-clamp-3'}`}
                    onClick={() => setExpandedChunk(isExpanded ? null : r.chunk.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    {isExpanded ? r.chunk.content : r.snippet}
                  </div>

                  {!isExpanded && r.chunk.content.length > 200 && (
                    <button
                      onClick={() => setExpandedChunk(r.chunk.id)}
                      className="text-[10px] text-indigo-400 hover:text-indigo-300 mt-1 transition-colors"
                    >
                      Show full chunk ({r.chunk.tokenCount} tokens)
                    </button>
                  )}
                </div>
              );
            })}

            {/* Meta info after search */}
            {(results.length > 0 || (answer !== null && searchMode === 'search')) && (
              <div className="text-center text-xs text-gray-600 py-2">
                {total} results in {queryTimeMs}ms
              </div>
            )}

            {/* Empty state */}
            {!loading && !answer && results.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center text-gray-600 py-20">
                <span className="text-4xl mb-4">{'\u{1F50D}'}</span>
                <p className="text-sm mb-1">Search your knowledge base</p>
                <p className="text-xs text-gray-700">
                  Ask questions or search across uploaded documents and conversation history
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {/* ───── INVENTORY / COVERAGE TAB ───── */}
      {tab === 'inventory' && (
        <div className="flex-1 overflow-y-auto">
          {/* Summary bar */}
          <div className="flex items-center gap-4 mb-4 px-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Sessions:</span>
              <span className="text-xs font-medium text-gray-300">{inventory.length}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Files:</span>
              <span className="text-xs font-medium text-gray-300">{totalFiles}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Library:</span>
              <span className="text-xs font-medium text-gray-300">{totalLibrary}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Indexed:</span>
              <span className="text-xs font-medium text-green-400">{indexedFiles + indexedLibrary}</span>
            </div>
            {totalUnindexed > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Not indexed:</span>
                <span className="text-xs font-medium text-amber-400">{totalUnindexed}</span>
              </div>
            )}
            {totalUnindexed > 0 && (
              <button
                onClick={handleIndexAll}
                disabled={indexAllLoading || inventoryLoading}
                className="ml-auto px-3 py-1 text-xs font-medium rounded-md bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {indexAllLoading ? 'Indexing All...' : `Index All (${totalUnindexed})`}
              </button>
            )}
            <button
              onClick={loadInventory}
              disabled={inventoryLoading}
              className={`${totalUnindexed > 0 ? '' : 'ml-auto '}text-xs text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50`}
            >
              {inventoryLoading ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {/* Index All result notification */}
          {indexAllResult && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-green-900/20 border border-green-800/40 text-xs text-green-400">
              Indexed {indexAllResult.indexedSessions ?? 0} sessions, {indexAllResult.indexedFiles ?? 0} files, {indexAllResult.indexedLibrary ?? 0} library conversations ({indexAllResult.totalChunks ?? 0} chunks total)
              {indexAllResult.errors?.length > 0 && (
                <span className="text-amber-400 ml-2">
                  · {indexAllResult.errors.length} error{indexAllResult.errors.length > 1 ? 's' : ''}
                </span>
              )}
              <button onClick={() => setIndexAllResult(null)} className="ml-2 text-gray-500 hover:text-gray-300">×</button>
            </div>
          )}

          {/* Session list */}
          {inventoryLoading && inventory.length === 0 ? (
            <div className="flex items-center justify-center py-20 text-gray-600">
              <span className="inline-block w-5 h-5 border-2 border-gray-600 border-t-indigo-400 rounded-full animate-spin mr-3" />
              Loading inventory...
            </div>
          ) : inventory.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-600">
              <span className="text-3xl mb-3">{'\u{1F4ED}'}</span>
              <p className="text-sm">No uploaded files found</p>
              <p className="text-xs text-gray-700 mt-1">Upload files in a session to populate the knowledge base</p>
            </div>
          ) : (
            <div className="space-y-2">
              {inventory.map((session) => {
                const isOpen = expandedSession === session.sessionId;
                const fileCount = session.files.length;
                const indexedCount = session.files.filter((f) => f.isIndexed).length;
                const allIndexed = indexedCount === fileCount && session.messages.isIndexed;
                const hasUnindexed = indexedCount < fileCount || (!session.messages.isIndexed && session.messages.count > 0);

                return (
                  <div
                    key={session.sessionId}
                    className="bg-gray-800/30 border border-gray-700/50 rounded-lg overflow-hidden"
                  >
                    {/* Session header */}
                    <button
                      onClick={() => setExpandedSession(isOpen ? null : session.sessionId)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-700/20 transition-colors text-left"
                    >
                      <span className="text-[10px] text-gray-600 transition-transform" style={{ transform: isOpen ? 'rotate(90deg)' : 'none' }}>
                        {'\u25B6'}
                      </span>

                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-200 truncate">
                          {session.sessionTitle}
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5">
                          {formatDate(session.createdAt)}
                          {' · '}
                          {fileCount} file{fileCount !== 1 ? 's' : ''}
                          {' · '}
                          {session.messages.count} message{session.messages.count !== 1 ? 's' : ''}
                        </div>
                      </div>

                      {/* Coverage badge */}
                      {allIndexed ? (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-900/40 text-green-400 font-medium">
                          All indexed
                        </span>
                      ) : hasUnindexed ? (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-900/40 text-amber-400 font-medium">
                          {indexedCount}/{fileCount} indexed
                        </span>
                      ) : null}
                    </button>

                    {/* Expanded content */}
                    {isOpen && (
                      <div className="border-t border-gray-700/50 px-4 py-3 space-y-2">
                        {/* Messages row */}
                        <div className="flex items-center gap-3 py-1.5 px-2 rounded-md bg-gray-800/40">
                          <span className="text-xs">{'\u{1F4AC}'}</span>
                          <div className="flex-1 min-w-0">
                            <span className="text-xs text-gray-300">Session Messages</span>
                            <span className="text-[10px] text-gray-500 ml-2">
                              {session.messages.count} messages
                            </span>
                          </div>
                          {session.messages.isIndexed ? (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-900/40 text-green-400">
                              {session.messages.chunksIndexed} chunks
                            </span>
                          ) : session.messages.count > 0 ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleIndexSession(session.sessionId); }}
                              disabled={indexingItems.has(`session:${session.sessionId}`)}
                              className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-900/40 text-indigo-400 hover:bg-indigo-800/60 transition-colors disabled:opacity-50"
                            >
                              {indexingItems.has(`session:${session.sessionId}`) ? 'Indexing...' : 'Index'}
                            </button>
                          ) : (
                            <span className="text-[10px] text-gray-600">No messages</span>
                          )}
                        </div>

                        {/* Files */}
                        {session.files.map((file) => (
                          <div
                            key={file.id}
                            className="flex items-center gap-3 py-1.5 px-2 rounded-md bg-gray-800/40"
                          >
                            <span className="text-xs">{'\u{1F4C4}'}</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs text-gray-300 truncate">{file.filename}</div>
                              <div className="text-[10px] text-gray-500">
                                {formatSize(file.fileSize)}
                                {' · '}
                                {formatDate(file.createdAt)}
                                {file.analyzedBy && ` · ${file.analyzedBy}`}
                              </div>
                            </div>

                            {/* Analysis status */}
                            {file.analysisStatus === 'done' ? (
                              file.isIndexed ? (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-900/40 text-green-400">
                                  {file.chunkCount} chunks · {file.embeddingCount} embeddings
                                </span>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleIndexFile(file.id); }}
                                  disabled={indexingItems.has(`file:${file.id}`)}
                                  className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-900/40 text-indigo-400 hover:bg-indigo-800/60 transition-colors disabled:opacity-50"
                                >
                                  {indexingItems.has(`file:${file.id}`) ? 'Indexing...' : 'Index'}
                                </button>
                              )
                            ) : file.analysisStatus === 'processing' ? (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-400">
                                Analyzing...
                              </span>
                            ) : file.analysisStatus === 'error' ? (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-900/40 text-red-400">
                                Error
                              </span>
                            ) : (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-700/50 text-gray-500">
                                Pending
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Library (Imported Conversations) ── */}
          {library.length > 0 && (
            <>
              <div className="flex items-center gap-2 mt-6 mb-3 px-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                  Imported Library
                </span>
                <span className="text-[10px] text-gray-600">
                  {totalLibrary} conversations · {indexedLibrary} indexed
                </span>
              </div>
              <div className="space-y-1.5">
                {library.map((conv) => {
                  const platformLabel = conv.sourcePlatform.charAt(0).toUpperCase() + conv.sourcePlatform.slice(1);
                  const platformIcon = conv.sourcePlatform === 'chatgpt' ? '\u{1F916}' : conv.sourcePlatform === 'claude' ? '\u{1F7E0}' : conv.sourcePlatform === 'gemini' ? '\u{2728}' : '\u{1F4AC}';

                  return (
                    <div
                      key={conv.conversationId}
                      className="flex items-center gap-3 py-2 px-3 rounded-lg bg-gray-800/30 border border-gray-700/50"
                    >
                      <span className="text-xs">{platformIcon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-gray-300 truncate">{conv.title}</div>
                        <div className="text-[10px] text-gray-500">
                          {platformLabel}
                          {' · '}
                          {conv.messageCount} messages
                          {conv.createdAt && ` · ${new Date(conv.createdAt).toLocaleDateString('zh-TW')}`}
                        </div>
                      </div>

                      {conv.isIndexed ? (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-900/40 text-green-400">
                          {conv.chunkCount} chunks
                        </span>
                      ) : (
                        <button
                          onClick={() => handleIndexLibrary(conv.conversationId)}
                          disabled={indexingItems.has(`lib:${conv.conversationId}`)}
                          className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-900/40 text-indigo-400 hover:bg-indigo-800/60 transition-colors disabled:opacity-50"
                        >
                          {indexingItems.has(`lib:${conv.conversationId}`) ? 'Indexing...' : 'Index'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {bootstrapModalOpen && answer !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-2xl rounded-xl border border-gray-700 bg-gray-900 p-5 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-100">Start Session from KB</h3>
                <p className="text-xs text-gray-500 mt-1">A new topic session will start from this KB answer and the selected cited sources.</p>
              </div>
              <button
                onClick={() => setBootstrapModalOpen(false)}
                className="text-gray-500 hover:text-gray-300 text-xl"
              >
                ×
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Session title</div>
                <div className="text-sm text-gray-200">{query || 'KB Follow-up Session'}</div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Original question</div>
                <div className="rounded-lg bg-gray-800/70 px-3 py-2 text-xs text-gray-300">{query}</div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">KB summary</div>
                <div className="max-h-40 overflow-y-auto rounded-lg bg-gray-800/70 px-3 py-2 text-xs text-gray-300 whitespace-pre-wrap">
                  {answer}
                </div>
              </div>

              <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-xs text-gray-300">
                <div className="text-[10px] uppercase tracking-wider text-emerald-300 mb-1">What this new session will include</div>
                <div className="space-y-1 text-gray-400">
                  <div>1. The original KB question</div>
                  <div>2. The KB answer summary above</div>
                  <div>3. The selected cited source excerpts below, with their timestamps and references</div>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="text-[10px] uppercase tracking-wider text-gray-500">
                    Selected cited sources ({selectedSourceNums.size}/{answerSources.length})
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={selectAllBootstrapSources}
                      className="rounded border border-gray-700 px-2 py-1 text-[10px] text-gray-300 transition-colors hover:bg-gray-800"
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={deselectAllBootstrapSources}
                      className="rounded border border-gray-700 px-2 py-1 text-[10px] text-gray-300 transition-colors hover:bg-gray-800"
                    >
                      Deselect All
                    </button>
                  </div>
                </div>
                <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                  {answerSources.map((source, index) => {
                    const citationNum = index + 1;
                    return (
                      <label
                        key={source.chunk.id}
                        className="flex items-start gap-3 rounded-lg border border-gray-800 bg-gray-800/50 px-3 py-2"
                      >
                        <input
                          type="checkbox"
                          checked={selectedSourceNums.has(citationNum)}
                          onChange={() => toggleSourceSelection(citationNum)}
                          className="mt-0.5 accent-emerald-500"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-gray-200">{source.sourceLabel}</div>
                          {renderBootstrapSourceMetadata(source, citationNum)}
                          <div className="mt-1 text-[11px] text-gray-400 line-clamp-3">
                            {citationExcerpts[String(citationNum)] || source.snippet}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={() => setBootstrapModalOpen(false)}
                className="px-3 py-2 text-sm rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleStartSessionFromKB()}
                disabled={selectedSourceNums.size === 0 || bootstrappingSession}
                className="px-3 py-2 text-sm rounded bg-emerald-700 text-white hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {bootstrappingSession ? 'Creating...' : 'Create Session'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
