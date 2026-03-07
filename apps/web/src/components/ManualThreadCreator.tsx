'use client';

import { useState } from 'react';
import { createManualThread } from '@/lib/api';
import type { ExternalThread, ConnectorStatus } from '@prism/shared';

interface Props {
  accounts: ConnectorStatus[];
  onClose: () => void;
  onCreated: (thread: ExternalThread) => void;
}

export default function ManualThreadCreator({ accounts, onClose, onCreated }: Props) {
  const [accountId, setAccountId] = useState(accounts[0]?.accountId ?? '');
  const [displayName, setDisplayName] = useState('');
  const [senderEmail, setSenderEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [isGroup, setIsGroup] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!displayName.trim()) {
      setError('Contact name is required');
      return;
    }
    setCreating(true);
    setError(null);

    const thread = await createManualThread({
      accountId,
      displayName: displayName.trim(),
      senderName: displayName.trim(),
      senderEmail: senderEmail.trim() || undefined,
      subject: subject.trim() || undefined,
      isGroup,
    });

    setCreating(false);

    if (!thread) {
      setError('Failed to create thread');
      return;
    }

    onCreated(thread);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-100">New Thread</h3>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {error && (
          <div className="mb-3 px-3 py-2 bg-red-900/30 border border-red-800/50 rounded text-xs text-red-400">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {/* Account selector (if multiple manual accounts) */}
          {accounts.length > 1 && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Account</label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.displayName ?? a.accountId}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Contact name */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Contact Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. HR - Tina"
              autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {/* Email */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Email (optional)</label>
            <input
              type="email"
              value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)}
              placeholder="tina@company.com"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {/* Subject */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Subject (optional)</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Leave Request"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {/* Group chat toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isGroup}
              onChange={(e) => setIsGroup(e.target.checked)}
              className="w-3.5 h-3.5 accent-indigo-500"
            />
            <span className="text-xs text-gray-400">Group conversation</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="text-xs px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !displayName.trim()}
            className="text-xs px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
