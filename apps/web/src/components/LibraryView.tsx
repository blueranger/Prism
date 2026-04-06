'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useChatStore } from '@/stores/chat-store';
import {
  applyWikiCompilePlan,
  applyWikiBackfillPlan,
  bootstrapSessionFromKB,
  compileSourceToWiki,
  createActionItemsFromImportedConversation,
  createProvenance,
  deleteImportedConversation,
  exportImportedRawSourceToObsidian,
  fetchCompilerRuns,
  fetchWikiBackfillJob,
  fetchWikiBackfillJobs,
  fetchWikiBackfillPlan,
  fetchWikiCompilePlans,
  fetchWikiLintRuns,
  fetchNotionPages,
  getObsidianSettings,
  pickObsidianVaultFolder,
  pauseWikiBackfillJob,
  regenerateImportedConversationTitle,
  resumeWikiBackfillJob,
  rejectWikiCompilePlan,
  revealObsidianExport,
  resetImportedData,
  saveObsidianSettings,
  searchAll,
  startWikiBackfillJob,
  switchToSession,
  runWikiLint,
  updateImportedConversationTitle,
  writeToNotionPage,
} from '@/lib/api';
import ImportDialog from './ImportDialog';
import SessionOutline from './SessionOutline';
import ConversationKnowledge from './ConversationKnowledge';
import CopyWithProvenance from './CopyWithProvenance';
import MarkdownContent from './MarkdownContent';
import type { ImportPlatform, SearchResult, OutlineSection } from '@prism/shared';

function compilerSourceTypeForPlatform(platform: ImportPlatform): string {
  switch (platform) {
    case 'chatgpt':
      return 'imported_chatgpt';
    case 'claude':
      return 'imported_claude';
    case 'gemini':
      return 'imported_gemini';
    default:
      return 'external_transcript';
  }
}

const PLATFORM_TABS: { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
];

function platformBadge(platform: string) {
  switch (platform) {
    case 'chatgpt': return <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-400">GPT</span>;
    case 'claude': return <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/50 text-orange-400">Claude</span>;
    case 'gemini': return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400">Gemini</span>;
    default: return null;
  }
}

function sourceBadge(sourceKind?: string) {
  if (sourceKind === 'chatgpt_browser_sync') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-300">ChatGPT Sync</span>;
  }
  if (sourceKind === 'claude_browser_sync') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/50 text-orange-300">Claude Sync</span>;
  }
  if (sourceKind === 'gemini_browser_sync') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300">Gemini Sync</span>;
  }
  return null;
}

function titleSourceBadge(titleSource?: string) {
  if (titleSource === 'ai') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-900/50 text-violet-300">AI Title</span>;
  }
  if (titleSource === 'manual') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/50 text-amber-300">Manual</span>;
  }
  return null;
}

function lockBadge(titleLocked?: boolean) {
  if (!titleLocked) return null;
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-200">Locked</span>;
}

function archiveBadge(isArchived?: boolean) {
  if (!isArchived) return null;
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">Archived</span>;
}

function formatLastActivity(timestamp?: string | number | null) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatCompilerDestinationLabel(destinationType?: string | null) {
  switch (destinationType) {
    case 'obsidian_source':
      return 'Raw Source';
    case 'obsidian_context':
      return 'Context';
    case 'obsidian_observation':
      return 'Observation';
    case 'obsidian_evergreen':
      return 'Evergreen';
    case 'notion_action':
      return 'Notion Action';
    default:
      return 'Unspecified';
  }
}

function formatObsidianBusyLabel(mode: 'raw' | 'context' | 'observation' | 'evergreen' | null) {
  switch (mode) {
    case 'raw':
      return 'Saving raw source to Obsidian...';
    case 'context':
      return 'Creating context note in Obsidian...';
    case 'observation':
      return 'Creating observation note in Obsidian...';
    case 'evergreen':
      return 'Creating evergreen note in Obsidian...';
    default:
      return '';
  }
}

function formatCompileArtifactLabel(artifactType?: string | null) {
  switch (artifactType) {
    case 'raw_source':
      return 'Raw Source';
    case 'context':
      return 'Context';
    case 'observation':
      return 'Observation';
    case 'evergreen':
      return 'Evergreen';
    case 'concept':
      return 'Concept';
    case 'topic':
      return 'Topic';
    case 'project':
      return 'Project';
    case 'partner':
      return 'Partner';
    case 'entity':
      return 'Entity';
    case 'index_update':
      return 'Index';
    case 'log_update':
      return 'Log';
    default:
      return artifactType || 'Artifact';
  }
}

function formatCompilePageKindLabel(pageKind?: string | null) {
  switch (pageKind) {
    case 'source':
      return 'Source';
    case 'context':
      return 'Context';
    case 'observation':
      return 'Observation';
    case 'evergreen':
      return 'Evergreen';
    case 'concept':
      return 'Concept';
    case 'topic':
      return 'Topic';
    case 'project':
      return 'Project';
    case 'partner':
      return 'Partner';
    case 'entity':
      return 'Entity';
    case 'index':
      return 'Index';
    case 'log':
      return 'Log';
    default:
      return pageKind || 'Page';
  }
}

function formatBackfillActionLabel(action?: string | null) {
  switch (action) {
    case 'compile_now':
      return 'Compile now';
    case 'archive_only':
      return 'Archive only';
    case 'skip':
      return 'Skip';
    default:
      return action || 'Unknown';
  }
}

function formatBackfillAgeBucket(ageBucket?: string | null) {
  switch (ageBucket) {
    case 'recent':
      return 'Recent';
    case 'mid_term':
      return '3–12 months';
    case 'legacy':
      return '1y+';
    default:
      return ageBucket || 'Unknown';
  }
}

