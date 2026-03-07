'use client';

import { useEffect, useState } from 'react';
import type { SenderLearningStats } from '@prism/shared';
import { fetchLearningSenders, clearSenderLearning as clearSenderLearningApi } from '@/lib/api';

const TONE_COLORS: Record<string, string> = {
  formal: 'bg-blue-600/20 text-blue-400',
  casual: 'bg-green-600/20 text-green-400',
  friendly: 'bg-yellow-600/20 text-yellow-400',
  technical: 'bg-purple-600/20 text-purple-400',
  neutral: 'bg-gray-600/20 text-gray-400',
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

interface ReplyLearningPanelProps {
  onClose: () => void;
}

export default function ReplyLearningPanel({ onClose }: ReplyLearningPanelProps) {
  const [senders, setSenders] = useState<SenderLearningStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchLearningSenders().then((data) => {
      setSenders(data);
      setLoading(false);
    });
  }, []);

  const handleClear = async (senderId: string, provider: string) => {
    const ok = await clearSenderLearningApi(senderId, provider);
    if (ok) {
      setSenders((prev) => prev.filter((s) => !(s.senderId === senderId && s.provider === provider)));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-sm font-semibold text-gray-200">Reply Learning</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Patterns learned from your past replies, used to personalize AI drafts
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors text-lg"
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && (
            <p className="text-sm text-gray-500 text-center py-8">Loading...</p>
          )}

          {!loading && senders.length === 0 && (
            <div className="text-center py-8">
              <p className="text-sm text-gray-500 mb-2">No learning data yet.</p>
              <p className="text-xs text-gray-600">
                Approve or send replies through Prism to start building style patterns.
              </p>
            </div>
          )}

          {!loading && senders.length > 0 && (
            <div className="space-y-2">
              {senders.map((sender) => {
                const key = `${sender.provider}:${sender.senderId}`;
                const isExpanded = expandedId === key;
                const toneClass = sender.dominantTone
                  ? TONE_COLORS[sender.dominantTone] ?? TONE_COLORS.neutral
                  : TONE_COLORS.neutral;

                return (
                  <div
                    key={key}
                    className="border border-gray-800 rounded-lg overflow-hidden"
                  >
                    {/* Sender row */}
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : key)}
                      className="w-full text-left px-4 py-3 hover:bg-gray-800/50 transition-colors flex items-center gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-200 truncate">
                            {sender.senderName}
                          </span>
                          <span className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded capitalize">
                            {sender.provider}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {sender.replyCount} {sender.replyCount === 1 ? 'reply' : 'replies'} learned
                        </p>
                      </div>

                      {sender.dominantTone && (
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded capitalize ${toneClass}`}>
                          {sender.dominantTone}
                        </span>
                      )}

                      <span className="text-gray-600 text-xs">
                        {isExpanded ? '\u25B2' : '\u25BC'}
                      </span>
                    </button>

                    {/* Expanded details */}
                    {isExpanded && (
                      <div className="px-4 pb-4 pt-1 border-t border-gray-800 space-y-3">
                        {/* Stats grid */}
                        <div className="grid grid-cols-2 gap-3">
                          <StatCard label="Avg. Length" value={`${sender.avgLength} chars`} />
                          <StatCard label="Dominant Tone" value={sender.dominantTone ?? 'Unknown'} />
                          <StatCard label="Question Rate" value={pct(sender.questionRate)} />
                          <StatCard label="Action Item Rate" value={pct(sender.actionItemRate)} />
                          <StatCard label="Draft Edit Rate" value={pct(sender.editRate)} />
                          <StatCard label="Last Reply" value={formatDate(sender.lastReplyAt)} />
                        </div>

                        {/* Tone breakdown */}
                        {Object.keys(sender.toneBreakdown).length > 0 && (
                          <div>
                            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">
                              Tone Breakdown
                            </p>
                            <div className="flex gap-1.5 flex-wrap">
                              {Object.entries(sender.toneBreakdown).map(([tone, count]) => (
                                <span
                                  key={tone}
                                  className={`text-[10px] px-2 py-0.5 rounded capitalize ${TONE_COLORS[tone] ?? TONE_COLORS.neutral}`}
                                >
                                  {tone}: {count}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Clear button */}
                        <div className="pt-2 border-t border-gray-800">
                          <button
                            onClick={() => handleClear(sender.senderId, sender.provider)}
                            className="text-xs text-red-400 hover:text-red-300 transition-colors"
                          >
                            Clear learning data for this sender
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800/50 rounded-lg px-3 py-2">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="text-sm text-gray-200 mt-0.5 capitalize">{value}</p>
    </div>
  );
}
