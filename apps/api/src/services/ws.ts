import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { CommNotification } from '@prism/shared';

/**
 * WebSocket service for real-time push to the frontend.
 *
 * Events pushed to clients:
 * - { type: 'comm:notification', notification: CommNotification }
 * - { type: 'comm:newMessages', accountId: string, threadCount: number }
 * - { type: 'comm:syncError', accountId: string, error: string }
 */

let wss: WebSocketServer | null = null;

/**
 * Initialize the WebSocket server, upgrading on the same HTTP server.
 * Call once at startup after app.listen().
 */
export function initWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('[ws] Client connected');

    ws.on('close', () => {
      console.log('[ws] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[ws] Socket error:', err.message);
    });

    // Send a welcome handshake
    safeSend(ws, { type: 'connected', timestamp: Date.now() });
  });

  console.log('[ws] WebSocket server ready on /ws');
}

/**
 * Broadcast a message to all connected clients.
 */
export function broadcast(data: Record<string, unknown>): void {
  if (!wss) return;

  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

/**
 * Broadcast a CommNotification to all connected clients.
 */
export function broadcastNotification(notification: CommNotification): void {
  broadcast({ type: 'comm:notification', notification });
}

/**
 * Broadcast a new-messages event after a sync.
 */
export function broadcastNewMessages(accountId: string, threadCount: number): void {
  broadcast({ type: 'comm:newMessages', accountId, threadCount });
}

/**
 * Broadcast a sync error.
 */
export function broadcastSyncError(accountId: string, error: string): void {
  broadcast({ type: 'comm:syncError', accountId, error });
}

/**
 * Get the count of connected clients.
 */
export function getClientCount(): number {
  if (!wss) return 0;
  let count = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) count++;
  }
  return count;
}

function safeSend(ws: WebSocket, data: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // Ignore send errors on closing sockets
  }
}
