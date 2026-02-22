import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import { importService } from '../services/import-service';
import {
  listImportedConversations,
  getImportedMessages,
  getImportStats,
  deleteImportBatch,
} from '../memory/import-store';
import { ImportPlatform } from '@prism/shared';

const router = Router();

// Multer config: store uploads in temp dir
const upload = multer({
  dest: path.join(os.tmpdir(), 'prism-uploads'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (_req, file, cb) => {
    const allowed = ['.json', '.zip'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${ext}`));
  },
});

// POST /api/import/upload — Upload and import a conversation archive
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const platform = req.body.platform as ImportPlatform;
    if (!platform || !['chatgpt', 'claude', 'gemini'].includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform. Must be: chatgpt, claude, or gemini' });
    }

    const result = await importService.importFile(req.file.path, platform);
    res.json(result);
  } catch (err: any) {
    console.error('[import] Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/import/conversations — List imported conversations
router.get('/conversations', (req, res) => {
  const { platform, limit, offset, search } = req.query;
  const result = listImportedConversations({
    platform: platform as ImportPlatform | undefined,
    limit: limit ? parseInt(limit as string) : undefined,
    offset: offset ? parseInt(offset as string) : undefined,
    search: search as string | undefined,
  });
  res.json(result);
});

// GET /api/import/conversations/:id/messages — Get messages for a conversation
router.get('/conversations/:id/messages', (req, res) => {
  const messages = getImportedMessages(req.params.id);
  res.json(messages);
});

// GET /api/import/stats — Get import statistics
router.get('/stats', (_req, res) => {
  const stats = getImportStats();
  res.json(stats);
});

// DELETE /api/import/batch/:batchId — Delete an import batch
router.delete('/batch/:batchId', (req, res) => {
  const deleted = deleteImportBatch(req.params.batchId);
  res.json({ deleted });
});

export default router;
