import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { MODELS, TimelineEntry, FlowNode, FlowEdge, FlowGraph, CreateActionRequest, ActionContextSnapshot, KBSessionBootstrapRequest, KBSessionBootstrapSource, ManualPreviewRequest } from '@prism/shared';
import { getSessionMessages, getSessionHandoffs, saveMessage } from '../memory/conversation';
import { getSessionTasks } from '../memory/execution-log';
import { getDb } from '../memory/db';
import { deleteRichPreviewArtifact, getRichPreviewArtifact, saveManualRichPreviewArtifact } from '../memory/preview-store';
import {
  listSessions,
  getSession,
  ensureSession,
  updateSessionMeta,
  deleteSession,
  linkSession,
  unlinkSession,
  getSessionLinks,
  createActionSession,
  createTopicSession,
  listChildActionSessions,
  saveSessionBootstrap,
  getSessionBootstrap,
  updateActionSession,
  updateObserverConfig,
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

router.get('/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ session });
});

router.get('/:id/bootstrap', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ bootstrap: getSessionBootstrap(req.params.id) });
});

/**
 * POST /api/sessions
 * Create a new session (optional title in body).
 */
router.post('/', (req, res) => {
  const activeModel = typeof req.body.activeModel === 'string' ? req.body.activeModel : null;
  const observerModels = Array.isArray(req.body.observerModels) ? req.body.observerModels.filter(Boolean) : [];
  const interactionMode = req.body.interactionMode === 'observer' ? 'observer' : null;
  const session = createTopicSession({
    title: req.body.title,
    interactionMode,
    activeModel,
    observerModels,
  });
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

router.patch('/:id/observer-config', (req, res) => {
  const session = updateObserverConfig(req.params.id, {
    interactionMode: req.body.interactionMode === 'observer' ? 'observer' : null,
    activeModel: req.body.activeModel ?? null,
    observerModels: Array.isArray(req.body.observerModels) ? req.body.observerModels : [],
  });
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ session });
});

/**
 * DELETE /api/sessions/:id
 * Delete a session and all its data.
 */
