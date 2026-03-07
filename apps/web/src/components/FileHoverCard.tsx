'use client';

import type { UploadedFile } from '@prism/shared';

const FILE_ICONS: Record<string, string> = {
  'application/pdf': '\u{1F4C4}',
  'image/png': '\u{1F5BC}',
  'image/jpeg': '\u{1F5BC}',
  'image/webp': '\u{1F5BC}',
  'image/gif': '\u{1F5BC}',
};

interface FileHoverCardProps {
  file: UploadedFile;
  onViewFullText?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export default function FileHoverCard({
  file,
  onViewFullText,
  onMouseEnter,
  onMouseLeave,
}: FileHoverCardProps) {
  const icon = FILE_ICONS[file.mimeType] ?? '\u{1F4CE}';

  const sizeStr =
    file.fileSize > 1024 * 1024
      ? `${(file.fileSize / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(file.fileSize / 1024)} KB`;

  const meta = file.metadata as Record<string, unknown> | undefined;
  const pageCount = meta?.pageCount as number | undefined;
  const method = meta?.method as string | undefined;

  const textPreview = file.extractedText
    ? file.extractedText.length > 500
      ? file.extractedText.slice(0, 500) + '...'
      : file.extractedText
    : null;

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="absolute bottom-full left-0 mb-2 z-50 w-[380px] max-h-[400px] overflow-y-auto
                 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl
                 text-xs text-gray-300 animate-fade-in-scale"
      style={{ pointerEvents: 'auto' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-gray-800">
        <span className="text-base">{icon}</span>
        <span className="font-medium text-gray-100 truncate flex-1">{file.filename}</span>
        <span className="text-gray-500 flex-shrink-0">{sizeStr}</span>
      </div>

      <div className="px-4 py-2.5 space-y-3">
        {/* Status / Meta row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {file.status === 'done' && (
            <span className="flex items-center gap-1 text-green-400 font-medium">
              {'\u2713'} Ready
            </span>
          )}
          {file.status === 'processing' && (
            <span className="flex items-center gap-1 text-indigo-400">
              <span className="inline-block w-2.5 h-2.5 border-[1.5px] border-indigo-400 border-t-transparent rounded-full animate-spin" />
              Analyzing...
            </span>
          )}
          {file.status === 'pending' && (
            <span className="flex items-center gap-1 text-yellow-400">
              <span className="inline-block w-2.5 h-2.5 border-[1.5px] border-yellow-400 border-t-transparent rounded-full animate-spin" />
              Pending
            </span>
          )}
          {file.status === 'error' && (
            <span className="text-red-400">{'\u26A0'} Error</span>
          )}

          {file.analyzedBy && (
            <>
              <span className="text-gray-600">{'\u00B7'}</span>
              <span className="text-gray-400">
                Analyzed by <span className="text-gray-300">{file.analyzedBy}</span>
              </span>
            </>
          )}

          {pageCount != null && (
            <>
              <span className="text-gray-600">{'\u00B7'}</span>
              <span className="text-gray-400">
                {pageCount} {pageCount === 1 ? 'page' : 'pages'}
              </span>
            </>
          )}

          {method && (
            <>
              <span className="text-gray-600">{'\u00B7'}</span>
              <span className="text-gray-500 italic">{method}</span>
            </>
          )}
        </div>

        {/* Error message */}
        {file.status === 'error' && file.errorMessage && (
          <div className="px-2.5 py-2 bg-red-900/20 border border-red-800/40 rounded-lg text-red-300 text-[11px]">
            {file.errorMessage}
          </div>
        )}

        {/* Processing state */}
        {(file.status === 'pending' || file.status === 'processing') && !file.summary && (
          <div className="text-gray-500 italic text-[11px] py-2">
            File is being analyzed. Results will appear here once complete.
          </div>
        )}

        {/* Summary */}
        {file.summary && (
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1">
              Summary
            </div>
            <div className="text-gray-300 leading-relaxed whitespace-pre-wrap">
              {file.summary}
            </div>
          </div>
        )}

        {/* Extracted Text Preview */}
        {textPreview && (
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1">
              Extracted Text
            </div>
            <div className="text-gray-400 leading-relaxed whitespace-pre-wrap font-mono text-[10px] max-h-[120px] overflow-hidden bg-gray-800/50 rounded-lg px-2.5 py-2">
              {textPreview}
            </div>
          </div>
        )}

        {/* View Full Text button */}
        {file.extractedText && file.extractedText.length > 0 && (
          <div className="pt-1 pb-0.5 text-center">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onViewFullText?.();
              }}
              className="text-indigo-400 hover:text-indigo-300 text-[11px] font-medium transition-colors"
            >
              View Full Text ({file.extractedText.length.toLocaleString()} chars)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
