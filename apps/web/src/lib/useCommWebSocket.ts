'use client';

import { useEffect, useRef } from 'react';
import { useChatStore } from '@/stores/chat-store';
import type { CommNotification, CommNotificationTriageComplete } from '@prism/shared';
import { fetchCommThreads, fetchCommThreadMessages } from './api';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001/ws';

/** Reconnect delays: 1s, 2s, 4s, 8s, 16s, 30s (max) */
const MAX_RECONNECT_DELAY = 30_000;

/** Debounce delay for thread refresh (ms) */
const REFRESH_DEBOUNCE_MS = 800;

/**
 * Hook that connects to the backend WebSocket and dispatches
 * real-time communication events to the Zustand store.
 *
 * Events handled:
 * - comm:notification — rule match notification (increment badge, store notification)
 * - comm:newMessages — new messages synced (refresh thread list)
 * - comm:triageComplete — triage finished (refresh thread list + notification)
 * - comm:syncError — sync error (could show a toast later)
 */
export function useCommWebSocket(): void {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(1000);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    // Debounced thread refresh — collapses rapid WebSocket events into a single fetch
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshInFlight = false;

    function scheduleThreadRefresh() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (refreshInFlight) return;
        refreshInFlight = true;
        fetchCommThreads()
          .then((threads) => {
            useChatStore.getState().setCommThreads(threads);
          })
          .finally(() => {
            refreshInFlight = false;
          });
      }, REFRESH_DEBOUNCE_MS);
    }

    function connect() {
      if (!mountedRef.current) return;

      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log('[ws] Connected');
          reconnectDelay.current = 1000; // Reset backoff on success
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            handleMessage(data);
          } catch {
            // Ignore malformed messages
          }
        };

        ws.onclose = () => {
          console.log('[ws] Disconnected');
          wsRef.current = null;
          scheduleReconnect();
        };

        ws.onerror = () => {
          // onclose will fire after onerror, so we handle reconnect there
          ws.close();
        };
      } catch {
        scheduleReconnect();
      }
    }

    function scheduleReconnect() {
      if (!mountedRef.current) return;

      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 2, MAX_RECONNECT_DELAY);

      reconnectTimer.current = setTimeout(connect, delay);
    }

    function handleMessage(data: Record<string, unknown>) {
      const store = useChatStore.getState();

      switch (data.type) {
        case 'comm:notification': {
          const notification = data.notification as CommNotification;
          store.addCommNotification(notification);
          break;
        }

        case 'comm:newMessages': {
          // Debounced refresh — multiple accounts may sync in quick succession
          scheduleThreadRefresh();
          break;
        }

        case 'comm:triageComplete': {
          // Debounced refresh — triage may fire right after newMessages
          scheduleThreadRefresh();

          // Add a triage_complete notification to the store
          const triageNotification: CommNotificationTriageComplete = {
            type: 'triage_complete',
            accountId: data.accountId as string,
            totalTriaged: data.totalTriaged as number,
            draftsGenerated: data.draftsGenerated as number,
            timestamp: Date.now(),
          };
          store.addCommNotification(triageNotification);
          break;
        }

        case 'comm:contentLoaded': {
          // Content was lazy-loaded in background — refresh messages for that thread
          const threadId = data.threadId as string;
          const selectedThreadId = useChatStore.getState().commSelectedThreadId;
          if (threadId && threadId === selectedThreadId) {
            console.log(`[ws] Content loaded for current thread ${threadId}, refreshing messages`);
            fetchCommThreadMessages(threadId).then(({ messages: msgs, contentLoading: stillLoading }) => {
              useChatStore.getState().setCommThreadMessages(msgs);
              useChatStore.getState().setCommContentLoading(stillLoading);
            });
          }
          break;
        }

        case 'comm:queueStatus': {
          useChatStore.getState().setCommQueueStatus(
            (data.currentTask as string) ?? null,
            (data.pendingCount as number) ?? 0,
          );
          break;
        }

        case 'comm:syncError': {
          console.warn(`[ws] Sync error for ${data.provider}: ${data.error}`);
          break;
        }

        // 'connected' welcome message — no action needed
        default:
          break;
      }
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);
}
