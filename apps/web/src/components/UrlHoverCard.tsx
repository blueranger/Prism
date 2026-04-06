'use client';

import type { UrlPreview } from '@prism/shared';

interface UrlHoverCardProps {
  preview: UrlPreview;
  linkCount?: number;
  onViewFullText?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export default function UrlHoverCard({
  preview,
  linkCount,
  onViewFullText,
  onMouseEnter,
  onMouseLeave,
}: UrlHoverCardProps) {
  const textPreview = preview.content.length > 500
    ? preview.content.slice(0, 500) + '...'
    : preview.content;

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="absolute bottom-full left-0 z-50 mb-2 max-h-[400px] w-[380px] overflow-y-auto rounded-xl border border-gray-700 bg-gray-900 text-xs text-gray-300 shadow-2xl animate-fade-in-scale"
      style={{ pointerEvents: 'auto' }}
    >
      <div className="border-b border-gray-800 px-4 pb-2 pt-3">
        <div className="truncate text-sm font-medium text-gray-100">
          {preview.title ?? new URL(preview.url).hostname}
        </div>
        <div className="truncate text-[11px] text-gray-500">{preview.url}</div>
      </div>

      <div className="space-y-3 px-4 py-2.5">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="font-medium text-green-400">{'\u2713'} Ready</span>
          <span className="text-gray-600">{'\u00B7'}</span>
          <span className="text-gray-400">{preview.content.length.toLocaleString()} chars extracted</span>
          {typeof linkCount === 'number' && (
            <>
              <span className="text-gray-600">{'\u00B7'}</span>
              <span className="text-gray-400">{linkCount} linked page{linkCount === 1 ? '' : 's'}</span>
            </>
          )}
        </div>

        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-gray-500">
            Extracted Text
          </div>
          <div className="rounded-lg bg-gray-800/50 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-gray-400">
            {textPreview}
          </div>
        </div>

        <div className="pb-0.5 pt-1 text-center">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onViewFullText?.();
            }}
            className="text-[11px] font-medium text-indigo-400 transition-colors hover:text-indigo-300"
          >
            View Full Text ({preview.content.length.toLocaleString()} chars)
          </button>
        </div>
      </div>
    </div>
  );
}
