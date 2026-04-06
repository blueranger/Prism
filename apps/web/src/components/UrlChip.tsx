'use client';

import { useCallback, useRef, useState } from 'react';
import type { UrlPreview } from '@prism/shared';
import UrlHoverCard from './UrlHoverCard';

const HOVER_SHOW_DELAY = 300;
const HOVER_HIDE_DELAY = 200;

interface UrlChipProps {
  preview: UrlPreview;
  statusLabel?: string;
  linkCount?: number;
  onOpen?: () => void;
  onRemove?: () => void;
}

export default function UrlChip({
  preview,
  statusLabel = 'Ready',
  linkCount,
  onOpen,
  onRemove,
}: UrlChipProps) {
  const [showHover, setShowHover] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    showTimer.current = setTimeout(() => setShowHover(true), HOVER_SHOW_DELAY);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (showTimer.current) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    hideTimer.current = setTimeout(() => setShowHover(false), HOVER_HIDE_DELAY);
  }, []);

  const handleCardEnter = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const handleCardLeave = useCallback(() => {
    hideTimer.current = setTimeout(() => setShowHover(false), HOVER_HIDE_DELAY);
  }, []);

  const host = (() => {
    try {
      return new URL(preview.url).hostname;
    } catch {
      return preview.url;
    }
  })();

  const title = preview.title ?? host;
  const displayTitle = title.length > 30 ? `${title.slice(0, 27)}...` : title;

  return (
    <>
      <div
        className="relative inline-flex flex-col animate-fade-in-scale"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {showHover && (
          <UrlHoverCard
            preview={preview}
            linkCount={linkCount}
            onViewFullText={() => {
              setShowHover(false);
              onOpen?.();
            }}
            onMouseEnter={handleCardEnter}
            onMouseLeave={handleCardLeave}
          />
        )}

        <button
          type="button"
          onClick={() => onOpen?.()}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-cyan-700/40 bg-gray-800 px-2.5 py-1.5 text-xs transition-colors hover:border-cyan-600/60"
        >
          <span>{'\u{1F517}'}</span>
          <span className="max-w-[220px] truncate text-gray-300">{displayTitle}</span>
          <span className="text-gray-600">{host}</span>
          <span className="flex items-center gap-1 text-[10px] font-medium text-green-400">
            <span>{'\u2713'}</span>
            {statusLabel}
          </span>
          {onRemove && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onRemove();
                }
              }}
              className="ml-0.5 text-gray-500 hover:text-gray-300"
            >
              {'\u00D7'}
            </span>
          )}
        </button>
      </div>
    </>
  );
}
