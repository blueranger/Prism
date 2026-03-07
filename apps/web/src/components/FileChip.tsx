'use client';

import { useState, useRef, useCallback } from 'react';
import { deleteFile } from '@/lib/api';
import FileHoverCard from './FileHoverCard';
import FileTextModal from './FileTextModal';
import type { UploadedFile } from '@prism/shared';

const FILE_ICONS: Record<string, string> = {
  'application/pdf': '\u{1F4C4}',
  'image/png': '\u{1F5BC}',
  'image/jpeg': '\u{1F5BC}',
  'image/webp': '\u{1F5BC}',
  'image/gif': '\u{1F5BC}',
  // Office documents
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '\u{1F4D8}',  // 📘
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '\u{1F4CA}',        // 📊
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '\u{1F4FD}', // 📽️
};

const HOVER_SHOW_DELAY = 300;
const HOVER_HIDE_DELAY = 200;

interface FileChipProps {
  file: UploadedFile;
  onRemoved?: (fileId: string) => void;
}

export default function FileChip({ file, onRemoved }: FileChipProps) {
  const [deleting, setDeleting] = useState(false);
  const [showHover, setShowHover] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const icon = FILE_ICONS[file.mimeType] ?? '\u{1F4CE}';

  // --- Hover delay logic ---
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

  // Keep popup open when mouse moves to the hover card
  const handleCardEnter = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const handleCardLeave = useCallback(() => {
    hideTimer.current = setTimeout(() => setShowHover(false), HOVER_HIDE_DELAY);
  }, []);

  const statusLabel = () => {
    switch (file.status) {
      case 'pending':
        return (
          <span className="flex items-center gap-1 text-[10px] text-yellow-400">
            <span className="inline-block w-2.5 h-2.5 border-[1.5px] border-yellow-400 border-t-transparent rounded-full animate-spin" />
            Pending
          </span>
        );
      case 'processing':
        return (
          <span className="flex items-center gap-1 text-[10px] text-indigo-400">
            <span className="inline-block w-2.5 h-2.5 border-[1.5px] border-indigo-400 border-t-transparent rounded-full animate-spin" />
            Analyzing
          </span>
        );
      case 'done':
        return (
          <span className="flex items-center gap-1 text-[10px] text-green-400 font-medium">
            <span>{'\u2713'}</span>
            Ready
          </span>
        );
      case 'error':
        return (
          <span
            className="flex items-center gap-1 text-[10px] text-red-400"
            title={file.errorMessage ?? 'Analysis failed'}
          >
            <span>{'\u26A0'}</span>
            Error
          </span>
        );
      default:
        return null;
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleting(true);
    const ok = await deleteFile(file.id);
    if (ok && onRemoved) {
      onRemoved(file.id);
    }
    setDeleting(false);
  };

  const displayName = file.filename.length > 30
    ? file.filename.slice(0, 27) + '...'
    : file.filename;

  const sizeStr = file.fileSize > 1024 * 1024
    ? `${(file.fileSize / (1024 * 1024)).toFixed(1)}MB`
    : `${Math.round(file.fileSize / 1024)}KB`;

  const borderClass =
    file.status === 'done'
      ? 'bg-gray-800 border-green-700/40 hover:border-green-600/60'
      : file.status === 'error'
        ? 'bg-red-900/20 border-red-800/50'
        : 'bg-gray-800/50 border-gray-700/50';

  return (
    <>
      <div
        className="relative inline-flex flex-col animate-fade-in-scale"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Hover Card */}
        {showHover && (
          <FileHoverCard
            file={file}
            onViewFullText={() => {
              setShowHover(false);
              setShowModal(true);
            }}
            onMouseEnter={handleCardEnter}
            onMouseLeave={handleCardLeave}
          />
        )}

        {/* Chip */}
        <div
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors cursor-default ${borderClass}`}
        >
          <span>{icon}</span>
          <span className="text-gray-300 truncate max-w-[200px]">{displayName}</span>
          <span className="text-gray-600">{sizeStr}</span>
          {statusLabel()}
          {!deleting && (
            <button
              onClick={handleDelete}
              className="text-gray-600 hover:text-gray-400 transition-colors ml-0.5"
              title="Remove file"
            >
              {'\u00D7'}
            </button>
          )}
          {deleting && (
            <span className="inline-block w-2.5 h-2.5 border border-gray-500 border-t-transparent rounded-full animate-spin" />
          )}
        </div>
      </div>

      {/* Full Text Modal */}
      {showModal && file.extractedText && (
        <FileTextModal
          filename={file.filename}
          text={file.extractedText}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}
