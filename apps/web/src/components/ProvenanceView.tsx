'use client';

import { useState, useEffect, useCallback } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { listProvenance, getProvenance, searchProvenanceByHash, updateProvenanceNote, deleteProvenanceRecord } from '@/lib/api';
import { computeContentHash } from '@/lib/crypto-utils';
import type { ProvenanceRecord } from '@prism/shared';

const PAGE_SIZE = 20;

/**
 * Hook to auto-lookup a provenance record when navigated from another component
 * (e.g. clicking a PRZ-xxx link in SendToNotion).
 */
function useProvenanceLookup(
  setSearchInput: (v: string) => void,
  triggerSearch: (code: string) => void,
) {
  const lookupCode = useChatStore((s) => s.provenanceLookupCode);
  const clearLookup = useChatStore((s) => s.clearProvenanceLookup);

  useEffect(() => {
    if (lookupCode) {
      setSearchInput(lookupCode);
      triggerSearch(lookupCode);
      clearLookup();
    }
  }, [lookupCode]);
}

function modelColor(model: string): string {
  if (model.includes('gpt') || model.includes('openai') || model.includes('o3') || model.includes('o4')) {
    return 'bg-green-900/50 text-green-400';
  }
  if (model.includes('claude') || model.includes('anthropic')) {
    return 'bg-orange-900/50 text-orange-400';
  }
  if (model.includes('gemini') || model.includes('google')) {
    return 'bg-blue-900/50 text-blue-400';
  }
  return 'bg-gray-800 text-gray-400';
}

