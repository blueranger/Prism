import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { MODELS, TimelineEntry, FlowNode, FlowEdge, FlowGraph } from '@prism/shared';
import { getSessionMessages, getSessionHandoffs } from '../memory/conversation';
import { getSessionTasks } from '../memory/execution-log';
import {
  listSessions,
  getSession,
  ensureSession,
  updateSessionMeta,
  deleteSession,
  linkSession,
  unlinkSession,
  getSessionLinks,
} from '../memory/session';

const router = Router();

// ── Session CRUD ────────────────────────────────────────────────────

/**
 * GET /api/sessions
 * List all sessions ordered by most recently updated.
 */
router.get('/', (_req, res) => {
  const sessions = listSessions();
  res.json({ sessions });
});

/**
 * POST /api/sessions
 * Create a new session (optional title in body).
 */
router.post('/', (req, res) => {
  const id = uuid();
  ensureSession(id);
  if (req.body.title) {
    updateSessionMeta(id, { title: req.body.title });
  }
  const session = getSession(id);
  res.status(201).json({ session });
});

/**
 * PATCH /api/sessions/:id
 * Update session title.
 */
router.patch('/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (req.body.title !== undefined) {
    updateSessionMeta(req.params.id, { title: req.body.title });
  }
  const updated = getSession(req.params.id);
  res.json({ session: updated });
});

/**
 * DELETE /api/sessions/:id
 * Delete a session and all its data.
 */
router.delete('/:id', (req, res) => {
  deleteSession(req.params.id);
  res.json({ ok: true });
});

// ── Session Links ───────────────────────────────────────────────────

/**
 * GET /api/sessions/:id/links
 * Get linked sessions (enriched with session metadata).
 */
router.get('/:id/links', (req, res) => {
  const links = getSessionLinks(req.params.id);
  res.json({ links });
});

/**
 * POST /api/sessions/:id/links
 * Link a session: { linkedSessionId }
 */
router.post('/:id/links', (req, res) => {
  const { linkedSessionId } = req.body;
  if (!linkedSessionId) {
    res.status(400).json({ error: 'linkedSessionId is required' });
    return;
  }
  if (linkedSessionId === req.params.id) {
    res.status(400).json({ error: 'Cannot link a session to itself' });
    return;
  }
  const link = linkSession(req.params.id, linkedSessionId);
  res.status(201).json({ link });
});

/**
 * DELETE /api/sessions/:id/links/:linkedId
 * Unlink a session.
 */
router.delete('/:id/links/:linkedId', (req, res) => {
  unlinkSession(req.params.id, req.params.linkedId);
  res.json({ ok: true });
});

/**
 * GET /api/sessions/:id/timeline
 *
 * Returns the unified timeline for a session — all messages and handoff events
 * merged chronologically.
 */
router.get('/:id/timeline', (req, res) => {
  const sessionId = req.params.id;
  const messages = getSessionMessages(sessionId);
  const handoffs = getSessionHandoffs(sessionId);

  const entries: TimelineEntry[] = [];

  // Add messages
  for (const msg of messages) {
    entries.push({
      id: msg.id,
      type: 'message',
      role: msg.role,
      content: msg.content,
      sourceModel: msg.sourceModel,
      timestamp: msg.timestamp,
      handoffFrom: msg.handoffFrom,
    });
  }

  // Add handoff events as timeline markers
  for (const h of handoffs) {
    const fromDisplay = MODELS[h.fromModel]?.displayName ?? h.fromModel;
    const toDisplay = MODELS[h.toModel]?.displayName ?? h.toModel;
    entries.push({
      id: h.id,
      type: 'handoff',
      content: h.instruction
        ? `Handoff from ${fromDisplay} to ${toDisplay}: ${h.instruction}`
        : `Handoff from ${fromDisplay} to ${toDisplay}`,
      sourceModel: h.fromModel,
      timestamp: h.timestamp,
      handoffFrom: h.fromModel,
      handoffTo: h.toModel,
    });
  }

  // Sort chronologically
  entries.sort((a, b) => a.timestamp - b.timestamp);

  res.json({ sessionId, entries });
});

/**
 * GET /api/sessions/:id/messages
 *
 * Returns raw messages for a session, used by the frontend to restore
 * the UI state after a page refresh.
 */
router.get('/:id/messages', (req, res) => {
  const sessionId = req.params.id;
  const messages = getSessionMessages(sessionId);
  res.json({ sessionId, messages });
});

/**
 * GET /api/sessions/:id/flow
 *
 * Returns a FlowGraph (nodes + edges) for the Flow Visualizer.
 * Builds the graph from messages, handoffs, and agent tasks.
 *
 * Edge logic uses the `mode` field persisted on each message
 * (parallel, handoff, compare, synthesize) rather than heuristics.
 */
