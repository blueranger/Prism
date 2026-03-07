import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { getDb } from '../memory/db';
import { fileSkillRegistry } from '../skills';
import type { UploadedFile } from '@prism/shared';

const router = Router();

// Multer config: store uploads in temp dir with preserved extension
const storage = multer.diskStorage({
  destination: path.join(os.tmpdir(), 'prism-uploads'),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      // Office documents
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',    // .docx
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',          // .xlsx
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',  // .pptx
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Supported: ${allowed.join(', ')}`));
    }
  },
});

// Ensure upload directory exists
const uploadDir = path.join(os.tmpdir(), 'prism-uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/**
 * Helper: convert DB row to UploadedFile
 */
function rowToUploadedFile(row: any): UploadedFile {
  return {
    id: row.id,
    sessionId: row.session_id,
    filename: row.filename,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    filePath: row.file_path,
    status: row.status,
    extractedText: row.extracted_text ?? undefined,
    summary: row.summary ?? undefined,
    analyzedBy: row.analyzed_by ?? undefined,
    errorMessage: row.error_message ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ──────────────────────────────────────────────────────────────
// POST /api/files/upload — Upload a file and trigger analysis
// ──────────────────────────────────────────────────────────────
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const sessionId = req.body.sessionId;
    if (!sessionId) {
      // Clean up the uploaded file
      fs.unlinkSync(file.path);
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const db = getDb();
    const id = uuid();
    const now = Date.now();

    // Insert file record
    db.prepare(`
      INSERT INTO uploaded_files (id, session_id, filename, mime_type, file_size, file_path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, sessionId, file.originalname, file.mimetype, file.size, file.path, now, now);

    console.log(`[files] Uploaded: ${file.originalname} (${file.mimetype}, ${file.size} bytes) → ${id}`);

    // Return immediately with pending status
    const record = db.prepare('SELECT * FROM uploaded_files WHERE id = ?').get(id) as any;
    res.json(rowToUploadedFile(record));

    // Trigger analysis asynchronously
    triggerAnalysis(id, sessionId).catch((err) => {
      console.error(`[files] Async analysis failed for ${id}:`, err.message);
    });
  } catch (err: any) {
    console.error('[files] Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/files?sessionId=xxx — List files for a session
// ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId query param is required' });
    return;
  }

  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM uploaded_files WHERE session_id = ? ORDER BY created_at DESC'
  ).all(sessionId) as any[];

  res.json(rows.map(rowToUploadedFile));
});

// ──────────────────────────────────────────────────────────────
// GET /api/files/:id — Get a single file record
// ──────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM uploaded_files WHERE id = ?').get(req.params.id) as any;

  if (!row) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  res.json(rowToUploadedFile(row));
});

// ──────────────────────────────────────────────────────────────
// DELETE /api/files/:id — Delete a file record and disk file
// ──────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM uploaded_files WHERE id = ?').get(req.params.id) as any;

  if (!row) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  // Delete disk file
  try {
    if (fs.existsSync(row.file_path)) {
      fs.unlinkSync(row.file_path);
    }
  } catch (err: any) {
    console.warn(`[files] Could not delete disk file ${row.file_path}:`, err.message);
  }

  // Delete DB record
  db.prepare('DELETE FROM uploaded_files WHERE id = ?').run(req.params.id);

  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────
// GET /api/files/supported-types — List supported MIME types
// ──────────────────────────────────────────────────────────────
router.get('/supported-types', (_req, res) => {
  res.json({ mimeTypes: fileSkillRegistry.supportedMimeTypes() });
});

// ──────────────────────────────────────────────────────────────
// Async analysis trigger
// ──────────────────────────────────────────────────────────────
async function triggerAnalysis(fileId: string, sessionId: string): Promise<void> {
  // Lazy import to avoid circular dependency
  const { agentRegistry } = await import('../agents');

  const agent = agentRegistry.get('file_analysis');
  if (!agent) {
    console.error('[files] FileAnalysisAgent not registered!');
    const db = getDb();
    db.prepare('UPDATE uploaded_files SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
      .run('error', 'FileAnalysisAgent not available', Date.now(), fileId);
    return;
  }

  await agent.execute(
    { fileId, sessionId },
    { sessionId, messages: [], artifacts: [] }
  );
}

export default router;
