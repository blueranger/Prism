import type { AgentInputSchema, AgentResult } from '@prism/shared';
import { BaseAgent, type MemoryContext } from './base';
import { agentRegistry } from './registry';
import { getDb } from '../memory/db';
import { fileSkillRegistry } from '../skills/registry';

// Import skills to ensure they're registered
import '../skills';

/**
 * FileAnalysisAgent — dispatches uploaded files to the appropriate skill
 * for content extraction and summarization.
 *
 * Triggered automatically after file upload.
 */
class FileAnalysisAgent extends BaseAgent {
  name = 'file_analysis';
  description = 'Analyzes uploaded files (PDF, Office documents, images) and extracts content';
  inputSchema: AgentInputSchema = {
    type: 'object',
    properties: {
      fileId: { type: 'string', description: 'ID of the uploaded file record' },
      sessionId: { type: 'string', description: 'Session the file belongs to' },
    },
    required: ['fileId', 'sessionId'],
  };

  async execute(
    input: Record<string, unknown>,
    _context: MemoryContext
  ): Promise<AgentResult> {
    const { fileId, sessionId } = input as { fileId: string; sessionId: string };
    const db = getDb();
    const now = Date.now();

    console.log(`[FileAnalysisAgent] Starting analysis for file ${fileId} in session ${sessionId}`);

    // 1. Load the file record
    const file = db.prepare('SELECT * FROM uploaded_files WHERE id = ? AND session_id = ?')
      .get(fileId, sessionId) as any;

    if (!file) {
      return this.fail(`File not found: ${fileId}`);
    }

    if (file.status === 'done') {
      return this.ok('File already analyzed', { log: ['File was already processed'] });
    }

    // 2. Mark as processing
    db.prepare('UPDATE uploaded_files SET status = ?, updated_at = ? WHERE id = ?')
      .run('processing', now, fileId);

    try {
      // 3. Find the appropriate skill
      const skill = fileSkillRegistry.findSkill(file.mime_type);
      if (!skill) {
        const supported = fileSkillRegistry.supportedMimeTypes().join(', ');
        const errorMsg = `No skill available for MIME type: ${file.mime_type}. Supported: ${supported}`;
        db.prepare('UPDATE uploaded_files SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
          .run('error', errorMsg, Date.now(), fileId);
        return this.fail(errorMsg);
      }

      console.log(`[FileAnalysisAgent] Using skill: ${skill.name}`);

      // 4. Process the file
      const result = await skill.process(file.file_path, file.mime_type);

      // 5. Update the DB with results
      const modelUsed = process.env.FILE_ANALYSIS_VISION_MODEL ?? 'gpt-4o';
      const metadataJson = result.metadata ? JSON.stringify(result.metadata) : null;
      db.prepare(`
        UPDATE uploaded_files
        SET status = 'done',
            extracted_text = ?,
            summary = ?,
            analyzed_by = ?,
            metadata = ?,
            error_message = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(result.extractedText, result.summary, modelUsed, metadataJson, Date.now(), fileId);

      console.log(`[FileAnalysisAgent] Analysis complete for ${file.filename}: ${result.summary.slice(0, 100)}...`);

      // 6. Index for RAG (async, non-blocking — don't wait or fail on this)
      import('../services/rag-indexer').then(({ indexUploadedFile }) => {
        indexUploadedFile(fileId).then((n) => {
          if (n > 0) console.log(`[FileAnalysisAgent] RAG indexed ${n} chunks for file ${fileId}`);
        }).catch((err) => {
          console.warn(`[FileAnalysisAgent] RAG indexing failed (non-critical):`, err.message);
        });
      });

      return this.ok(
        `File "${file.filename}" analyzed successfully using ${skill.name} skill.`,
        {
          log: [
            `Skill: ${skill.name}`,
            `Extracted text: ${result.extractedText.length} chars`,
            `Summary: ${result.summary.slice(0, 200)}`,
            ...(result.metadata ? [`Metadata: ${JSON.stringify(result.metadata)}`] : []),
          ],
        }
      );
    } catch (err: any) {
      const errorMsg = err.message ?? String(err);
      console.error(`[FileAnalysisAgent] Error processing ${file.filename}:`, errorMsg);

      db.prepare('UPDATE uploaded_files SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run('error', errorMsg, Date.now(), fileId);

      return this.fail(`Analysis failed: ${errorMsg}`);
    }
  }
}

// Self-register
agentRegistry.register(new FileAnalysisAgent());
