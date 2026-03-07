import { Router } from 'express';
import { createHash } from 'crypto';
import {
  createProvenance,
  getProvenanceByCode,
  getProvenanceByHash,
  getProvenanceById,
  listProvenance,
  updateProvenanceNote,
  deleteProvenance,
  type CreateProvenanceInput,
  type ProvenanceListFilters,
} from '../memory/provenance-store';

const router = Router();

/**
 * Helper: Compute SHA256 hash of content.
 */
function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * POST /api/provenance
 * Create a new provenance record.
 *
 * Body:
 * {
 *   sourceType: 'native' | 'imported',
 *   sessionId?: string,
 *   conversationId?: string,
 *   messageId: string,
 *   artifactId?: string,
 *   content: string,
 *   contentHash?: string,
 *   sourceModel: string,
 *   entities?: string[],
 *   tags?: string[]
 * }
 */
router.post('/', (req, res) => {
  try {
    const {
      sourceType,
      sessionId,
      conversationId,
      messageId,
      artifactId,
      content,
      contentHash,
      sourceModel,
      entities,
      tags,
    } = req.body;

    if (!sourceType || !messageId || !content || !sourceModel) {
      return res.status(400).json({
        error: 'Missing required fields: sourceType, messageId, content, sourceModel',
      });
    }

    if (sourceType !== 'native' && sourceType !== 'imported') {
      return res.status(400).json({
        error: 'sourceType must be "native" or "imported"',
      });
    }

    const computedHash = contentHash || hashContent(content);

    const input: CreateProvenanceInput = {
      sourceType,
      sessionId: sessionId || null,
      conversationId: conversationId || null,
      messageId,
      artifactId: artifactId || null,
      content,
      contentHash: computedHash,
      sourceModel,
      entities: entities || null,
      tags: tags || null,
    };

    const record = createProvenance(input);
    res.status(201).json(record);
  } catch (err: any) {
    console.error('[provenance] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/provenance
 * List provenance records with optional filters.
 *
 * Query params:
 * - sourceModel?: string
 * - sourceType?: 'native' | 'imported'
 * - sessionId?: string
 * - conversationId?: string
 * - limit?: number (default 50)
 * - offset?: number (default 0)
 */
router.get('/', (req, res) => {
  try {
    const filters: ProvenanceListFilters = {
      sourceModel: req.query.sourceModel as string | undefined,
      sourceType: req.query.sourceType as 'native' | 'imported' | undefined,
      sessionId: req.query.sessionId as string | undefined,
      conversationId: req.query.conversationId as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
    };

    const result = listProvenance(filters);
    res.json(result);
  } catch (err: any) {
    console.error('[provenance] GET list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/provenance/search/by-hash
 * Search for provenance records by content hash.
 *
 * Query params:
 * - hash: string (required)
 *
 * IMPORTANT: This must be defined BEFORE /:id to avoid Express treating "search" as an id.
 */
router.get('/search/by-hash', (req, res) => {
  try {
    const { hash } = req.query;

    if (!hash) {
      return res.status(400).json({ error: 'Missing required query param: hash' });
    }

    const records = getProvenanceByHash(hash as string);
    res.json({ records, total: records.length });
  } catch (err: any) {
    console.error('[provenance] GET by-hash error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/provenance/:id
 * Get a provenance record by ID or short code.
 *
 * If id starts with 'PRZ-', treats it as a short code.
 * Otherwise treats it as a UUID.
 */
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;

    let record;
    if (id.startsWith('PRZ-')) {
      record = getProvenanceByCode(id);
    } else {
      record = getProvenanceById(id);
    }

    if (!record) {
      return res.status(404).json({ error: 'Provenance record not found' });
    }

    res.json(record);
  } catch (err: any) {
    console.error('[provenance] GET by id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/provenance/:id
 * Update a provenance record (currently only note).
 *
 * Body:
 * {
 *   note?: string | null
 * }
 */
router.patch('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    // Verify record exists
    const record = getProvenanceById(id);
    if (!record) {
      return res.status(404).json({ error: 'Provenance record not found' });
    }

    updateProvenanceNote(id, note || null);

    // Return updated record
    const updated = getProvenanceById(id);
    res.json(updated);
  } catch (err: any) {
    console.error('[provenance] PATCH error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/provenance/:id
 * Delete a provenance record.
 */
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;

    // Verify record exists
    const record = getProvenanceById(id);
    if (!record) {
      return res.status(404).json({ error: 'Provenance record not found' });
    }

    deleteProvenance(id);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[provenance] DELETE error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
