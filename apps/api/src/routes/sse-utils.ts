import { Response } from 'express';

/**
 * Set up an Express response for Server-Sent Events (SSE).
 * Disables all forms of buffering so events reach the client immediately.
 */
export function setupSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx proxy buffering
  res.flushHeaders();

  // Disable Nagle's algorithm so tiny SSE frames aren't coalesced at the TCP level
  res.socket?.setNoDelay(true);
}

/**
 * Write an SSE event and flush immediately.
 * Prevents Node.js / compression middleware / reverse proxies from buffering SSE data.
 */
export function sseWrite(res: Response, data: string): void {
  res.write(`data: ${data}\n\n`);
  // .flush() is added by the `compression` middleware — call it if available
  if (typeof (res as any).flush === 'function') {
    (res as any).flush();
  }
}
