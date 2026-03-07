'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { fetchConnectors, fetchCommThreads } from '@/lib/api';
import ThreadList from './ThreadList';
import ThreadDetail from './ThreadDetail';
import ConnectorSetup from './ConnectorSetup';
import ReplyLearningPanel from './ReplyLearningPanel';
import MonitorRuleBuilder from './MonitorRuleBuilder';

export default function CommunicationView() {
  const setConnectors = useChatStore((s) => s.setCommConnectors);
  const setThreads = useChatStore((s) => s.setCommThreads);
  const setRuleBuilderOpen = useChatStore((s) => s.setCommRuleBuilderOpen);
  const [learningOpen, setLearningOpen] = useState(false);

  // Load connectors first, then threads (connectors are needed for grouping)
  useEffect(() => {
    async function load() {
      try {
        const c = await fetchConnectors();
        console.log('[CommunicationView] connectors loaded:', c.length);
        useChatStore.getState().setCommConnectors(c);
      } catch (err) {
        console.error('[CommunicationView] connectors error:', err);
      }
      try {
        const t = await fetchCommThreads();
        console.log('[CommunicationView] threads loaded:', t.length);
        useChatStore.getState().setCommThreads(t);
      } catch (err) {
        console.error('[CommunicationView] threads error:', err);
      }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="flex-1 flex gap-4 min-h-0">
        {/* Left panel: thread list */}
        <div className="w-72 shrink-0 flex flex-col border-r border-gray-800 pr-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Threads
            </h2>
            <div className="flex gap-2">
              <button
                onClick={() => setRuleBuilderOpen(true)}
                className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
              >
                Rules
              </button>
              <button
                onClick={() => setLearningOpen(true)}
                className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
              >
                Learning
              </button>
            </div>
          </div>
          <ThreadList />
        </div>

        {/* Right panel: thread detail */}
        <div className="flex-1 flex flex-col min-h-0">
          <ThreadDetail />
        </div>
      </div>

      <ConnectorSetup />
      <MonitorRuleBuilder />
      {learningOpen && <ReplyLearningPanel onClose={() => setLearningOpen(false)} />}
    </>
  );
}
