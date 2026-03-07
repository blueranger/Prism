import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { getDb } from '../memory/db';
import { getParser } from '../parsers';
import { ImportPlatform, ImportProgress } from '@prism/shared';

export class ImportService {
  /**
   * Import a conversation archive file.
   * @param filePath - Path to the uploaded file (ZIP or JSON)
   * @param platform - Which platform this file is from
   */
  async importFile(filePath: string, platform: ImportPlatform, originalFilename?: string): Promise<ImportProgress> {
    const batchId = uuid();
    const progress: ImportProgress = {
      batchId,
      platform,
      status: 'processing',
      totalConversations: 0,
      processedConversations: 0,
      totalMessages: 0,
    };

    try {
      // 1. Extract data from file
      const rawData = await this.extractData(filePath, platform, originalFilename);

      // 2. Parse
      const parser = getParser(platform);
      const parsed = parser.parse(rawData, batchId);

      // Filter out empty conversations (no messages)
      const totalBefore = parsed.conversations.length;
      const conversations = parsed.conversations.filter(c => c.messageCount > 0);
      const validConvIds = new Set(conversations.map(c => c.id));
      const messages = parsed.messages.filter(m => validConvIds.has(m.conversationId));
      const skipped = totalBefore - conversations.length;
      if (skipped > 0) {
        console.log(`[import] Skipped ${skipped} empty conversations (0 messages)`);
      }

      progress.totalConversations = conversations.length;
      progress.totalMessages = messages.length;

      // 3. Batch insert into DB
      const db = getDb();

      const insertConv = db.prepare(`
        INSERT INTO imported_conversations
        (id, source_platform, original_id, title, created_at, updated_at, message_count, import_batch_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMsg = db.prepare(`
        INSERT INTO imported_messages
        (id, conversation_id, role, content, source_model, timestamp, token_count, parent_message_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertAll = db.transaction(() => {
        for (const conv of conversations) {
          insertConv.run(
            conv.id, conv.sourcePlatform, conv.originalId || null,
            conv.title, conv.createdAt, conv.updatedAt || null,
            conv.messageCount, conv.importBatchId,
            conv.metadata ? JSON.stringify(conv.metadata) : null
          );
          progress.processedConversations++;
        }

        for (const msg of messages) {
          insertMsg.run(
            msg.id, msg.conversationId, msg.role, msg.content,
            msg.sourceModel || null, msg.timestamp,
            msg.tokenCount || null, msg.parentMessageId || null,
            msg.metadata ? JSON.stringify(msg.metadata) : null
          );
        }
      });

      insertAll();

      progress.status = 'completed';
      console.log(`[import] Batch ${batchId}: ${conversations.length} conversations, ${messages.length} messages imported from ${platform}`);

    } catch (err: any) {
      progress.status = 'failed';
      progress.error = err.message;
      console.error(`[import] Batch ${batchId} failed:`, err);
    } finally {
      // Clean up uploaded file
      try { fs.unlinkSync(filePath); } catch {}
    }

    return progress;
  }

  private async extractData(filePath: string, _platform: ImportPlatform, originalFilename?: string): Promise<any[]> {
    // Use original filename extension if available (multer strips extensions)
    const ext = originalFilename
      ? path.extname(originalFilename).toLowerCase()
      : path.extname(filePath).toLowerCase();

    if (ext === '.json') {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [parsed];
    }

    if (ext === '.zip') {
      const zip = new AdmZip(filePath);
      const entries = zip.getEntries();

      // ChatGPT: look for conversations.json
      // Claude: look for any JSON file with conversations
      // Gemini: look for JSON files in Takeout structure

      for (const entry of entries) {
        const name = entry.entryName.toLowerCase();
        if (name.endsWith('.json') && !name.startsWith('__MACOSX') && !name.startsWith('.')) {
          // Heuristic: pick known filenames or single JSON in ZIP
          if (
            name === 'conversations.json' ||                  // ChatGPT
            name.includes('conversations') ||                  // Claude
            name.includes('my_activity') || name.includes('myactivity') ||  // Gemini
            entries.filter(e => e.entryName.endsWith('.json')).length === 1  // Single JSON in ZIP
          ) {
            const content = entry.getData().toString('utf-8');
            const parsed = JSON.parse(content);
            return Array.isArray(parsed) ? parsed : [parsed];
          }
        }
      }

      // Fallback: Gemini Takeout may have multiple JSON files (one per conversation)
      const jsonEntries = entries.filter(e =>
        e.entryName.endsWith('.json') &&
        !e.entryName.startsWith('__MACOSX') &&
        !e.entryName.startsWith('.')
      );
      if (jsonEntries.length > 0) {
        const allData: any[] = [];
        for (const entry of jsonEntries) {
          try {
            const content = entry.getData().toString('utf-8');
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) allData.push(...parsed);
            else allData.push(parsed);
          } catch {}
        }
        return allData;
      }

      throw new Error('No valid JSON files found in ZIP archive');
    }

    throw new Error(`Unsupported file format: ${ext}. Please upload a .json or .zip file.`);
  }
}

export const importService = new ImportService();
