'use client';

import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '@/stores/chat-store';
import type { CommNotification } from '@prism/shared';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function CommNotificationBadge() {
  const unreadCount = useChatStore((s) => s.commUnreadCount);
  const notifications = useChatStore((s) => s.commNotifications);
  const clearNotifications = useChatStore((s) => s.clearCommNotifications);
  const setMode = useChatStore((s) => s.setMode);
  const setUnreadCount = useChatStore((s) => s.setCommUnreadCount);
  const setSelectedThreadId = useChatStore((s) => s.setCommSelectedThreadId);

  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;

    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function handleToggle() {
    if (open) {
      setOpen(false);
    } else {
      setOpen(true);
      // Mark as read when opening
      setUnreadCount(0);
    }
  }

  function handleGoToComms() {
    setOpen(false);
    setMode('communication');
  }

  function handleNotificationClick(n: CommNotification) {
    setOpen(false);
    setMode('communication');
    // Navigate to the specific thread if threadId is available
    if (n.type === 'rule_matched' && n.threadId) {
      setSelectedThreadId(n.threadId);
    }
  }

  function handleClear() {
    clearNotifications();
    setOpen(false);
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={handleToggle}
        className="relative px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 border border-gray-600 transition-colors"
      >
        Comms
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] flex items-center justify-center bg-red-500 text-white text-[10px] font-bold rounded-full px-1">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-gray-900 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <span className="text-xs font-semibold text-gray-300">Notifications</span>
            <div className="flex gap-2">
              {notifications.length > 0 && (
                <button
                  onClick={handleClear}
                  className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Clear all
                </button>
              )}
              <button
                onClick={handleGoToComms}
                className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                Open Comms
              </button>
            </div>
          </div>

          {/* Notification list */}
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 && (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-gray-500">No notifications yet</p>
                <p className="text-[10px] text-gray-600 mt-1">
                  Monitor rules will show alerts here
                </p>
              </div>
            )}

            {notifications.map((n, i) => {
              if (n.type === 'triage_complete') {
                return (
                  <button
                    key={`triage-${n.timestamp}-${i}`}
                    onClick={() => handleNotificationClick(n)}
                    className="w-full text-left px-4 py-3 hover:bg-gray-800/50 transition-colors border-b border-gray-800/50 last:border-b-0"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                      <span className="text-xs font-medium text-gray-200 truncate flex-1">
                        Email Triage Complete
                      </span>
                      <span className="text-[10px] text-gray-600 shrink-0">
                        {formatTime(n.timestamp)}
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-400 pl-3.5">
                      Triaged {n.totalTriaged} email{n.totalTriaged !== 1 ? 's' : ''}
                      {n.draftsGenerated > 0 && ` · ${n.draftsGenerated} draft${n.draftsGenerated !== 1 ? 's' : ''} generated`}
                    </p>
                  </button>
                );
              }

              // rule_matched notification
              return (
                <button
                  key={`${n.ruleId}-${n.timestamp}-${i}`}
                  onClick={() => handleNotificationClick(n)}
                  className="w-full text-left px-4 py-3 hover:bg-gray-800/50 transition-colors border-b border-gray-800/50 last:border-b-0"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      n.action === 'notify'
                        ? 'bg-blue-400'
                        : n.action === 'draft_reply'
                          ? 'bg-green-400'
                          : 'bg-purple-400'
                    }`} />
                    <span className="text-xs font-medium text-gray-200 truncate flex-1">
                      {n.ruleName}
                    </span>
                    <span className="text-[10px] text-gray-600 shrink-0">
                      {formatTime(n.timestamp)}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-400 truncate pl-3.5">
                    {n.message.sender}
                    {n.message.subject ? ` — ${n.message.subject}` : ''}
                  </p>
                  <p className="text-[10px] text-gray-500 truncate pl-3.5 mt-0.5">
                    {n.message.preview}
                  </p>
                  {n.draftId && (
                    <span className="inline-block text-[9px] text-green-400 bg-green-600/10 px-1.5 py-0.5 rounded mt-1 ml-3.5">
                      Draft ready — click to review
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
