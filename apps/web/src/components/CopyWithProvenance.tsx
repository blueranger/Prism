'use client';

import { useState, useCallback } from 'react';
import { computeContentHash } from '@/lib/crypto-utils';
import { createProvenance, searchProvenanceByHash } from '@/lib/api';

interface CopyWithProvenanceProps {
  content: string;
  messageId: string;
  sourceType: 'native' | 'imported';
  sourceId: string;          // sessionId if native, conversationId if imported
  sourceModel: string;
}

export default function CopyWithProvenance({
  content,
  messageId,
  sourceType,
  sourceId,
  sourceModel,
}: CopyWithProvenanceProps) {
  const [isCopied, setIsCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleCopy = useCallback(async () => {
    if (isLoading) return;

    setIsLoading(true);
    try {
      // Compute content hash
      const contentHash = await computeContentHash(content);

      // Check if hash exists in provenance DB
      const existing = await searchProvenanceByHash(contentHash);
      let shortCode: string;

      if (existing.records && existing.records.length > 0) {
        // Reuse existing short code
        shortCode = existing.records[0].shortCode;
      } else {
        // Create new provenance record
        const result = await createProvenance({
          sourceType,
          sessionId: sourceType === 'native' ? sourceId : undefined,
          conversationId: sourceType === 'imported' ? sourceId : undefined,
          messageId,
          content,
          contentHash,
          sourceModel,
        });
        shortCode = result.record?.shortCode;
      }

      // Copy to clipboard with provenance footer
      const textToCopy = `${content}\n\n— Prism ${shortCode}`;
      await navigator.clipboard.writeText(textToCopy);

      // Show feedback
      setIsCopied(true);
      setTimeout(() => {
        setIsCopied(false);
      }, 2000);
    } catch (err) {
      console.error('[CopyWithProvenance] Error:', err);
      // Still try to copy without provenance on error
      try {
        await navigator.clipboard.writeText(content);
        setIsCopied(true);
        setTimeout(() => {
          setIsCopied(false);
        }, 2000);
      } catch {
        console.error('[CopyWithProvenance] Clipboard write failed');
      }
    } finally {
      setIsLoading(false);
    }
  }, [content, messageId, sourceType, sourceId, sourceModel]);

  return (
    <button
      onClick={handleCopy}
      disabled={isLoading}
      title={isCopied ? 'Copied!' : 'Copy with provenance'}
      className="inline-flex items-center justify-center p-1 rounded text-gray-500 hover:text-gray-300 disabled:opacity-50 transition-colors"
      aria-label="Copy message content"
    >
      {isCopied ? (
        <svg
          className="w-4 h-4 text-green-400"
          fill="currentColor"
          viewBox="0 0 20 20"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            fillRule="evenodd"
            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
            clipRule="evenodd"
          />
        </svg>
      ) : (
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
      )}
    </button>
  );
}