function deriveCurrentBatchProgress(backfillJob: any, backfillJobItems: any[]) {
  if (!backfillJob) return null;
  const runningItem = backfillJobItems.find((item: any) => item.status === 'running');
  const activeBatchNumber =
    runningItem?.batchNumber ??
    (typeof backfillJob.nextBatchNumber === 'number' && backfillJob.nextBatchNumber > 1
      ? backfillJob.nextBatchNumber - 1
      : null);

  if (!activeBatchNumber) return null;

  const batchItems = backfillJobItems.filter((item: any) => item.batchNumber === activeBatchNumber);
  if (!batchItems.length) return null;

  const completedInBatch = batchItems.filter((item: any) => ['applied', 'skipped', 'failed'].includes(item.status)).length;
  const runningInBatch = batchItems.filter((item: any) => item.status === 'running').length;

  return {
    batchNumber: activeBatchNumber,
    completed: completedInBatch,
    total: batchItems.length,
    running: runningInBatch,
  };
}

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default function LibraryView() {
  const [importOpen, setImportOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [ftsResults, setFtsResults] = useState<SearchResult[]>([]);
  const [ftsSearching, setFtsSearching] = useState(false);
  const [libraryDetailTab, setLibraryDetailTab] = useState<'messages' | 'topics' | 'knowledge'>('messages');
  const [libraryHighlightRange, setLibraryHighlightRange] = useState<{ start: number; end: number } | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState('');
  const [regeneratingTitle, setRegeneratingTitle] = useState(false);
  const [bootstrappingSession, setBootstrappingSession] = useState(false);
  const [libraryActionStatus, setLibraryActionStatus] = useState<{ type: 'success' | 'error'; message: string; filePath?: string } | null>(null);
  const [obsidianBusy, setObsidianBusy] = useState<'raw' | 'context' | 'observation' | 'evergreen' | null>(null);
  const [obsidianRoutingOpen, setObsidianRoutingOpen] = useState(false);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfillBusy, setBackfillBusy] = useState<'plan' | 'apply' | null>(null);
  const [backfillPlan, setBackfillPlan] = useState<any | null>(null);
  const [backfillSelections, setBackfillSelections] = useState<Record<string, 'compile_now' | 'archive_only' | 'skip'>>({});
  const [backfillJob, setBackfillJob] = useState<any | null>(null);
  const [backfillJobItems, setBackfillJobItems] = useState<any[]>([]);
  const [compileBusy, setCompileBusy] = useState<'analyze' | 'apply' | 'reject' | null>(null);
  const [compilePlans, setCompilePlans] = useState<any[]>([]);
  const [selectedCompilePlan, setSelectedCompilePlan] = useState<any | null>(null);
  const [selectedCompileItemIds, setSelectedCompileItemIds] = useState<string[]>([]);
  const [obsidianSettingsOpen, setObsidianSettingsOpen] = useState(false);
  const [obsidianVaultInput, setObsidianVaultInput] = useState('');
  const [obsidianSettingsSaving, setObsidianSettingsSaving] = useState(false);
  const [obsidianFolderPicking, setObsidianFolderPicking] = useState(false);
  const [actionItemsBusy, setActionItemsBusy] = useState(false);
  const [notionPickerOpen, setNotionPickerOpen] = useState(false);
  const [notionPages, setNotionPages] = useState<any[]>([]);
  const [notionSearch, setNotionSearch] = useState('');
  const [notionLoading, setNotionLoading] = useState(false);
  const [notionSending, setNotionSending] = useState(false);
  const [pendingActionItems, setPendingActionItems] = useState<{ title: string; content: string; model: string } | null>(null);
  const [compilerSummary, setCompilerSummary] = useState<any | null>(null);
  const [compilerRuns, setCompilerRuns] = useState<any[]>([]);
  const [compilerLoading, setCompilerLoading] = useState(false);
  const [wikiLintRuns, setWikiLintRuns] = useState<any[]>([]);
  const [wikiLintBusy, setWikiLintBusy] = useState(false);
  const libraryMessagesRef = useRef<HTMLDivElement>(null);

  // Resizable left panel width
  const [leftPanelWidth, setLeftPanelWidth] = useState(320);
  const lpDragging = useRef(false);
  const lpDragStartX = useRef(0);
  const lpDragStartW = useRef(0);

  const handleLeftPanelDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    lpDragging.current = true;
    lpDragStartX.current = e.clientX;
    lpDragStartW.current = leftPanelWidth;

    const onMove = (ev: MouseEvent) => {
      if (!lpDragging.current) return;
      const delta = ev.clientX - lpDragStartX.current;
      setLeftPanelWidth(Math.max(200, Math.min(500, lpDragStartW.current + delta)));
    };
    const onUp = () => {
      lpDragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [leftPanelWidth]);

  const conversations = useChatStore((s) => s.libraryConversations);
  const total = useChatStore((s) => s.libraryTotal);
  const selectedId = useChatStore((s) => s.librarySelectedId);
  const messages = useChatStore((s) => s.libraryMessages);
  const loading = useChatStore((s) => s.libraryLoading);
  const stats = useChatStore((s) => s.libraryStats);
  const selectedModels = useChatStore((s) => s.selectedModels);
  const fetchLibrary = useChatStore((s) => s.fetchLibrary);
  const selectConversation = useChatStore((s) => s.selectLibraryConversation);
  const fetchLibraryStats = useChatStore((s) => s.fetchLibraryStats);
  const setMode = useChatStore((s) => s.setMode);

  // Initial load
  useEffect(() => {
    fetchLibrary();
    fetchLibraryStats();
  }, [fetchLibrary, fetchLibraryStats]);

  // Reset detail tab when conversation changes
  useEffect(() => {
    setLibraryDetailTab('messages');
    setLibraryHighlightRange(null);
    setEditingTitle(false);
    setEditTitleValue('');
    setLibraryActionStatus(null);
    setPendingActionItems(null);
    setNotionPickerOpen(false);
    setCompilerSummary(null);
  }, [selectedId]);

  // Filter by platform tab
  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    fetchLibrary({ platform: tab === 'all' ? undefined : tab });
  }, [fetchLibrary]);

  // Search — use FTS API for content search, fall back to title filter for empty query
  const handleSearch = useCallback(async () => {
    if (!searchInput.trim()) {
      setFtsResults([]);
      fetchLibrary({ platform: activeTab === 'all' ? undefined : activeTab });
      return;
    }
    setFtsSearching(true);
    try {
      const result = await searchAll({
        query: searchInput,
        source: 'imported',
        platform: activeTab === 'all' ? undefined : activeTab,
      });
      setFtsResults(result.results);
    } catch (err) {
      console.error('[library] FTS search error:', err);
    } finally {
      setFtsSearching(false);
    }
  }, [searchInput, activeTab, fetchLibrary]);

  // Load more
  const handleLoadMore = useCallback(() => {
    fetchLibrary({
      platform: activeTab === 'all' ? undefined : activeTab,
      search: searchInput || undefined,
      offset: conversations.length,
    });
  }, [fetchLibrary, activeTab, searchInput, conversations.length]);

  const selectedConv = conversations.find(c => c.id === selectedId);
  const canRouteImportedConversation = Boolean(selectedConv);

  const loadCompilerRuns = useCallback(async (conversation: typeof selectedConv | undefined) => {
    if (!conversation) {
      setCompilerRuns([]);
      setCompilerSummary(null);
      return;
    }

    setCompilerLoading(true);
    try {
      const result = await fetchCompilerRuns({
        sourceId: conversation.id,
        sourceType: compilerSourceTypeForPlatform(conversation.sourcePlatform),
        limit: 10,
      });
      const runs = result.runs ?? [];
      setCompilerRuns(runs);
      setCompilerSummary(runs[0] ?? null);
    } catch (err) {
      console.error('[library] fetch compiler runs error:', err);
      setCompilerRuns([]);
      setCompilerSummary(null);
    } finally {
      setCompilerLoading(false);
    }
  }, []);

  const loadWikiLintRuns = useCallback(async () => {
    try {
      const result = await fetchWikiLintRuns(5);
      setWikiLintRuns(result.runs ?? []);
    } catch (err) {
      console.error('[library] fetch wiki lint runs error:', err);
      setWikiLintRuns([]);
    }
  }, []);

  const loadCompilePlans = useCallback(async (conversation: typeof selectedConv | undefined) => {
    if (!conversation) {
      setCompilePlans([]);
      setSelectedCompilePlan(null);
      setSelectedCompileItemIds([]);
      return;
    }
    try {
      const result = await fetchWikiCompilePlans({
        sourceId: conversation.id,
        sourceType: compilerSourceTypeForPlatform(conversation.sourcePlatform),
        limit: 10,
      });
      const plans = result.plans ?? [];
      setCompilePlans(plans);
      const latest = plans[0] ?? null;
      setSelectedCompilePlan(latest);
      setSelectedCompileItemIds(
        latest?.items?.filter((item: any) => item.selectedByDefault !== false).map((item: any) => item.id) ?? []
      );
    } catch (err) {
      console.error('[library] fetch compile plans error:', err);
      setCompilePlans([]);
      setSelectedCompilePlan(null);
      setSelectedCompileItemIds([]);
    }
  }, []);

  const loadLatestBackfillJob = useCallback(async () => {
    try {
      const jobsResult = await fetchWikiBackfillJobs(1);
      const latest = jobsResult.jobs?.[0] ?? null;
      setBackfillJob(latest);
      if (latest?.id) {
        const detail = await fetchWikiBackfillJob(latest.id);
        setBackfillJob(detail.job ? { ...detail.job, active: detail.active, resumable: detail.resumable } : latest);
        setBackfillJobItems(detail.items ?? []);
      } else {
        setBackfillJobItems([]);
      }
    } catch (err) {
      console.error('[library] fetch backfill jobs error:', err);
      setBackfillJob(null);
      setBackfillJobItems([]);
    }
  }, []);

  useEffect(() => {
    setEditTitleValue(selectedConv?.title ?? '');
  }, [selectedConv?.id, selectedConv?.title]);

  useEffect(() => {
    if (!notionPickerOpen) return;
    setNotionLoading(true);
    fetchNotionPages(notionSearch || undefined)
      .then((pages) => setNotionPages(pages))
      .finally(() => setNotionLoading(false));
  }, [notionPickerOpen, notionSearch]);

  useEffect(() => {
    if (!selectedConv) {
      setCompilerRuns([]);
      setCompilerSummary(null);
      return;
    }
    void loadCompilerRuns(selectedConv);
  }, [selectedConv?.id, selectedConv?.sourcePlatform, loadCompilerRuns]);

  useEffect(() => {
    if (!obsidianRoutingOpen) return;
    void loadWikiLintRuns();
    void loadCompilePlans(selectedConv);
  }, [obsidianRoutingOpen, loadWikiLintRuns, loadCompilePlans, selectedConv]);

  useEffect(() => {
    if (!backfillOpen) return;
    void loadLatestBackfillJob();
  }, [backfillOpen, loadLatestBackfillJob]);

  useEffect(() => {
    if (!backfillOpen || !backfillJob?.id) return;
    if (!['queued', 'running'].includes(backfillJob.status)) return;
    const timer = window.setInterval(() => {
      void loadLatestBackfillJob();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [backfillOpen, backfillJob?.id, backfillJob?.status, loadLatestBackfillJob]);

  const setStatusNotice = useCallback((type: 'success' | 'error', message: string, filePath?: string) => {
    setLibraryActionStatus({ type, message, filePath });
  }, []);

  const ensureObsidianVaultPath = useCallback(async (): Promise<string | null> => {
    const settings = await getObsidianSettings();
    const existing = settings.vaultPath?.trim();
    if (existing) return existing;
    setObsidianVaultInput('');
    setObsidianSettingsOpen(true);
    return null;
  }, []);

  const handleSaveObsidianVault = useCallback(async () => {
    const next = obsidianVaultInput.trim();
    if (!next) {
      setStatusNotice('error', 'Please provide an Obsidian vault path.');
      return;
    }
    try {
      setObsidianSettingsSaving(true);
      const saved = await saveObsidianSettings(next);
      setObsidianVaultInput(saved.vaultPath);
      setObsidianSettingsOpen(false);
      setStatusNotice('success', `Saved Obsidian vault path: ${saved.vaultPath}`);
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to save Obsidian vault path.');
    } finally {
      setObsidianSettingsSaving(false);
    }
  }, [obsidianVaultInput, setStatusNotice]);

  const handlePickObsidianFolder = useCallback(async () => {
    try {
      setObsidianFolderPicking(true);
      const result = await pickObsidianVaultFolder();
      setObsidianVaultInput(result.vaultPath);
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to open folder picker.');
    } finally {
      setObsidianFolderPicking(false);
    }
  }, [setStatusNotice]);

  const handleLibraryTitleSave = useCallback(async () => {
    if (!selectedConv) return;
    const nextTitle = editTitleValue.trim();
    if (!nextTitle) {
      setEditingTitle(false);
      setEditTitleValue(selectedConv.title);
      return;
    }

    await updateImportedConversationTitle(selectedConv.id, nextTitle);
    await fetchLibrary();
    setEditingTitle(false);
  }, [selectedConv, editTitleValue, fetchLibrary]);

  const handleRegenerateTitle = useCallback(async () => {
    if (!selectedConv) return;
    setRegeneratingTitle(true);
    try {
      await regenerateImportedConversationTitle(selectedConv.id);
      await fetchLibrary();
    } finally {
      setRegeneratingTitle(false);
    }
  }, [selectedConv, fetchLibrary]);

  const handleStartSessionFromLibrary = useCallback(async () => {
    if (!selectedConv) return;
    setBootstrappingSession(true);
    try {
      const result = await bootstrapSessionFromKB({
        origin: 'library',
        suggestedTitle: selectedConv.title,
        libraryConversationIds: [selectedConv.id],
        activeModel: useChatStore.getState().selectedModels[0] ?? null,
        observerModels: useChatStore.getState().selectedModels.slice(1, 3),
      });
      if (!result?.sessionId) throw new Error('Failed to create session');
      setMode('observer');
      await switchToSession(result.sessionId);
    } catch (err) {
      console.error('[library] bootstrap session error:', err);
    } finally {
      setBootstrappingSession(false);
    }
  }, [selectedConv, setMode]);

  const handleResetAllImportedData = useCallback(async () => {
    if (!confirm('Reset all imported Library, Knowledge, KB, and Provenance data? This cannot be undone.')) return;
    try {
      await resetImportedData();
      await fetchLibrary({ platform: activeTab === 'all' ? undefined : activeTab });
      await fetchLibraryStats();
    } catch (err) {
      console.error('[library] reset imported data error:', err);
    }
  }, [fetchLibrary, fetchLibraryStats, activeTab]);

  const handleDeleteSelectedConversation = useCallback(async () => {
    if (!selectedConv) return;
    if (!confirm(`Delete imported conversation "${selectedConv.title}"? This cannot be undone.`)) return;
    try {
      await deleteImportedConversation(selectedConv.id);
      await fetchLibrary({
        platform: activeTab === 'all' ? undefined : activeTab,
        search: searchInput || undefined,
      });
      await fetchLibraryStats();
    } catch (err) {
      console.error('[library] delete imported conversation error:', err);
    }
  }, [selectedConv, fetchLibrary, fetchLibraryStats, activeTab, searchInput]);

  const handleSaveRawSourceToObsidian = useCallback(async () => {
    if (!selectedConv) return;
    try {
      setObsidianBusy('raw');
      setLibraryActionStatus(null);
      const vaultPath = await ensureObsidianVaultPath();
      if (!vaultPath) {
        setStatusNotice('error', 'Obsidian vault path is required before exporting.');
        return;
      }
      const result = await exportImportedRawSourceToObsidian(selectedConv.id, vaultPath);
      setStatusNotice('success', `Saved raw source to Obsidian: ${result.filePath}`, result.filePath);
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to save raw source to Obsidian.');
    } finally {
      setObsidianBusy(null);
    }
  }, [selectedConv, ensureObsidianVaultPath, setStatusNotice]);

  const handleCreateKnowledgeNote = useCallback(async () => {
    setObsidianRoutingOpen(true);
  }, []);

  const handleAnalyzeBackfill = useCallback(async () => {
    try {
      setBackfillBusy('plan');
      const result = await fetchWikiBackfillPlan({
        platform: activeTab === 'all' ? undefined : activeTab,
        search: searchInput.trim() || undefined,
        limit: 200,
      });
      setBackfillPlan(result.plan);
      const defaults = Object.fromEntries(
        (result.plan?.recommendations ?? []).map((item: any) => [item.conversationId, item.recommendedAction])
      ) as Record<string, 'compile_now' | 'archive_only' | 'skip'>;
      setBackfillSelections(defaults);
      setStatusNotice(
        'success',
        `Built backfill plan for ${result.plan?.totalConversations ?? 0} conversation${(result.plan?.totalConversations ?? 0) === 1 ? '' : 's'}.`
      );
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to build backfill plan.');
    } finally {
      setBackfillBusy(null);
    }
  }, [activeTab, searchInput, setStatusNotice]);

  const handleApplyBackfill = useCallback(async () => {
    if (!backfillPlan) return;
    try {
      setBackfillBusy('apply');
      const vaultPath = await ensureObsidianVaultPath();
      if (!vaultPath) {
        setStatusNotice('error', 'Obsidian vault path is required before backfilling the wiki.');
        return;
      }
      const items = (backfillPlan.recommendations ?? []).map((item: any) => ({
        conversationId: item.conversationId,
        action: backfillSelections[item.conversationId] ?? item.recommendedAction,
      }));
      const result = await applyWikiBackfillPlan({
        items,
        vaultPath,
        model: selectedModels[0] ?? undefined,
      });
      const written = result.result?.results?.find((entry: any) => entry.filePath)?.filePath;
      setStatusNotice(
        'success',
        `Backfill finished: ${result.result?.compiledCount ?? 0} compiled, ${result.result?.archivedCount ?? 0} archived, ${result.result?.skippedCount ?? 0} skipped.`,
        written
      );
      await fetchLibrary({ platform: activeTab === 'all' ? undefined : activeTab, search: searchInput.trim() || undefined });
      setBackfillOpen(false);
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to apply backfill plan.');
    } finally {
      setBackfillBusy(null);
    }
  }, [backfillPlan, backfillSelections, ensureObsidianVaultPath, setStatusNotice, selectedModels, fetchLibrary, activeTab, searchInput]);

  const handleStartBackfillJob = useCallback(async () => {
    try {
      setBackfillBusy('apply');
      const vaultPath = await ensureObsidianVaultPath();
      if (!vaultPath) {
        setStatusNotice('error', 'Obsidian vault path is required before starting a background backfill job.');
        return;
      }
      const result = await startWikiBackfillJob({
        vaultPath,
        model: selectedModels[0] ?? undefined,
        platform: activeTab === 'all' ? undefined : activeTab,
        search: searchInput.trim() || undefined,
        limit: 200,
        batchSize: 10,
        items: backfillPlan?.recommendations?.map((item: any) => ({
          conversationId: item.conversationId,
          action: backfillSelections[item.conversationId] ?? item.recommendedAction,
        })),
      });
      setBackfillJob({ ...result.job, active: true, resumable: false });
      setBackfillJobItems(result.items ?? []);
      setStatusNotice('success', `Started background backfill job with ${result.job?.totalItems ?? 0} item(s).`);
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to start background backfill job.');
    } finally {
      setBackfillBusy(null);
    }
  }, [ensureObsidianVaultPath, selectedModels, activeTab, searchInput, setStatusNotice]);

  const handlePauseBackfillJob = useCallback(async () => {
    if (!backfillJob?.id) return;
    try {
      setBackfillBusy('apply');
      const result = await pauseWikiBackfillJob(backfillJob.id);
      setBackfillJob(result.job ? { ...result.job, active: result.active, resumable: result.resumable } : null);
      setStatusNotice('success', 'Paused the background backfill job.');
      await loadLatestBackfillJob();
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to pause the backfill job.');
    } finally {
      setBackfillBusy(null);
    }
  }, [backfillJob?.id, loadLatestBackfillJob, setStatusNotice]);

  const handleResumeBackfillJob = useCallback(async () => {
    if (!backfillJob?.id) return;
    try {
      setBackfillBusy('apply');
      const result = await resumeWikiBackfillJob(backfillJob.id);
      setBackfillJob(result.job ? { ...result.job, active: result.active, resumable: result.resumable } : null);
      setBackfillJobItems(result.items ?? []);
      setStatusNotice('success', 'Resumed the background backfill job from the saved record.');
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to resume the backfill job.');
    } finally {
      setBackfillBusy(null);
    }
  }, [backfillJob?.id, setStatusNotice]);

  const handleAnalyzeSourceToWiki = useCallback(async () => {
    if (!selectedConv) return;
    try {
      setCompileBusy('analyze');
      setLibraryActionStatus(null);
      const vaultPath = await ensureObsidianVaultPath();
      if (!vaultPath) {
        setStatusNotice('error', 'Obsidian vault path is required before compiling.');
        return;
      }
      const model = selectedModels[0] ?? undefined;
      const result = await compileSourceToWiki({
        sourceKind: 'imported',
        sourceId: selectedConv.id,
        vaultPath,
        model,
      });
      setSelectedCompilePlan(result.plan);
      setSelectedCompileItemIds(
        result.plan?.items?.filter((item: any) => item.selectedByDefault !== false).map((item: any) => item.id) ?? []
      );
      await loadCompilePlans(selectedConv);
      setStatusNotice('success', `Compiled source into a review plan with ${result.plan?.items?.length ?? 0} proposed changes.`);
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to analyze source into a compile plan.');
    } finally {
      setCompileBusy(null);
    }
  }, [selectedConv, ensureObsidianVaultPath, selectedModels, setStatusNotice, loadCompilePlans]);

  const handleApplyCompilePlan = useCallback(async (applyAll: boolean) => {
    if (!selectedCompilePlan) return;
    try {
      setCompileBusy('apply');
      setLibraryActionStatus(null);
      const vaultPath = await ensureObsidianVaultPath();
      if (!vaultPath) {
        setStatusNotice('error', 'Obsidian vault path is required before applying the compile plan.');
        return;
      }
      const itemIds = applyAll ? undefined : selectedCompileItemIds;
      const result = await applyWikiCompilePlan(selectedCompilePlan.id, itemIds, vaultPath);
      setSelectedCompilePlan(result.plan);
      await loadCompilePlans(selectedConv);
      const written = result.wikiUpdate?.writtenFiles?.[0] || result.wikiUpdate?.updatedFiles?.[0];
      setStatusNotice(
        'success',
        `Applied ${result.appliedItemIds?.length ?? 0} wiki change${(result.appliedItemIds?.length ?? 0) === 1 ? '' : 's'}.`,
        written
      );
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to apply compile plan.');
    } finally {
      setCompileBusy(null);
    }
  }, [selectedCompilePlan, selectedCompileItemIds, ensureObsidianVaultPath, setStatusNotice, loadCompilePlans, selectedConv]);

  const handleRejectCompile = useCallback(async () => {
    if (!selectedCompilePlan) return;
    try {
      setCompileBusy('reject');
      const vaultPath = await ensureObsidianVaultPath();
      if (!vaultPath) {
        setStatusNotice('error', 'Obsidian vault path is required before rejecting the compile plan.');
        return;
      }
      const result = await rejectWikiCompilePlan(selectedCompilePlan.id, vaultPath);
      setSelectedCompilePlan(result.plan);
      await loadCompilePlans(selectedConv);
      setStatusNotice('success', 'Rejected the current compile plan.');
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to reject compile plan.');
    } finally {
      setCompileBusy(null);
    }
  }, [selectedCompilePlan, ensureObsidianVaultPath, loadCompilePlans, selectedConv, setStatusNotice]);

  const handleCreateActionItems = useCallback(async () => {
    if (!selectedConv) return;
    try {
      setActionItemsBusy(true);
      setLibraryActionStatus(null);
      const model = selectedModels[0] ?? undefined;
      const generated = await createActionItemsFromImportedConversation(selectedConv.id, model);
      setPendingActionItems({
        title: generated.title,
        content: generated.content,
        model: generated.model,
      });
      setNotionSearch('');
      setNotionPickerOpen(true);
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to create action items.');
    } finally {
      setActionItemsBusy(false);
    }
  }, [selectedConv, selectedModels, setStatusNotice]);

  const handleRunWikiLint = useCallback(async () => {
    try {
      setWikiLintBusy(true);
      const vaultPath = await ensureObsidianVaultPath();
      if (!vaultPath) {
        setStatusNotice('error', 'Obsidian vault path is required before running wiki lint.');
        return;
      }
      const model = selectedModels[0] ?? undefined;
      const result = await runWikiLint(vaultPath, model);
      setWikiLintRuns((prev) => [result.run, ...prev.filter((run) => run.id !== result.run.id)].slice(0, 5));
      setStatusNotice('success', `Wiki lint completed with ${result.run?.findingCount ?? 0} findings.`);
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to run wiki lint.');
    } finally {
      setWikiLintBusy(false);
    }
  }, [ensureObsidianVaultPath, selectedModels, setStatusNotice]);

  const handleSendActionItemsToNotion = useCallback(async (pageId: string) => {
    if (!pendingActionItems || !selectedConv) return;
    setNotionSending(true);
    try {
      const contentHash = await sha256(pendingActionItems.content);
      let shortCode = '';
      try {
        const provenance = await createProvenance({
          sourceType: 'imported',
          conversationId: selectedConv.id,
          messageId: `imported-action-items-${selectedConv.id}`,
          content: pendingActionItems.content,
          contentHash,
          sourceModel: pendingActionItems.model,
        });
        shortCode = provenance.shortCode || '';
      } catch (err) {
        console.warn('[library] failed to create provenance for action items:', err);
      }

      const now = new Date();
      let content = pendingActionItems.content.trim();
      content += '\n\n---\n';
      content += `*Generated by Prism from imported conversation | ${now.toISOString()}`;
      content += ` | Conversation: ${selectedConv.title}`;
      if (shortCode) content += ` | Provenance: ${shortCode}`;
      content += '*';

      const result = await writeToNotionPage(pageId, content, selectedConv.sessionId, `imported-action-items-${selectedConv.id}`);
      if (!result.ok) {
        throw new Error('Notion append failed');
      }

      setNotionPickerOpen(false);
      setPendingActionItems(null);
      setStatusNotice('success', 'Created action items and appended them to Notion.');
    } catch (err: any) {
      setStatusNotice('error', err?.message || 'Failed to append action items to Notion.');
    } finally {
      setNotionSending(false);
    }
  }, [pendingActionItems, selectedConv, setStatusNotice]);

  return (
    <div className="flex-1 flex gap-4 min-h-0">
      {/* Left sidebar: conversation list */}
      <div className="flex-shrink-0 flex flex-col min-h-0" style={{ width: leftPanelWidth }}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-300">
            Library
            {stats && <span className="text-gray-500 font-normal ml-1">({stats.total})</span>}
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleResetAllImportedData}
              className="px-2 py-1 text-xs rounded border border-red-800 text-red-300 hover:bg-red-900/30 transition-colors"
            >
              Reset All Data
            </button>
            <button
              onClick={() => setBackfillOpen(true)}
              className="px-2 py-1 text-xs rounded bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-200 transition-colors"
            >
              Backfill Planner
            </button>
            <button
              onClick={() => setImportOpen(true)}
              className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
            >
              Import
            </button>
          </div>
        </div>

        {/* Platform filter tabs */}
        <div className="flex gap-1 mb-3">
          {PLATFORM_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                activeTab === tab.id
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.label}
              {tab.id !== 'all' && stats?.byPlatform[tab.id] ? (
                <span className="ml-1 text-gray-600">{stats.byPlatform[tab.id]}</span>
              ) : null}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex gap-1 mb-3">
          <input
            type="text"
            placeholder="Search by title..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="flex-1 px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500"
          />
          <button
            onClick={handleSearch}
            className="px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-400 hover:text-gray-200"
          >
            Search
          </button>
        </div>

        {/* Conversation list / FTS results */}
        <div className="flex-1 overflow-y-auto space-y-1">
          {ftsSearching ? (
            <p className="text-xs text-gray-600 text-center py-4">Searching...</p>
          ) : searchInput.trim() && ftsResults.length > 0 ? (
            /* FTS search results */
            ftsResults.map((result) => (
              <button
                key={result.id}
                onClick={() => selectConversation(result.conversationId)}
                className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                  selectedId === result.conversationId
                    ? 'bg-gray-700 border border-gray-600'
                    : 'hover:bg-gray-800/50 border border-transparent'
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  {result.sourcePlatform && platformBadge(result.sourcePlatform)}
                  <span className="text-xs text-gray-300 truncate flex-1">{result.conversationTitle}</span>
                </div>
                <p className="text-[10px] text-gray-500 truncate">{result.snippet}</p>
              </button>
            ))
          ) : searchInput.trim() && ftsResults.length === 0 ? (
            <p className="text-xs text-gray-600 text-center py-4">No results found</p>
          ) : loading && conversations.length === 0 ? (
            <p className="text-xs text-gray-600 text-center py-4">Loading...</p>
          ) : conversations.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-gray-500 mb-2">No imported conversations</p>
              <button
                onClick={() => setImportOpen(true)}
                className="text-xs text-indigo-400 hover:text-indigo-300"
              >
                Import your first archive
              </button>
            </div>
          ) : (
            <>
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => selectConversation(conv.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                    selectedId === conv.id
                      ? 'bg-gray-700 border border-gray-600'
                      : 'hover:bg-gray-800/50 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    {platformBadge(conv.sourcePlatform)}
                    {sourceBadge(conv.sourceKind)}
                    {titleSourceBadge(conv.titleSource)}
                    {lockBadge(conv.titleLocked)}
                    {archiveBadge(conv.isArchived)}
                    <span className="text-xs text-gray-300 truncate flex-1">{conv.title}</span>
                  </div>
                  {conv.projectName ? (
                    <div className="mb-0.5 text-[10px] text-gray-500 truncate">
                      Project: {conv.projectName}
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2 text-[10px] text-gray-600">
                    <span>{conv.messageCount} msgs</span>
                    <span>{formatLastActivity(conv.lastActivityAt || conv.updatedAt || conv.createdAt)}</span>
                    {conv.defaultModelSlug ? <span>{conv.defaultModelSlug}</span> : null}
                    {conv.lastSyncedAt ? <span>Synced {formatLastActivity(conv.lastSyncedAt)}</span> : null}
                  </div>
                </button>
              ))}
              {conversations.length < total && (
                <button
                  onClick={handleLoadMore}
                  className="w-full py-2 text-xs text-gray-500 hover:text-gray-300"
                >
                  Load more ({total - conversations.length} remaining)
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Horizontal drag handle */}
      <div
        onMouseDown={handleLeftPanelDragStart}
        className="group w-2 flex-shrink-0 flex items-center justify-center cursor-col-resize select-none"
        title="Drag to resize"
      >
        <div className="w-0.5 h-12 rounded-full bg-gray-700 group-hover:bg-indigo-500 transition-colors" />
      </div>

      {/* Right panel: conversation detail */}
      <div className="flex-1 flex flex-col min-h-0 pl-2">
        {selectedConv ? (
          <>
            <div className="flex items-center gap-2 mb-3">
              {platformBadge(selectedConv.sourcePlatform)}
              {sourceBadge(selectedConv.sourceKind)}
              {titleSourceBadge(selectedConv.titleSource)}
              {lockBadge(selectedConv.titleLocked)}
              {archiveBadge(selectedConv.isArchived)}
              {editingTitle ? (
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <input
                    type="text"
                    value={editTitleValue}
                    onChange={(e) => setEditTitleValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleLibraryTitleSave();
                      if (e.key === 'Escape') {
                        setEditingTitle(false);
                        setEditTitleValue(selectedConv.title);
                      }
                    }}
                    className="flex-1 min-w-0 px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-gray-500"
                    autoFocus
                  />
                  <button
                    onClick={() => void handleLibraryTitleSave()}
                    className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => {
                      setEditingTitle(false);
                      setEditTitleValue(selectedConv.title);
                    }}
                    className="px-2 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-300"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <h3 className="text-sm font-semibold text-gray-200 truncate flex-1">{selectedConv.title}</h3>
                  <button
                    onClick={() => void handleRegenerateTitle()}
                    disabled={regeneratingTitle}
                    className="px-2 py-1 text-[10px] rounded bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50"
                  >
                    {regeneratingTitle ? 'Regenerating...' : 'Regenerate Title'}
                  </button>
                  <button
                    onClick={() => void handleStartSessionFromLibrary()}
                    disabled={bootstrappingSession}
                    className="px-2 py-1 text-[10px] rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50"
                  >
                    {bootstrappingSession ? 'Starting...' : 'Start Session'}
                  </button>
                  <button
                    onClick={() => setEditingTitle(true)}
                    className="px-2 py-1 text-[10px] rounded bg-gray-800 hover:bg-gray-700 text-gray-300"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => void handleDeleteSelectedConversation()}
                    className="px-2 py-1 text-[10px] rounded bg-red-900/40 hover:bg-red-900/60 text-red-200"
                  >
                    Delete
                  </button>
                  {canRouteImportedConversation ? (
                    <>
                      <button
                        onClick={async () => {
                          const settings = await getObsidianSettings();
                          setObsidianVaultInput(settings.vaultPath ?? '');
                          setObsidianSettingsOpen(true);
                        }}
                        disabled={obsidianBusy !== null || actionItemsBusy}
                        className="px-2 py-1 text-[10px] rounded bg-gray-800 hover:bg-gray-700 text-gray-200 disabled:opacity-50"
                      >
                        Obsidian Vault
                      </button>
                      <button
                        onClick={() => void handleSaveRawSourceToObsidian()}
                        disabled={obsidianBusy !== null || actionItemsBusy}
                        className="px-2 py-1 text-[10px] rounded bg-cyan-900/40 hover:bg-cyan-900/60 text-cyan-200 disabled:opacity-50"
                      >
                        {obsidianBusy === 'raw' ? 'Saving Raw...' : 'Save Raw Source to Obsidian'}
                      </button>
                      <button
                        onClick={() => void handleCreateKnowledgeNote()}
                        disabled={obsidianBusy !== null || actionItemsBusy || compileBusy !== null}
                        className="px-2 py-1 text-[10px] rounded bg-violet-900/40 hover:bg-violet-900/60 text-violet-200 disabled:opacity-50"
                      >
                        {compileBusy === 'analyze' || compileBusy === 'apply' || compileBusy === 'reject'
                          ? 'Compiling...'
                          : 'Compile Source to Wiki...'}
                      </button>
                      <button
                        onClick={() => void handleCreateActionItems()}
                        disabled={obsidianBusy !== null || actionItemsBusy}
                        className="px-2 py-1 text-[10px] rounded bg-amber-900/40 hover:bg-amber-900/60 text-amber-100 disabled:opacity-50"
                      >
                        {actionItemsBusy ? 'Creating Actions...' : 'Create Action Items in Notion'}
                      </button>
                    </>
                  ) : null}
                </>
              )}
              <span className="text-[10px] text-gray-600">
                {new Date(selectedConv.createdAt).toLocaleString()}
              </span>
            </div>

            <div className="mb-3 space-y-1 text-[11px] text-gray-500">
              {selectedConv.sourceTitle && selectedConv.sourceTitle !== selectedConv.title ? (
                <div>Original title: <span className="text-gray-400">{selectedConv.sourceTitle}</span></div>
              ) : null}
              {selectedConv.projectName ? (
                <div>Project: <span className="text-gray-400">{selectedConv.projectName}</span></div>
              ) : null}
              {selectedConv.workspaceName ? (
                <div>Workspace: <span className="text-gray-400">{selectedConv.workspaceName}</span></div>
              ) : null}
              {selectedConv.defaultModelSlug ? (
                <div>Model: <span className="text-gray-400">{selectedConv.defaultModelSlug}</span></div>
              ) : null}
              {selectedConv.sourceUpdatedAt ? (
                <div>Updated in ChatGPT: <span className="text-gray-400">{formatLastActivity(selectedConv.sourceUpdatedAt)}</span></div>
              ) : null}
              {selectedConv.lastSyncedAt ? (
                <div>Synced to Prism: <span className="text-gray-400">{formatLastActivity(selectedConv.lastSyncedAt)}</span></div>
              ) : null}
            </div>

            {canRouteImportedConversation ? (
              <div className="mb-3 text-[11px]">
                {libraryActionStatus ? (
                  <div className={libraryActionStatus.type === 'error' ? 'text-red-300' : 'text-emerald-300'}>
                    <div>{libraryActionStatus.message}</div>
                    {libraryActionStatus.type === 'success' && libraryActionStatus.filePath ? (
                      <button
                        onClick={() => void revealObsidianExport(libraryActionStatus.filePath!)}
                        className="mt-1 text-[11px] text-cyan-300 hover:text-cyan-200 underline underline-offset-2"
                      >
                        Reveal in Finder
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div className="text-gray-500">
                    Save the raw source, compile the full conversation into multiple proposed wiki artifacts, or extract action items into Notion.
                  </div>
                )}
              </div>
            ) : null}

            {selectedConv ? (
              <div className="mb-3 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-3 text-[11px]">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <div className="text-[11px] font-medium text-gray-300">Compiler Summary</div>
                    {compilerSummary?.destinationType ? (
                      <span className="rounded bg-violet-900/40 px-2 py-0.5 text-[10px] text-violet-200">
                        {formatCompilerDestinationLabel(compilerSummary.destinationType)}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-gray-500">
                      {compilerLoading
                        ? 'Loading...'
                        : compilerSummary
                          ? `${compilerSummary.status} · ${compilerSummary.model || 'gpt-5.4'}`
                          : 'No compiler run yet'}
                    </div>
                    {compilerSummary?.createdAt ? (
                      <div className="mt-0.5 text-[10px] text-gray-600">
                        Generated {formatLastActivity(compilerSummary.createdAt)}
                      </div>
                    ) : null}
                  </div>
                </div>
                {compilerSummary ? (
                  <>
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">{compilerSummary.conceptCount} concepts</span>
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">{compilerSummary.relatedNoteCount} related notes</span>
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">{compilerSummary.backlinkSuggestionCount} backlinks</span>
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">{compilerSummary.graphUpdatesCount} graph updates</span>
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">{compilerSummary.memoryCandidatesCount} memory candidates</span>
                    </div>
                    {compilerSummary.artifacts?.concepts?.length ? (
                      <div className="mt-3">
                        <div className="text-[10px] uppercase tracking-wide text-gray-500">Top Concepts</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {compilerSummary.artifacts.concepts.slice(0, 6).map((concept: any) => (
                            <span key={`${concept.name}-${concept.conceptType}`} className="rounded-full border border-indigo-900/60 bg-indigo-950/40 px-2 py-1 text-[10px] text-indigo-200">
                              {concept.name}
                              <span className="ml-1 text-indigo-400/80">({concept.conceptType})</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {compilerSummary.artifacts?.relatedNoteSuggestions?.length ? (
                      <div className="mt-3">
                        <div className="text-[10px] uppercase tracking-wide text-gray-500">Related Notes</div>
                        <div className="mt-1 space-y-1">
                          {compilerSummary.artifacts.relatedNoteSuggestions.slice(0, 4).map((note: any) => (
                            <div key={`${note.title}-${note.noteType}`} className="rounded bg-gray-900/60 px-2 py-1">
                              <div className="text-[11px] text-gray-300">{note.title}</div>
                              <div className="text-[10px] text-gray-500">{note.noteType} · {note.reason}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {compilerSummary.artifacts?.articleCandidates?.length ? (
                      <div className="mt-3">
                        <div className="text-[10px] uppercase tracking-wide text-gray-500">Article Candidates</div>
                        <div className="mt-1 space-y-1">
                          {compilerSummary.artifacts.articleCandidates.slice(0, 3).map((article: any) => (
                            <div key={`${article.title}-${article.articleType}`} className="rounded bg-gray-900/60 px-2 py-1">
                              <div className="text-[11px] text-gray-300">{article.title}</div>
                              <div className="text-[10px] text-gray-500">{article.articleType} · {article.reason}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {compilerSummary.errors?.length ? (
                      <div className="mt-3 rounded bg-amber-950/30 px-2 py-2 text-[10px] text-amber-200">
                        {compilerSummary.errors.join(' | ')}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="mt-2 text-[11px] text-gray-500">
                    Run an Obsidian export from this conversation and Prism will keep a compiler summary with concepts and related note suggestions.
                  </div>
                )}
              </div>
            ) : null}

            {/* Tab switcher */}
            <div className="flex items-center gap-2 mb-3">
              <button
                onClick={() => setLibraryDetailTab('messages')}
                className={`text-xs font-semibold uppercase tracking-wider transition-colors ${
                  libraryDetailTab === 'messages' ? 'text-gray-300' : 'text-gray-600 hover:text-gray-400'
                }`}
              >
                Messages
              </button>
              <span className="text-gray-700">|</span>
              <button
                onClick={() => {
                  setLibraryDetailTab('topics');
                  if (selectedId) {
                    useChatStore.getState().fetchSessionOutline(selectedId, 'imported');
                  }
                }}
                className={`text-xs font-semibold uppercase tracking-wider transition-colors ${
                  libraryDetailTab === 'topics' ? 'text-gray-300' : 'text-gray-600 hover:text-gray-400'
                }`}
              >
                Topics
              </button>
              <span className="text-gray-700">|</span>
              <button
                onClick={() => {
                  setLibraryDetailTab('knowledge');
                  if (selectedId) {
                    useChatStore.getState().fetchConversationKnowledge(selectedId, 'imported');
                  }
                }}
                className={`text-xs font-semibold uppercase tracking-wider transition-colors ${
                  libraryDetailTab === 'knowledge' ? 'text-gray-300' : 'text-gray-600 hover:text-gray-400'
                }`}
              >
                Knowledge
              </button>
            </div>

            {libraryDetailTab === 'messages' ? (
              <div ref={libraryMessagesRef} className="flex-1 overflow-y-auto space-y-3 pr-2">
                {messages.length === 0 ? (
                  <p className="text-xs text-gray-600 text-center py-4">Loading messages...</p>
                ) : (
                  messages.map((msg, idx) => (
                    <div
                      key={msg.id}
                      data-message-index={idx}
                      className={`rounded-lg p-3 text-sm transition-colors ${
                        msg.role === 'user'
                          ? 'bg-gray-800 text-gray-300'
                          : 'bg-gray-800/50 text-gray-400 border-l-2 border-indigo-600'
                      } ${
                        libraryHighlightRange &&
                        idx >= libraryHighlightRange.start &&
                        idx <= libraryHighlightRange.end
                          ? 'ring-1 ring-indigo-500/50'
                          : ''
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-medium uppercase text-gray-500">
                          {msg.role}
                        </span>
                        {msg.sourceModel && (
                          <span className="text-[10px] text-gray-600">{msg.sourceModel}</span>
                        )}
                        <span className="text-[10px] text-gray-700">
                          {new Date(msg.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="flex items-start gap-2">
                        <div className="break-words text-xs leading-relaxed flex-1 min-w-0">
                          {msg.role === 'assistant' ? (
                            <MarkdownContent content={msg.content} className="text-xs [&_p]:mb-2 [&_ul]:mb-2 [&_ol]:mb-2 [&_li]:mb-0.5 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_table]:text-[11px]" />
                          ) : (
                            <div className="whitespace-pre-wrap break-words text-xs leading-relaxed">
                              {msg.content}
                            </div>
                          )}
                        </div>
                        {msg.role === 'assistant' && selectedId && (
                          <CopyWithProvenance
                            content={msg.content}
                            messageId={msg.id}
                            sourceType="imported"
                            sourceId={selectedId}
                            sourceModel={msg.sourceModel || 'unknown'}
                          />
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : libraryDetailTab === 'topics' ? (
              selectedId ? (
                <SessionOutline
                  sessionId={selectedId}
                  sourceType="imported"
                  onSectionClick={(section: OutlineSection) => {
                    setLibraryDetailTab('messages');
                    setLibraryHighlightRange({
                      start: section.startMessageIndex,
                      end: section.endMessageIndex,
                    });
                    // Scroll to section after tab switch
                    setTimeout(() => {
                      const container = libraryMessagesRef.current;
                      if (container) {
                        const targetEl = container.querySelector(
                          `[data-message-index="${section.startMessageIndex}"]`
                        );
                        if (targetEl) {
                          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                      }
                    }, 100);
                  }}
                />
              ) : null
            ) : libraryDetailTab === 'knowledge' ? (
              selectedId ? (
                <ConversationKnowledge
                  conversationId={selectedId}
                  sourceType="imported"
                />
              ) : null
            ) : null}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            Select a conversation to view its messages
          </div>
        )}
      </div>

      {backfillOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => backfillBusy === null && setBackfillOpen(false)}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl w-[min(980px,94vw)] max-h-[min(84vh,760px)] flex flex-col overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div>
                <h3 className="text-sm font-medium text-gray-200">Backfill Library to Wiki</h3>
                <p className="text-[11px] text-gray-500 mt-1">
                  Start with newer active topics, archive useful history that may matter later, and skip low-value legacy records. Prism will turn that guideline into a reviewable Library backfill plan.
                </p>
              </div>
              <button onClick={() => backfillBusy === null && setBackfillOpen(false)} className="text-gray-500 hover:text-gray-300 text-lg">✕</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4">
              {backfillBusy ? (
                <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-200">
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-300" />
                    <span>
                      {backfillBusy === 'plan'
                        ? 'Analyzing Library and building a backfill plan...'
                        : 'Applying the selected backfill actions to Obsidian...'}
                    </span>
                  </div>
                </div>
              ) : null}

              <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-medium text-gray-300">Guideline</div>
                    <div className="mt-1 text-[11px] text-gray-500">
                      Recent records are usually the best starting point because the context is still alive. Mid-term records get compiled when they still inform current work; otherwise they are archived. Older records are usually skipped unless they still shape today&apos;s topics.
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void handleAnalyzeBackfill()}
                      disabled={backfillBusy !== null}
                      className="rounded bg-emerald-900/40 px-3 py-2 text-[11px] text-emerald-100 hover:bg-emerald-900/60 disabled:opacity-50"
                    >
                      {backfillBusy === 'plan' ? 'Analyzing...' : 'Analyze Library'}
                    </button>
                    {backfillJob?.id ? (
                      <>
                        <button
                          onClick={() => void handlePauseBackfillJob()}
                          disabled={backfillBusy !== null || !backfillJob.active || backfillJob.status !== 'running'}
                          className={`rounded px-3 py-2 text-[11px] transition-colors disabled:opacity-50 ${
                            backfillJob.active && backfillJob.status === 'running'
                              ? 'bg-amber-700/70 text-amber-50 ring-1 ring-amber-400/40'
                              : 'bg-amber-900/40 text-amber-100 hover:bg-amber-900/60'
                          }`}
                        >
                          Pause
                        </button>
                        <button
                          onClick={() => void handleResumeBackfillJob()}
                          disabled={backfillBusy !== null || (!backfillJob.resumable && backfillJob.active)}
                          className={`rounded px-3 py-2 text-[11px] transition-colors disabled:opacity-50 ${
                            backfillJob.resumable || (!backfillJob.active && backfillJob.status === 'paused')
                              ? 'bg-cyan-700/70 text-cyan-50 ring-1 ring-cyan-400/40'
                              : 'bg-cyan-900/40 text-cyan-100 hover:bg-cyan-900/60'
                          }`}
                        >
                          Resume
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
                {backfillPlan ? (
                  <div className="mt-3 flex flex-wrap gap-2 text-[10px]">
                    <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">{backfillPlan.totalConversations} conversations</span>
                    <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">
                      {(backfillPlan.recommendations ?? []).filter((item: any) => (backfillSelections[item.conversationId] ?? item.recommendedAction) === 'compile_now').length} compile now
                    </span>
                    <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">
                      {(backfillPlan.recommendations ?? []).filter((item: any) => (backfillSelections[item.conversationId] ?? item.recommendedAction) === 'archive_only').length} archive only
                    </span>
                    <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">
                      {(backfillPlan.recommendations ?? []).filter((item: any) => (backfillSelections[item.conversationId] ?? item.recommendedAction) === 'skip').length} skip
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-medium text-gray-300">Recommended Actions</div>
                    <div className="mt-1 text-[10px] text-gray-500">
                      Review Prism&apos;s recommendation and override anything before it writes to the wiki.
                    </div>
                  </div>
                  {backfillPlan ? (
                    <div className="text-[10px] text-gray-500">
                      {backfillPlan.recommendations?.length ?? 0} items
                    </div>
                  ) : null}
                </div>

                {backfillPlan?.recommendations?.length ? (
                  <div className="mt-3 max-h-[420px] space-y-2 overflow-y-auto pr-1">
                    {backfillPlan.recommendations.map((item: any) => {
                      const selectedAction = backfillSelections[item.conversationId] ?? item.recommendedAction;
                      return (
                        <div key={item.conversationId} className="rounded-lg border border-gray-800 bg-black/20 px-3 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                {platformBadge(item.sourcePlatform)}
                                <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-300">
                                  {formatBackfillAgeBucket(item.ageBucket)}
                                </span>
                                <span className="rounded bg-emerald-950/40 px-2 py-0.5 text-[10px] text-emerald-200">
                                  Recommended: {formatBackfillActionLabel(item.recommendedAction)}
                                </span>
                              </div>
                              <div className="mt-2 text-[12px] text-gray-100">{item.title}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-gray-500">
                                {item.projectName ? <span>Project: {item.projectName}</span> : null}
                                {item.lastActivityAt ? <span>Last activity: {formatLastActivity(item.lastActivityAt)}</span> : null}
                                {typeof item.messageCount === 'number' ? <span>{item.messageCount} msgs</span> : null}
                              </div>
                              {item.reasons?.length ? (
                                <div className="mt-2 space-y-1">
                                  {item.reasons.map((reason: string, index: number) => (
                                    <div key={`${item.conversationId}-reason-${index}`} className="text-[10px] text-gray-400">
                                      {reason}
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                            <div className="w-[160px] flex-shrink-0">
                              <label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Action</label>
                              <select
                                value={selectedAction}
                                onChange={(e) =>
                                  setBackfillSelections((prev) => ({
                                    ...prev,
                                    [item.conversationId]: e.target.value as 'compile_now' | 'archive_only' | 'skip',
                                  }))
                                }
                                className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-2 text-[11px] text-gray-200 focus:outline-none focus:border-emerald-500"
                              >
                                <option value="compile_now">Compile now</option>
                                <option value="archive_only">Archive only</option>
                                <option value="skip">Skip</option>
                              </select>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mt-3 text-[11px] text-gray-500">
                    No backfill plan yet. Analyze the Library first and Prism will recommend which records to compile now, archive, or skip.
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-medium text-gray-300">Background Run</div>
                    <div className="mt-1 text-[10px] text-gray-500">
                      Runs in batches of 10 by default. After each batch Prism lints the wiki, records tuning notes, and adjusts the next batch size when quality needs a tighter loop.
                    </div>
                  </div>
                  {backfillJob ? (
                    <span className="rounded bg-gray-800 px-2 py-1 text-[10px] text-gray-300">
                      {backfillJob.status}{backfillJob.active ? ' · active' : backfillJob.resumable ? ' · resumable' : ''}
                    </span>
                  ) : (
                    <span className="text-[10px] text-gray-500">No active job</span>
                  )}
                </div>
                {backfillJob ? (
                  <div className="mt-3 space-y-3">
                    {(() => {
                      const remainingSessions = Math.max(0, (backfillJob.totalItems ?? 0) - (backfillJob.processedItems ?? 0));
                      const batchProgress = deriveCurrentBatchProgress(backfillJob, backfillJobItems);
                      return (
                        <>
                    <div className="flex flex-wrap gap-2 text-[10px]">
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">{backfillJob.processedItems}/{backfillJob.totalItems} processed</span>
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">{remainingSessions} remaining</span>
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">{backfillJob.compiledCount} compiled</span>
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">{backfillJob.archivedCount} archived</span>
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">{backfillJob.skippedCount} skipped</span>
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">{backfillJob.failedCount} failed</span>
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">batch {backfillJob.nextBatchNumber}</span>
                      <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">current size {backfillJob.currentBatchSize}</span>
                      {typeof backfillJob.lastLintFindingCount === 'number' ? (
                        <span className="rounded bg-gray-800 px-2 py-1 text-gray-300">last lint {backfillJob.lastLintFindingCount} findings</span>
                      ) : null}
                    </div>
                    {batchProgress ? (
                      <div className="rounded border border-gray-800 bg-black/20 px-3 py-2 text-[11px] text-gray-300">
                        Current batch {batchProgress.batchNumber}: {batchProgress.completed}/{batchProgress.total} complete
                        {batchProgress.running ? ` · ${batchProgress.running} running` : ''}
                      </div>
                    ) : null}
                    {backfillJob.currentConversationTitle ? (
                      <div className="text-[11px] text-gray-400">Currently working on: {backfillJob.currentConversationTitle}</div>
                    ) : null}
                    {backfillJob.tuningNotes?.length ? (
                      <div className="rounded border border-violet-900/30 bg-violet-950/20 px-3 py-3">
                        <div className="text-[10px] uppercase tracking-wide text-violet-300">Adaptive Tuning Notes</div>
                        <div className="mt-2 space-y-1">
                          {backfillJob.tuningNotes.slice(-5).map((note: string, index: number) => (
                            <div key={`tuning-note-${index}`} className="text-[10px] text-violet-100/90">{note}</div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {backfillJobItems.length ? (
                      <div className="max-h-48 overflow-y-auto pr-1 space-y-2">
                        {backfillJobItems.slice(0, 12).map((item: any) => (
                          <div key={item.id} className="rounded border border-gray-800 bg-black/20 px-3 py-2">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="text-[11px] text-gray-200 truncate">{item.title}</div>
                                <div className="mt-1 text-[10px] text-gray-500">
                                  {formatBackfillActionLabel(item.selectedAction)} · {item.status}{item.batchNumber ? ` · batch ${item.batchNumber}` : ''}
                                </div>
                              </div>
                              {item.filePath ? (
                                <button
                                  onClick={() => void revealObsidianExport(item.filePath)}
                                  className="text-[10px] text-cyan-300 hover:text-cyan-200 underline underline-offset-2"
                                >
                                  Reveal
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                        </>
                      );
                    })()}
                  </div>
                ) : (
                  <div className="mt-3 text-[11px] text-gray-500">
                    Start a background run if you want Prism to keep processing the library in batches while you keep working elsewhere.
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-gray-800 px-4 py-3">
              <div className="text-[10px] text-gray-500">
                `Apply Backfill Plan` now starts the background run using your current selections. `Compile now` uses the full wiki compiler, `Archive only` stores the raw source for later, and `Skip` leaves the record out of this run.
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setBackfillOpen(false)}
                  disabled={backfillBusy !== null}
                  className="rounded bg-gray-800 px-3 py-2 text-[11px] text-gray-300 hover:bg-gray-700 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleStartBackfillJob()}
                  disabled={backfillBusy !== null || !backfillPlan?.recommendations?.length}
                  className="rounded bg-emerald-600 px-3 py-2 text-[11px] text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {backfillBusy === 'apply' ? 'Starting...' : 'Apply Backfill Plan'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {notionPickerOpen && pendingActionItems ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !notionSending && setNotionPickerOpen(false)}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl w-[420px] max-h-[480px] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div>
                <h3 className="text-sm font-medium text-gray-200">Create Action Items in Notion</h3>
                <p className="text-[11px] text-gray-500 mt-1">Pick a Notion page to append the generated action items.</p>
              </div>
              <button onClick={() => !notionSending && setNotionPickerOpen(false)} className="text-gray-500 hover:text-gray-300 text-lg">✕</button>
            </div>
            <div className="px-4 py-2 border-b border-gray-800">
              <input
                type="text"
                value={notionSearch}
                onChange={(e) => setNotionSearch(e.target.value)}
                placeholder="Search Notion pages..."
                className="w-full px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                autoFocus
              />
            </div>
            <div className="px-4 pt-3 text-[11px] text-gray-500">
              Generated with {pendingActionItems.model}. The final note will include Prism provenance.
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-2 min-h-0">
              {notionLoading ? (
                <div className="text-center text-gray-500 text-sm py-6">Loading pages...</div>
              ) : notionPages.length === 0 ? (
                <div className="text-center text-gray-500 text-sm py-6">No Notion pages found</div>
              ) : (
                notionPages.map((page) => (
                  <button
                    key={page.id}
                    onClick={() => void handleSendActionItemsToNotion(page.id)}
                    disabled={notionSending}
                    className="w-full text-left px-3 py-2 rounded-lg mb-0.5 hover:bg-gray-800/50 transition-colors flex items-center gap-2 disabled:opacity-50"
                  >
                    <span className="text-base flex-shrink-0">{page.iconEmoji || '📄'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-200 truncate">{page.title}</div>
                      <div className="text-[10px] text-gray-500">
                        {page.lastEditedAt ? new Date(page.lastEditedAt).toLocaleDateString() : ''}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
            {notionSending ? (
              <div className="px-4 py-2 border-t border-gray-800 text-center text-xs text-indigo-400">
                Appending action items to Notion...
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {obsidianSettingsOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !obsidianSettingsSaving && setObsidianSettingsOpen(false)}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl w-[520px] max-h-[420px] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div>
                <h3 className="text-sm font-medium text-gray-200">Obsidian Vault Path</h3>
                <p className="text-[11px] text-gray-500 mt-1">Prism writes raw sources to <span className="text-gray-400">Sources/ChatGPT</span>, context notes to <span className="text-gray-400">Meetings</span>, observations to <span className="text-gray-400">Observations</span>, and evergreen notes to <span className="text-gray-400">Notes</span>.</p>
              </div>
              <button onClick={() => !obsidianSettingsSaving && setObsidianSettingsOpen(false)} className="text-gray-500 hover:text-gray-300 text-lg">✕</button>
            </div>
            <div className="px-4 py-4 space-y-3">
              <div className="text-[11px] text-gray-500">
                Paste your vault root path, or let Prism choose the folder for you. Terminal prompts like <span className="text-gray-400">brian@Mac % /Users/...</span> will be normalized automatically.
              </div>
              <input
                type="text"
                value={obsidianVaultInput}
                onChange={(e) => setObsidianVaultInput(e.target.value)}
                placeholder="/Users/brian/Documents/Obsidian/MyVault"
                className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                autoFocus
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void handlePickObsidianFolder()}
                  disabled={obsidianSettingsSaving || obsidianFolderPicking}
                  className="px-3 py-2 text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-200 disabled:opacity-50"
                >
                  {obsidianFolderPicking ? 'Choosing Folder...' : 'Choose Folder'}
                </button>
                <div className="text-[11px] text-gray-500">macOS folder picker</div>
              </div>
            </div>
            <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
              <button
                onClick={() => setObsidianSettingsOpen(false)}
                disabled={obsidianSettingsSaving}
                className="px-3 py-2 text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSaveObsidianVault()}
                disabled={obsidianSettingsSaving}
                className="px-3 py-2 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
              >
                {obsidianSettingsSaving ? 'Saving...' : 'Save Vault Path'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {obsidianRoutingOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => compileBusy === null && obsidianBusy === null && setObsidianRoutingOpen(false)}>
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl w-[min(880px,92vw)] max-h-[min(84vh,760px)] flex flex-col overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div>
                <h3 className="text-sm font-medium text-gray-200">Compile Source to Wiki</h3>
                <p className="text-[11px] text-gray-500 mt-1">Prism will analyze the full source, detect multiple artifact types, and propose wiki changes for your review before anything is written.</p>
              </div>
              <button onClick={() => compileBusy === null && obsidianBusy === null && setObsidianRoutingOpen(false)} className="text-gray-500 hover:text-gray-300 text-lg">✕</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4">
              {compileBusy !== null ? (
                <div className="rounded-lg border border-violet-800/60 bg-violet-950/30 px-3 py-2 text-[11px] text-violet-200">
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-300" />
                    <span>
                      {compileBusy === 'analyze'
                        ? 'Analyzing source and building compile plan...'
                        : compileBusy === 'apply'
                          ? 'Applying selected wiki changes...'
                          : 'Rejecting compile plan...'}
                    </span>
                  </div>
                </div>
              ) : null}
              <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-medium text-gray-300">Compile Plan</div>
                    <div className="text-[10px] text-gray-500 mt-1">Analyze this source, then review and selectively apply the proposed wiki changes.</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void handleAnalyzeSourceToWiki()}
                      disabled={compileBusy !== null}
                      className="rounded bg-violet-900/40 px-3 py-2 text-[11px] text-violet-100 hover:bg-violet-900/60 disabled:opacity-50"
                    >
                      {compileBusy === 'analyze' ? 'Analyzing...' : 'Analyze Source'}
                    </button>
                  </div>
                </div>
                {selectedCompilePlan ? (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-lg border border-gray-800 bg-black/20 px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm text-gray-100">{selectedCompilePlan.sourceTitle}</div>
                          <div className="mt-1 text-[10px] text-gray-500">
                            {selectedCompilePlan.status} · {selectedCompilePlan.model || 'gpt-5.4'} · {formatLastActivity(selectedCompilePlan.createdAt)}
                          </div>
                        </div>
                        <div className="text-right text-[10px] text-gray-500">
                          {selectedCompilePlan.detectedArtifacts?.length ?? 0} artifacts
                          <br />
                          {selectedCompilePlan.items?.length ?? 0} planned changes
                        </div>
                      </div>
                      <div className="mt-3 text-[11px] text-gray-300">
                        {selectedCompilePlan.sourceSummary}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-gray-300">Detected Artifacts</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(selectedCompilePlan.detectedArtifacts ?? []).slice(0, 10).map((artifact: any) => (
                          <span key={artifact.id} className="rounded-full border border-indigo-900/60 bg-indigo-950/30 px-2 py-1 text-[10px] text-indigo-200">
                            {formatCompilePageKindLabel(artifact.pageKind)}: {artifact.title}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[11px] font-medium text-gray-300">Proposed Page Changes</div>
                        <div className="flex items-center gap-2 text-[10px] text-gray-500">
                          <button
                            onClick={() => setSelectedCompileItemIds((selectedCompilePlan.items ?? []).filter((item: any) => item.operation !== 'no_op').map((item: any) => item.id))}
                            className="hover:text-gray-300"
                          >
                            Select all
                          </button>
                          <button
                            onClick={() => setSelectedCompileItemIds([])}
                            className="hover:text-gray-300"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
                        {(selectedCompilePlan.items ?? []).map((item: any) => (
                          <label key={item.id} className="flex gap-3 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-3">
                            <input
                              type="checkbox"
                              checked={selectedCompileItemIds.includes(item.id)}
                              disabled={item.operation === 'no_op' || item.pageKind === 'index' || item.pageKind === 'log'}
                              onChange={(e) => {
                                setSelectedCompileItemIds((prev) =>
                                  e.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id)
                                );
                              }}
                              className="mt-1 h-4 w-4 rounded border-gray-600 bg-gray-800 text-violet-500"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-200">{formatCompileArtifactLabel(item.artifactType)}</span>
                                  <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">{formatCompilePageKindLabel(item.pageKind)}</span>
                                  <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">{item.operation}</span>
                                  {item.metadata?.reviewMode === 'relocate_replace' ? (
                                    <span className="rounded bg-amber-950/40 px-2 py-0.5 text-[10px] text-amber-300">relocate + replace</span>
                                  ) : null}
                                  <div className="truncate text-[11px] text-gray-200">{item.title}</div>
                                </div>
                                <div className="text-[10px] text-gray-500">{item.confidence?.toFixed?.(2) ?? item.confidence}</div>
                              </div>
                              <div className="mt-1 text-[10px] text-gray-500">{item.relativePath}</div>
                              {item.metadata?.relocateFrom ? (
                                <div className="mt-1 text-[10px] text-amber-300">Replaces legacy page: {item.metadata.relocateFrom}</div>
                              ) : null}
                              {item.diffSummary ? (
                                <div className="mt-2 text-[11px] text-gray-300">{item.diffSummary}</div>
                              ) : null}
                              <div className="mt-2 text-[11px] text-gray-400">{item.rationale}</div>
                              {item.rubricRationale ? (
                                <div className="mt-2 rounded border border-violet-900/40 bg-violet-950/20 px-2 py-2 text-[10px] text-violet-200">
                                  {item.rubricRationale}
                                </div>
                              ) : null}
                              {item.contentPreview ? (
                                <div className="mt-2 rounded bg-black/20 px-2 py-2 text-[10px] text-gray-400">
                                  {item.contentPreview}
                                </div>
                              ) : null}
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 text-[11px] text-gray-500">
                    No compile plan yet. Analyze the source first, then Prism will propose context, observation, evergreen, concept, topic, and project updates based on the content itself.
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-medium text-gray-300">Compile History</div>
                    <div className="text-[10px] text-gray-500 mt-1">Review previous compile plans for this source.</div>
                  </div>
                  <div className="text-[10px] text-gray-500">
                    {compilePlans.length} plans
                  </div>
                </div>
                {compilePlans.length ? (
                  <div className="mt-2 max-h-48 space-y-2 overflow-y-auto pr-1">
                    {compilePlans.map((plan) => (
                      <button
                        key={plan.id}
                        type="button"
                        onClick={() => {
                          setSelectedCompilePlan(plan);
                          setSelectedCompileItemIds(
                            (plan.items ?? []).filter((item: any) => item.selectedByDefault !== false).map((item: any) => item.id)
                          );
                        }}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                          selectedCompilePlan?.id === plan.id
                            ? 'border-violet-700/70 bg-violet-950/30'
                            : 'border-gray-800 bg-gray-900/50 hover:bg-gray-800/60'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-200">{plan.status}</span>
                            <span className="text-[11px] text-gray-300">{plan.detectedArtifacts?.length ?? 0} artifacts</span>
                          </div>
                          <span className="text-[10px] text-gray-500">{formatLastActivity(plan.createdAt)}</span>
                        </div>
                        <div className="mt-1 text-[10px] text-gray-500">
                          {plan.model || 'gpt-5.4'} · {plan.items?.length ?? 0} planned changes
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 text-[11px] text-gray-500">No compile plans yet for this conversation.</div>
                )}
              </div>
              <div className="pt-2 border-t border-gray-800">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-medium text-gray-300">Wiki Lint</div>
                    <div className="text-[10px] text-gray-500 mt-1">Health-check the wiki for missing links, duplicate pages, orphan notes, and missing provenance.</div>
                  </div>
                  <button
                    onClick={() => void handleRunWikiLint()}
                    disabled={wikiLintBusy || obsidianBusy !== null}
                    className="rounded bg-gray-800 px-3 py-2 text-[11px] text-gray-200 hover:bg-gray-700 disabled:opacity-50"
                  >
                    {wikiLintBusy ? 'Running...' : 'Run Wiki Lint'}
                  </button>
                </div>
                {wikiLintRuns.length ? (
                  <div className="mt-2 max-h-40 space-y-2 overflow-y-auto pr-1">
                    {wikiLintRuns.map((run) => (
                      <div key={run.id} className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-200">Lint</span>
                            <span className="text-[11px] text-gray-300">{run.status}</span>
                          </div>
                          <span className="text-[10px] text-gray-500">{formatLastActivity(run.createdAt)}</span>
                        </div>
                        <div className="mt-1 text-[10px] text-gray-500">
                          {(run.model || 'gpt-5.4')} · {run.findingCount} findings
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 text-[11px] text-gray-500">
                    No wiki lint runs yet.
                  </div>
                )}
              </div>
            </div>
            <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
              {selectedCompilePlan ? (
                <>
                  <button
                    onClick={() => void handleRejectCompile()}
                    disabled={compileBusy !== null}
                    className="px-3 py-2 text-xs rounded bg-amber-900/30 hover:bg-amber-900/50 text-amber-100 disabled:opacity-50"
                  >
                    {compileBusy === 'reject' ? 'Rejecting...' : 'Reject'}
                  </button>
                  <button
                    onClick={() => void handleApplyCompilePlan(false)}
                    disabled={compileBusy !== null || selectedCompileItemIds.length === 0}
                    className="px-3 py-2 text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-200 disabled:opacity-50"
                  >
                    {compileBusy === 'apply' ? 'Applying...' : 'Apply Selected'}
                  </button>
                  <button
                    onClick={() => void handleApplyCompilePlan(true)}
                    disabled={compileBusy !== null}
                    className="px-3 py-2 text-xs rounded bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
                  >
                    {compileBusy === 'apply' ? 'Applying...' : 'Apply All'}
                  </button>
                </>
              ) : null}
              <button
                onClick={() => setObsidianRoutingOpen(false)}
                disabled={compileBusy !== null}
                className="px-3 py-2 text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50"
              >
                {compileBusy !== null ? 'Processing...' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
