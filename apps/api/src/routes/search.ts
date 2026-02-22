import { Router } from 'express';
import { searchService } from '../services/search-service';
import { SearchQuery } from '@prism/shared';

const router = Router();

// POST /api/search — Full-text search across all conversations
router.post('/', (req, res) => {
  try {
    const body = req.body as SearchQuery;
    if (!body.query || !body.query.trim()) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    const result = searchService.search(body);
    res.json(result);
  } catch (err: any) {
    console.error('[search] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/search?q=...&platform=...&source=... — Simple GET search
router.get('/', (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q || !q.trim()) {
      return res.status(400).json({ error: 'Search query (q) is required' });
    }

    const query: SearchQuery = {
      query: q,
      filters: {},
      limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
    };

    if (req.query.source) query.filters!.source = req.query.source as any;
    if (req.query.platform) query.filters!.platform = req.query.platform as any;
    if (req.query.dateFrom) query.filters!.dateFrom = req.query.dateFrom as string;
    if (req.query.dateTo) query.filters!.dateTo = req.query.dateTo as string;
    if (req.query.role) query.filters!.role = req.query.role as any;
    if (req.query.model) query.filters!.model = req.query.model as string;

    const result = searchService.search(query);
    res.json(result);
  } catch (err: any) {
    console.error('[search] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