router.delete('/:id', (req, res) => {
  try {
    deleteSession(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    console.error('[sessions] delete error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/:id/actions', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (session.sessionType !== 'topic') {
    res.status(400).json({ error: 'Only topic sessions can list child actions' });
    return;
  }
  const actions = listChildActionSessions(req.params.id);
  res.json({ actions });
});

router.post('/:id/actions', (req, res) => {
  const parent = getSession(req.params.id);
  if (!parent) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (parent.sessionType !== 'topic') {
    res.status(400).json({ error: 'Actions can only be created from topic sessions' });
    return;
  }

  const body = req.body as CreateActionRequest;
  if (!body.actionType || !body.title?.trim()) {
    res.status(400).json({ error: 'actionType and title are required' });
    return;
  }

  const snapshot = buildActionContextSnapshot(parent.id, body);
  const actionSession = createActionSession(parent.id, snapshot, body);
  const contextPacket = buildActionContextPacket(actionSession, snapshot);
  saveMessage(actionSession.id, 'system', contextPacket, 'action', { mode: 'agent' });

  res.status(201).json({ session: actionSession });
});

router.post('/bootstrap-from-kb', (req, res) => {
  const body = req.body as KBSessionBootstrapRequest;
  if (body.origin !== 'kb' && body.origin !== 'library') {
    res.status(400).json({ error: 'origin must be "kb" or "library"' });
    return;
  }

  try {
    const normalizedPayload = body.origin === 'kb'
      ? normalizeKbBootstrapRequest(body)
      : normalizeLibraryBootstrapRequest(body);

    if ((normalizedPayload.selectedSources?.length ?? 0) === 0) {
      res.status(400).json({ error: 'At least one source is required to start a session' });
      return;
    }

    const suggestedTitle = normalizedPayload.suggestedTitle?.trim()
      || buildBootstrapTitle(normalizedPayload.query, normalizedPayload.answer, normalizedPayload.selectedSources);
    const preview = buildBootstrapPreview(normalizedPayload.answer, normalizedPayload.selectedSources);
    const session = createTopicSession({
      title: suggestedTitle,
      preview,
      interactionMode: 'observer',
      activeModel: normalizedPayload.activeModel ?? null,
      observerModels: normalizedPayload.observerModels ?? [],
    });

    const packet = buildKBContextPacket(normalizedPayload);
    saveSessionBootstrap(session.id, normalizedPayload.origin, normalizedPayload);
    saveMessage(session.id, 'system', packet, 'kb-bootstrap', { mode: 'parallel' });
    updateSessionMeta(session.id, { title: suggestedTitle, preview });

    res.status(201).json({
      sessionId: session.id,
      sessionTitle: suggestedTitle,
    });
  } catch (error) {
    console.error('[sessions] bootstrap-from-kb error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.patch('/:id/action', (req, res) => {
  const action = updateActionSession(req.params.id, req.body ?? {});
  if (!action) {
    res.status(404).json({ error: 'Action session not found' });
    return;
  }
  res.json({ session: action });
});

router.post('/:id/action/writeback', (req, res) => {
  const action = getSession(req.params.id);
  if (!action || action.sessionType !== 'action' || !action.parentSessionId) {
    res.status(404).json({ error: 'Action session not found' });
    return;
  }

  const summary = String(req.body.summary ?? '').trim();
  if (!summary) {
    res.status(400).json({ error: 'summary is required' });
    return;
  }

  const prefix = `[Action Result] ${action.actionTitle ?? action.title ?? 'Action'} completed.\nSummary: ${summary}`;
  const message = saveMessage(action.parentSessionId, 'assistant', prefix, 'action', { mode: 'agent' });
  const updated = updateActionSession(action.id, {
    actionStatus: 'completed',
    resultSummary: summary,
  });

  res.json({ ok: true, message, session: updated });
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
    if (msg.role === 'system') continue;
    entries.push({
      id: msg.id,
      type: 'message',
      role: msg.role,
      content: msg.content,
      sourceModel: msg.sourceModel,
      timestamp: msg.timestamp,
      mode: msg.mode ?? null,
      handoffFrom: msg.handoffFrom,
      promptTokens: msg.promptTokens ?? null,
      completionTokens: msg.completionTokens ?? null,
      reasoningTokens: msg.reasoningTokens ?? null,
      cachedTokens: msg.cachedTokens ?? null,
      estimatedCostUsd: msg.estimatedCostUsd ?? null,
      pricingSource: msg.pricingSource ?? null,
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

router.get('/:id/messages/:messageId/preview-artifact', (req, res) => {
  const sessionId = req.params.id;
  const messageId = req.params.messageId;
  const message = getSessionMessages(sessionId).find((msg) => msg.id === messageId);
  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  res.json({ artifact: getRichPreviewArtifact(messageId) });
});

router.post('/:id/messages/:messageId/preview-artifact', (req, res) => {
  const sessionId = req.params.id;
  const messageId = req.params.messageId;
  const message = getSessionMessages(sessionId).find((msg) => msg.id === messageId);
  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  const body = req.body as ManualPreviewRequest;
  const selectedText = String(body.selectedText ?? '').trim();
  if (!selectedText) {
    res.status(400).json({ error: 'selectedText is required' });
    return;
  }
  if (body.previewKind !== 'html' && body.previewKind !== 'svg') {
    res.status(400).json({ error: 'previewKind must be html or svg' });
    return;
  }

  const artifact = saveManualRichPreviewArtifact(sessionId, messageId, body);
  res.status(201).json({ artifact });
});

router.delete('/:id/messages/:messageId/preview-artifact', (req, res) => {
  const sessionId = req.params.id;
  const messageId = req.params.messageId;
  const message = getSessionMessages(sessionId).find((msg) => msg.id === messageId);
  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  deleteRichPreviewArtifact(messageId);
  res.json({ ok: true });
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
  const session = getSession(sessionId);
  const childActions = session?.sessionType === 'topic' ? listChildActionSessions(sessionId) : [];

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  // Track the previous user node for user→assistant edges
  let lastUserNodeId: string | null = null;

  // ── Build nodes ──────────────────────────────────────────────────

  for (const msg of messages) {
    if (msg.role === 'system') continue;
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

  // ── Action session nodes / edges ────────────────────────────────

  if (session?.sessionType === 'topic') {
    for (const action of childActions) {
      const snapshot = action.contextSnapshot;
      const selectedMessageId = snapshot?.selectedMessageIds?.[0] ?? null;
      const anchorNodeId = selectedMessageId && nodes.some((n) => n.id === selectedMessageId)
        ? selectedMessageId
        : lastUserNodeId ?? nodes.find((n) => n.type === 'user' || n.type === 'assistant')?.id ?? null;

      nodes.push({
        id: action.id,
        type: 'action',
        content: action.actionTitle ?? action.title ?? 'Action',
        sourceModel: 'action',
        timestamp: action.createdAt,
        mode: 'action_spawn',
        sessionType: action.sessionType,
        actionType: action.actionType,
        actionStatus: action.actionStatus,
        parentSessionId: action.parentSessionId ?? null,
        sessionId: action.id,
        targetLabel: action.actionTarget ?? null,
        resultSummary: action.resultSummary ?? null,
      });

      if (anchorNodeId) {
        edges.push({
          id: `e-action-spawn-${action.id}`,
          from: anchorNodeId,
          to: action.id,
          type: 'action_spawn',
          label: 'Spawn Action',
        });
      }

      if (action.resultSummary) {
        const writebackMessage = [...messages]
          .filter((m) => m.role === 'assistant' && m.sourceModel === 'action' && m.content.includes(action.resultSummary!))
          .sort((a, b) => b.timestamp - a.timestamp)[0];

        if (writebackMessage) {
          if (!nodes.some((n) => n.id === writebackMessage.id)) {
            nodes.push({
              id: writebackMessage.id,
              type: 'assistant',
              role: 'assistant',
              content: writebackMessage.content,
              sourceModel: 'action',
              timestamp: writebackMessage.timestamp,
              mode: 'action_writeback',
              sessionType: 'topic',
              parentSessionId: action.id,
              sessionId,
              resultSummary: action.resultSummary,
            });
          }
          edges.push({
            id: `e-action-writeback-${action.id}-${writebackMessage.id}`,
            from: action.id,
            to: writebackMessage.id,
            type: 'action_writeback',
            label: 'Write Back',
          });
        }
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

function normalizeKbBootstrapRequest(body: KBSessionBootstrapRequest): KBSessionBootstrapRequest {
  return {
    origin: 'kb',
    query: String(body.query ?? '').trim(),
    answer: String(body.answer ?? '').trim(),
    suggestedTitle: typeof body.suggestedTitle === 'string' ? body.suggestedTitle.trim() : undefined,
    citations: body.citations ?? {},
    selectedSources: normalizeSelectedSources(body.selectedSources ?? []),
    activeModel: typeof body.activeModel === 'string' ? body.activeModel : null,
    observerModels: Array.isArray(body.observerModels) ? body.observerModels.filter(Boolean) : [],
  };
}

function normalizeLibraryBootstrapRequest(body: KBSessionBootstrapRequest): KBSessionBootstrapRequest {
  const ids = Array.isArray(body.libraryConversationIds) ? body.libraryConversationIds.filter(Boolean) : [];
  const sources = buildLibraryBootstrapSources(ids);
  const answer = buildLibraryBootstrapSummary(sources);
  return {
    origin: 'library',
    query: body.query?.trim() || 'Continue discussion from selected Library conversations',
    answer,
    suggestedTitle: typeof body.suggestedTitle === 'string' ? body.suggestedTitle.trim() : undefined,
    citations: {},
    selectedSources: sources,
    libraryConversationIds: ids,
    activeModel: typeof body.activeModel === 'string' ? body.activeModel : null,
    observerModels: Array.isArray(body.observerModels) ? body.observerModels.filter(Boolean) : [],
  };
}

function normalizeSelectedSources(input: KBSessionBootstrapSource[]): KBSessionBootstrapSource[] {
  return input
    .filter((source) => source && typeof source.sourceId === 'string' && source.sourceId.trim())
    .map((source) => ({
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sessionId: source.sessionId ?? null,
      conversationId: source.conversationId ?? null,
      sourceLabel: String(source.sourceLabel ?? source.sourceId).trim(),
      sourcePlatform: source.sourcePlatform ?? null,
      excerpt: typeof source.excerpt === 'string' ? source.excerpt.trim() : null,
      sourceCreatedAt: source.sourceCreatedAt ?? null,
      sourceLastActivityAt: source.sourceLastActivityAt ?? null,
      citedAt: source.citedAt ?? null,
    }));
}

function buildLibraryBootstrapSources(conversationIds: string[]): KBSessionBootstrapSource[] {
  const db = getDb();
  return conversationIds.map((conversationId) => {
    const conv = db.prepare(`
      SELECT
        ic.id,
        ic.title,
        ic.source_platform,
        ic.created_at,
        COALESCE(MAX(im.timestamp), ic.updated_at, ic.created_at) AS last_activity_at
      FROM imported_conversations ic
      LEFT JOIN imported_messages im ON im.conversation_id = ic.id
      WHERE ic.id = ?
      GROUP BY ic.id
    `).get(conversationId) as {
      id: string;
      title: string;
      source_platform: string;
      created_at: string;
      last_activity_at: string | null;
    } | undefined;

    if (!conv) return null;

    const excerpts = db.prepare(`
      SELECT role, content, timestamp
      FROM imported_messages
      WHERE conversation_id = ?
      ORDER BY timestamp ASC
      LIMIT 4
    `).all(conversationId) as Array<{ role: string; content: string; timestamp: string }>;

    const excerpt = excerpts
      .map((msg) => `[${msg.role}] ${msg.content.replace(/\s+/g, ' ').trim()}`)
      .join('\n')
      .slice(0, 1200);

    return {
      sourceType: 'imported_conversation',
      sourceId: conv.id,
      conversationId: conv.id,
      sourceLabel: `[${capitalize(conv.source_platform)}] ${conv.title}`,
      sourcePlatform: conv.source_platform,
      excerpt,
      sourceCreatedAt: conv.created_at,
      sourceLastActivityAt: conv.last_activity_at ?? conv.created_at,
      citedAt: excerpts[excerpts.length - 1]?.timestamp ?? conv.last_activity_at ?? conv.created_at,
    } satisfies KBSessionBootstrapSource;
  }).filter(Boolean) as KBSessionBootstrapSource[];
}

function buildLibraryBootstrapSummary(sources: KBSessionBootstrapSource[]): string {
  if (sources.length === 0) return 'No Library source content was available.';
  return [
    'The following compact summary was assembled from selected Library conversations.',
    '',
    ...sources.map((source, index) => [
      `${index + 1}. ${source.sourceLabel}`,
      source.excerpt || 'No excerpt available.',
    ].join('\n')),
  ].join('\n\n');
}

function buildBootstrapTitle(query?: string, answer?: string, sources?: KBSessionBootstrapSource[]): string {
  const clean = (value?: string) => (value || '').replace(/\s+/g, ' ').trim();
  const fromQuery = clean(query);
  if (fromQuery) {
    return fromQuery.slice(0, 80);
  }
  const fromAnswer = clean(answer);
  if (fromAnswer) {
    return fromAnswer.slice(0, 80);
  }
  if (sources?.[0]?.sourceLabel) {
    return `Follow-up: ${sources[0].sourceLabel}`.slice(0, 80);
  }
  return 'KB Follow-up Session';
}

function buildBootstrapPreview(answer?: string, sources?: KBSessionBootstrapSource[]): string {
  const excerpt = (answer || sources?.[0]?.excerpt || '').replace(/\s+/g, ' ').trim();
  return excerpt.slice(0, 100);
}

function buildKBContextPacket(payload: KBSessionBootstrapRequest): string {
  const lines = [
    'This session was bootstrapped from existing Prism knowledge so the discussion can continue from prior context.',
  ];

  if (payload.query) {
    lines.push('', `Original question:\n${payload.query}`);
  }

  if (payload.answer) {
    lines.push('', `KB answer summary:\n${payload.answer}`);
  }

  lines.push('', 'Working context:');
  lines.push('Use the summary and cited source excerpts below as the starting point for the next round of discussion.');

  if (payload.selectedSources?.length) {
    lines.push('', 'Selected cited sources:');
    payload.selectedSources.forEach((source, index) => {
      const timeBits = [
        source.citedAt ? `cited ${formatBootstrapTime(source.citedAt)}` : null,
        source.sourceLastActivityAt ? `last discussed ${formatBootstrapTime(source.sourceLastActivityAt)}` : null,
      ].filter(Boolean).join(' · ');

      lines.push(`${index + 1}. ${source.sourceLabel}${timeBits ? ` (${timeBits})` : ''}`);
      if (source.excerpt) {
        lines.push(source.excerpt);
      }
      lines.push(
        `Reference: type=${source.sourceType}; sourceId=${source.sourceId}` +
          `${source.sessionId ? `; sessionId=${source.sessionId}` : ''}` +
          `${source.conversationId ? `; conversationId=${source.conversationId}` : ''}`
      );
      lines.push('');
    });
  }

  lines.push('Suggested next step: continue the discussion from these conclusions, refine the scope, and identify open questions or decisions.');
  return lines.join('\n');
}

function formatBootstrapTime(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function buildActionContextSnapshot(sessionId: string, input: CreateActionRequest): ActionContextSnapshot {
  const allMessages = getSessionMessages(sessionId).filter((m) => m.role !== 'system');
  const selected = input.selectedMessageIds?.length
    ? allMessages.filter((m) => input.selectedMessageIds!.includes(m.id))
    : allMessages.slice(-6);
  const sourceTemplate = input.sourceTemplate?.trim() || null;

  const lines = selected.slice(0, 8).map((msg) => {
    const speaker = msg.role === 'user'
      ? 'User'
      : MODELS[msg.sourceModel]?.displayName ?? msg.sourceModel;
    return `- ${speaker}: ${msg.content.replace(/\s+/g, ' ').slice(0, 220)}`;
  });

  const topicSummary = lines.length > 0
    ? lines.join('\n')
    : (input.instruction?.trim() || 'No source discussion summary available.');

  const sourceSummary = sourceTemplate
    ? [
        `Reply source ${input.actionType === 'message' ? 'message' : 'email'}:`,
        sourceTemplate.replace(/\s+\n/g, '\n').trim(),
        topicSummary ? `\nRelated topic context:\n${topicSummary}` : '',
      ].filter(Boolean).join('\n\n')
    : topicSummary;

  return {
    sourceSessionId: sessionId,
    sourceSessionTitle: getSession(sessionId)?.title ?? null,
    sourceSummary,
    sourceTemplate,
    selectedMessageIds: selected.map((msg) => msg.id),
    selectedFileIds: input.selectedFileIds ?? [],
    selectedArtifacts: input.selectedArtifacts ?? [],
    actionScenario: input.actionScenario ?? 'new',
    userInstruction: input.instruction ?? null,
    targetLabel: input.target ?? null,
    channelHint: input.channelHint,
    outputExpectation: input.outputExpectation ?? null,
    createdAt: Date.now(),
  };
}

function buildActionContextPacket(session: NonNullable<ReturnType<typeof getSession>>, snapshot: ActionContextSnapshot): string {
  const lines = [
    'You are working in an action thread derived from a broader topic discussion.',
    '',
    `Action type: ${session.actionType ?? 'custom'}`,
    `Action scenario: ${snapshot.actionScenario ?? 'new'}`,
    `Action title: ${session.actionTitle ?? session.title ?? 'Untitled action'}`,
  ];

  if (session.actionTarget ?? snapshot.targetLabel) {
    lines.push(`Target: ${session.actionTarget ?? snapshot.targetLabel}`);
  }

  lines.push('', 'Topic summary:', snapshot.sourceSummary);

  if (snapshot.userInstruction) {
    lines.push('', `Instruction: ${snapshot.userInstruction}`);
  }

  if (snapshot.outputExpectation) {
    lines.push('', `Output expectation: ${snapshot.outputExpectation}`);
  }

  return lines.join('\n');
}