export default function ProvenanceView() {
  const [records, setRecords] = useState<ProvenanceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'native' | 'imported'>('all');
  const [currentPage, setCurrentPage] = useState(0);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);

  // Load records
  const loadRecords = useCallback(async (page = 0) => {
    setLoading(true);
    setSearchError(null);
    try {
      const result = await listProvenance({
        sourceType: sourceFilter === 'all' ? undefined : sourceFilter,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      setRecords(result.records as ProvenanceRecord[]);
      setTotal(result.total);
      setCurrentPage(page);
    } catch (err) {
      console.error('[ProvenanceView] Load error:', err);
      setRecords([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [sourceFilter]);

  // Initial load
  useEffect(() => {
    loadRecords(0);
  }, [loadRecords, sourceFilter]);

  // Handle search — accepts optional query override for programmatic lookups
  const handleSearch = useCallback(async (queryOverride?: string) => {
    const query = queryOverride ?? searchInput;
    if (!query.trim()) {
      loadRecords(0);
      return;
    }

    setLoading(true);
    setSearchError(null);
    try {
      let result;

      // If query starts with "PRZ-", search by ID
      if (query.startsWith('PRZ-')) {
        const record = await getProvenance(query);
        result = { records: [record], total: 1 };
      } else {
        // Otherwise compute hash and search
        const hash = await computeContentHash(query);
        result = await searchProvenanceByHash(hash);
      }

      setRecords(result.records as ProvenanceRecord[]);
      setTotal(result.total);
      setCurrentPage(0);

      // Auto-select the record if only one result
      if (result.records.length === 1) {
        setSelectedId(result.records[0].id);
      }

      if (result.records.length === 0) {
        setSearchError('No matching records found');
      }
    } catch (err) {
      console.error('[ProvenanceView] Search error:', err);
      setSearchError(`Search failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setRecords([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [searchInput]);

  // Auto-lookup when navigated from another component (e.g. SendToNotion PRZ-xxx click)
  useProvenanceLookup(setSearchInput, (code) => handleSearch(code));

  // Handle note save
  const handleSaveNote = useCallback(async (recordId: string) => {
    try {
      await updateProvenanceNote(recordId, noteText);
      const updated = records.map((r) =>
        r.id === recordId ? { ...r, note: noteText } : r
      );
      setRecords(updated);
      setEditingNote(null);
      setNoteText('');
    } catch (err) {
      console.error('[ProvenanceView] Save note error:', err);
    }
  }, [records, noteText]);

  // Handle delete
  const handleDelete = useCallback(async (recordId: string) => {
    if (!confirm('Delete this provenance record?')) return;
    try {
      await deleteProvenanceRecord(recordId);
      setRecords(records.filter((r) => r.id !== recordId));
      setSelectedId(null);
    } catch (err) {
      console.error('[ProvenanceView] Delete error:', err);
    }
  }, [records]);

  // Handle jump to source
  const handleJumpToSource = useCallback((record: ProvenanceRecord) => {
    if (record.sourceType === 'native' && record.sessionId) {
      useChatStore.getState().setMode('parallel');
      // Optionally restore session
      // useChatStore.getState().selectSession(record.sessionId);
    } else if (record.sourceType === 'imported' && record.conversationId) {
      useChatStore.getState().setMode('library');
      // Optionally restore conversation
      // useChatStore.getState().selectLibraryConversation(record.conversationId);
    }
  }, []);

  const selectedRecord = records.find((r) => r.id === selectedId);

  return (
    <div className="flex-1 flex gap-4 min-h-0">
      {/* Left panel: provenance list */}
      <div className="w-80 flex-shrink-0 flex flex-col min-h-0 gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-300">
            Provenance
            <span className="text-gray-500 font-normal ml-1">({total})</span>
          </h2>
        </div>

        {/* Filter dropdown */}
        <div>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as 'all' | 'native' | 'imported')}
            className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 focus:outline-none focus:border-gray-500"
          >
            <option value="all">All Sources</option>
            <option value="native">Native Only</option>
            <option value="imported">Imported Only</option>
          </select>
        </div>

        {/* Search */}
        <div className="flex gap-1">
          <input
            type="text"
            placeholder="PRZ-xxx or paste content..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="flex-1 px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500"
          />
          <button
            onClick={() => handleSearch()}
            className="px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-400 hover:text-gray-200"
          >
            Search
          </button>
        </div>

        {/* Error message */}
        {searchError && (
          <div className="text-xs text-red-400 bg-red-900/30 rounded px-2 py-1">
            {searchError}
          </div>
        )}

        {/* Record list */}
        <div className="flex-1 overflow-y-auto space-y-1">
          {loading && records.length === 0 ? (
            <p className="text-xs text-gray-600 text-center py-4">Loading...</p>
          ) : records.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-xs text-gray-500">No provenance records yet.</p>
              <p className="text-xs text-gray-600 mt-1">Copy AI messages to start tracking.</p>
            </div>
          ) : (
            <>
              {records.map((record) => (
                <button
                  key={record.id}
                  onClick={() => {
                    setSelectedId(record.id);
                    setEditingNote(null);
                  }}
                  className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                    selectedId === record.id
                      ? 'bg-gray-700 border border-gray-600'
                      : 'hover:bg-gray-800/50 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-xs text-indigo-400">{record.shortCode}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${modelColor(record.sourceModel)}`}>
                      {record.sourceModel.split('/').pop() || record.sourceModel}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-500 line-clamp-2">
                    {record.contentPreview}
                  </p>
                  <div className="text-[10px] text-gray-600 mt-1">
                    {new Date(record.copiedAt).toLocaleDateString()}
                  </div>
                </button>
              ))}

              {/* Pagination */}
              {total > PAGE_SIZE && (
                <div className="flex items-center justify-between pt-2 text-xs text-gray-500">
                  <button
                    onClick={() => loadRecords(Math.max(0, currentPage - 1))}
                    disabled={currentPage === 0}
                    className="px-2 py-1 rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    ← Prev
                  </button>
                  <span>
                    {currentPage + 1} / {Math.ceil(total / PAGE_SIZE)}
                  </span>
                  <button
                    onClick={() => loadRecords(currentPage + 1)}
                    disabled={(currentPage + 1) * PAGE_SIZE >= total}
                    className="px-2 py-1 rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right panel: detail view */}
      <div className="flex-1 flex flex-col min-h-0 pl-2">
        {selectedRecord ? (
          <>
            {/* Header */}
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-gray-200 font-mono">{selectedRecord.shortCode}</h3>
              <p className="text-xs text-gray-500 mt-1">
                {selectedRecord.sourceType === 'native' ? 'Native' : 'Imported'} ·{' '}
                {new Date(selectedRecord.copiedAt).toLocaleString()}
              </p>
            </div>

            {/* Content preview */}
            <div className="mb-3">
              <label className="text-xs font-semibold text-gray-400 block mb-1">Content</label>
              <pre className="bg-gray-800 border border-gray-700 rounded p-2 text-xs text-gray-300 overflow-x-auto max-h-24">
                {selectedRecord.contentPreview}
              </pre>
            </div>

            {/* Metadata */}
            <div className="mb-3 space-y-2">
              <div>
                <label className="text-xs font-semibold text-gray-400">Source Model</label>
                <p className={`text-xs mt-1 px-2 py-1 rounded w-fit ${modelColor(selectedRecord.sourceModel)}`}>
                  {selectedRecord.sourceModel}
                </p>
              </div>

              {selectedRecord.sourceType && (
                <div>
                  <label className="text-xs font-semibold text-gray-400">Source Type</label>
                  <p className="text-xs text-gray-400 mt-1">{selectedRecord.sourceType}</p>
                </div>
              )}
            </div>

            {/* Entities */}
            {selectedRecord.entities && selectedRecord.entities.length > 0 && (
              <div className="mb-3">
                <label className="text-xs font-semibold text-gray-400 block mb-1">Entities</label>
                <div className="flex flex-wrap gap-1">
                  {selectedRecord.entities.map((entity) => (
                    <span
                      key={entity}
                      className="text-[10px] bg-indigo-900/50 text-indigo-300 px-2 py-0.5 rounded"
                    >
                      {entity}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Tags */}
            {selectedRecord.tags && selectedRecord.tags.length > 0 && (
              <div className="mb-3">
                <label className="text-xs font-semibold text-gray-400 block mb-1">Tags</label>
                <div className="flex flex-wrap gap-1">
                  {selectedRecord.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] bg-purple-900/50 text-purple-300 px-2 py-0.5 rounded"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Note editor */}
            <div className="mb-3 flex-1 flex flex-col min-h-0">
              <label className="text-xs font-semibold text-gray-400 block mb-1">Note</label>
              {editingNote === selectedRecord.id ? (
                <div className="flex flex-col gap-2 flex-1">
                  <textarea
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    className="flex-1 px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500 resize-none"
                    placeholder="Add a note..."
                  />
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleSaveNote(selectedRecord.id)}
                      className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingNote(null)}
                      className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2 flex-1">
                  {selectedRecord.note ? (
                    <p className="text-xs text-gray-300 bg-gray-800/50 rounded p-2 flex-1">
                      {selectedRecord.note}
                    </p>
                  ) : (
                    <p className="text-xs text-gray-600">No note yet</p>
                  )}
                  <button
                    onClick={() => {
                      setEditingNote(selectedRecord.id);
                      setNoteText(selectedRecord.note || '');
                    }}
                    className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
                  >
                    {selectedRecord.note ? 'Edit Note' : 'Add Note'}
                  </button>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-3 border-t border-gray-700">
              {(selectedRecord.sourceType === 'native' || selectedRecord.sourceType === 'imported') && (
                <button
                  onClick={() => handleJumpToSource(selectedRecord)}
                  className="px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                >
                  Jump to Source
                </button>
              )}
              <button
                onClick={() => handleDelete(selectedRecord.id)}
                className="px-3 py-1 text-xs rounded bg-red-900/50 hover:bg-red-900 text-red-300 transition-colors ml-auto"
              >
                Delete
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            Select a provenance record to view details
          </div>
        )}
      </div>
    </div>
  );
}