router.get('/:id/flow', (req, res) => {
  const sessionId = req.params.id;
  const messages = getSessionMessages(sessionId);
  const handoffs = getSessionHandoffs(sessionId);
  const agentTasks = getSessionTasks(sessionId);

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  // Track the previous user node for user→assistant edges
  let lastUserNodeId: string | null = null;

  // ── Build nodes ──────────────────────────────────────────────────

  for (const msg of messages) {
    const msgMode = (msg.mode ?? 'parallel') as FlowNode['mode'];

    if (msg.role === 'user') {
      nodes.push({
        id: msg.id,
        type: 'user',
        role: 'user',
        content: msg.content,
        sourceModel: 'user',
        timestamp: msg.timestamp,
        mode: msgMode,
      });
      lastUserNodeId = msg.id;
    } else if (msg.role === 'assistant') {
      nodes.push({
        id: msg.id,
        type: 'assistant',
        role: 'assistant',
        content: msg.content,
        sourceModel: msg.sourceModel,
        timestamp: msg.timestamp,
        mode: msgMode,
      });

      // Edge from last user prompt → assistant.
      // Synthesize nodes get their edges from source responses (built below),
      // so skip user→synth edges here.
      if (lastUserNodeId && msgMode !== 'synthesize') {
        edges.push({
          id: `e-${lastUserNodeId}-${msg.id}`,
          from: lastUserNodeId,
          to: msg.id,
          type: msgMode,
        });
      }
    }
  }

  // ── Handoff cross-model edges ────────────────────────────────────

  for (const h of handoffs) {
    // Find the last assistant message from fromModel before the handoff
    const fromMsg = [...messages]
      .reverse()
      .find(
        (m) =>
          m.role === 'assistant' &&
          m.sourceModel === h.fromModel &&
          m.timestamp <= h.timestamp
      );

    // Find the first assistant message from toModel tied to this handoff
    const toMsg = messages.find(
      (m) =>
        m.role === 'assistant' &&
        m.sourceModel === h.toModel &&
        m.handoffId === h.id
    );

    if (fromMsg && toMsg) {
      edges.push({
        id: `e-handoff-${h.id}`,
        from: fromMsg.id,
        to: toMsg.id,
        type: 'handoff',
        label: h.instruction ?? 'Handoff',
      });
    }
  }

  // ── Compare edges ────────────────────────────────────────────────
  // Compare mode: critic models evaluate the origin model's response.
  // Find the origin response (the latest non-compare assistant message
  // that immediately precedes the compare messages) and draw edges from
  // the origin to each critique.

  const compareMsgs = messages.filter(
    (m) => m.role === 'assistant' && m.mode === 'compare'
  );

  if (compareMsgs.length > 0) {
    // The origin is the latest assistant message BEFORE the first compare
    // message that is NOT itself a compare/synthesize message.
    const firstCompareTs = compareMsgs[0].timestamp;
    const originMsg = [...messages]
      .reverse()
      .find(
        (m) =>
          m.role === 'assistant' &&
          m.mode !== 'compare' &&
          m.mode !== 'synthesize' &&
          m.timestamp < firstCompareTs
      );

    for (const crit of compareMsgs) {
      // Edge from origin → critique
      if (originMsg) {
        edges.push({
          id: `e-compare-${originMsg.id}-${crit.id}`,
          from: originMsg.id,
          to: crit.id,
          type: 'compare',
          label: 'Critique',
        });
      }
    }
  }

  // ── Synthesize edges ─────────────────────────────────────────────
  // Synthesize mode: a synthesizer model merges responses from multiple
  // source models. Find the source responses (latest parallel/handoff
  // assistant messages from each distinct model before the synthesis)
  // and draw edges from each source to the synthesized message.

  const synthMsgs = messages.filter(
    (m) => m.role === 'assistant' && m.mode === 'synthesize'
  );

  for (const synthMsg of synthMsgs) {
    // Collect the latest response per model that preceded this synthesis.
    // Include compare-mode messages since the synthesizer often merges
    // the most recent outputs (which may be compare critiques).
    const sourcesByModel = new Map<string, typeof messages[0]>();
    for (const m of messages) {
      if (
        m.role === 'assistant' &&
        m.mode !== 'synthesize' &&
        m.timestamp < synthMsg.timestamp &&
        m.sourceModel !== synthMsg.sourceModel
      ) {
        sourcesByModel.set(m.sourceModel, m);
      }
    }

    for (const [, src] of sourcesByModel) {
      edges.push({
        id: `e-synth-${src.id}-${synthMsg.id}`,
        from: src.id,
        to: synthMsg.id,
        type: 'synthesize',
        label: 'Synthesize',
      });
    }
  }

  // ── Agent task nodes ─────────────────────────────────────────────

  for (const task of agentTasks) {
    if (task.status === 'completed' || task.status === 'failed') {
      nodes.push({
        id: task.id,
        type: 'agent',
        content: task.result?.output ?? `Agent: ${task.agentName}`,
        sourceModel: task.agentName,
        timestamp: task.createdAt,
        mode: 'agent',
      });

      // Connect to the nearest preceding user message
      const prevUser = [...messages]
        .reverse()
        .find((m) => m.role === 'user' && m.timestamp <= task.createdAt);
      if (prevUser) {
        edges.push({
          id: `e-agent-${task.id}`,
          from: prevUser.id,
          to: task.id,
          type: 'agent',
          label: task.agentName,
        });
      }
    }
  }

  // ── Finalize ─────────────────────────────────────────────────────

  // Sort nodes by timestamp
  nodes.sort((a, b) => a.timestamp - b.timestamp);

  // De-duplicate edges
  const seenEdges = new Set<string>();
  const uniqueEdges = edges.filter((e) => {
    const key = `${e.from}-${e.to}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });

  const graph: FlowGraph = { nodes, edges: uniqueEdges };
  res.json({ sessionId, graph });
});

export default router;
