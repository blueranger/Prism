import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { getParser, ParseResult } from '../parsers';
import { upsertImportSyncState } from '../memory/import-store';
import {
  ClaudeSyncConversation,
  ChatGPTSyncConversation,
  GeminiSyncConversation,
  ImportPlatform,
  ImportProgress,
  ImportSourceKind,
  ImportSyncState,
  ImportedTitleSource,
} from '@prism/shared';
import { getDb } from '../memory/db';

type IngestOptions = {
  projectName?: string | null;
  sourceKind: ImportSourceKind;
  syncStateByOriginalId?: Map<string, Omit<ImportSyncState, 'conversationId' | 'sourcePlatform' | 'originalId'>>;
};

type IngestResult = {
  conversationIds: string[];
};

export class ImportService {
  /**
   * Import a conversation archive file.
   * @param filePath - Path to the uploaded file (ZIP or JSON)
   * @param platform - Which platform this file is from
   */
  async importFile(filePath: string, platform: ImportPlatform, originalFilename?: string): Promise<ImportProgress> {
    return this.importFileWithOptions(filePath, platform, { originalFilename });
  }

  async importFileWithOptions(
    filePath: string,
    platform: ImportPlatform,
    opts?: { originalFilename?: string; projectName?: string | null }
  ): Promise<ImportProgress> {
    const batchId = uuid();
    const progress = this.createProgress(batchId, platform);

    try {
      const rawData = await this.extractData(filePath, platform, opts?.originalFilename);
      const parser = getParser(platform);
      const parsed = parser.parse(rawData, batchId);

      this.ingestParsedData(parsed, progress, {
        projectName: opts?.projectName,
        sourceKind: 'archive_upload',
      });

      progress.status = 'completed';
      console.log(
        `[import] Batch ${batchId}: ${progress.processedConversations} conversations handled (${progress.overwrittenConversations ?? 0} overwritten), ${progress.totalMessages} messages imported from ${platform}`
      );
    } catch (err: any) {
      progress.status = 'failed';
      progress.error = err.message;
      console.error(`[import] Batch ${batchId} failed:`, err);
    } finally {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }

    return progress;
  }

  async importChatGPTSync(
    conversations: ChatGPTSyncConversation[],
    opts?: { projectName?: string | null }
  ): Promise<ImportProgress> {
    const batchId = uuid();
    const progress = this.createProgress(batchId, 'chatgpt');

    const parser = getParser('chatgpt');
    const parsed = parser.parse(conversations, batchId);
    const syncedAt = new Date().toISOString();

    const syncStateByOriginalId = new Map<string, Omit<ImportSyncState, 'conversationId' | 'sourcePlatform' | 'originalId'>>();
    for (const conversation of conversations) {
      if (!conversation?.id) continue;
      syncStateByOriginalId.set(conversation.id, {
        sourceKind: 'chatgpt_browser_sync',
        lastSyncedAt: syncedAt,
        sourceUpdatedAt: this.toIsoTimestamp(conversation.update_time),
        projectName: opts?.projectName?.trim() || undefined,
        workspaceId: this.toOptionalString(conversation.workspace_id),
        workspaceName: this.toOptionalString(conversation.workspace_name),
        accountId: this.toOptionalString(conversation.account_id),
        metadata: {
          currentNode: conversation.current_node ?? null,
          conversationTemplateId: conversation.conversation_template_id ?? null,
          defaultModelSlug: conversation.default_model_slug ?? null,
          isArchived: conversation.is_archived ?? false,
        },
      });
    }

    this.ingestParsedData(parsed, progress, {
      projectName: opts?.projectName,
      sourceKind: 'chatgpt_browser_sync',
      syncStateByOriginalId,
    });

    progress.status = 'completed';
    console.log(
      `[import-sync] Batch ${batchId}: received ${progress.totalConversations}, handled ${progress.processedConversations}, overwritten ${progress.overwrittenConversations ?? 0}, skipped ${progress.skippedConversations ?? 0}`
    );

    return progress;
  }

  async importClaudeSync(
    conversations: ClaudeSyncConversation[],
    opts?: { projectName?: string | null }
  ): Promise<ImportProgress> {
    const batchId = uuid();
    const progress = this.createProgress(batchId, 'claude');

    const parser = getParser('claude');
    const parsed = parser.parse(conversations, batchId);
    const syncedAt = new Date().toISOString();

    const syncStateByOriginalId = new Map<string, Omit<ImportSyncState, 'conversationId' | 'sourcePlatform' | 'originalId'>>();
    for (const conversation of conversations) {
      if (!conversation?.uuid) continue;
      syncStateByOriginalId.set(conversation.uuid, {
        sourceKind: 'claude_browser_sync',
        lastSyncedAt: syncedAt,
        sourceUpdatedAt: this.toOptionalString(conversation.updated_at) ?? this.toOptionalString(conversation.created_at),
        projectName: opts?.projectName?.trim() || this.toOptionalString(conversation.project_name) || undefined,
        workspaceId: this.toOptionalString(conversation.project_uuid),
        workspaceName: this.toOptionalString(conversation.project_name),
        accountId: this.toOptionalString(conversation.account_uuid) ?? this.toOptionalString(conversation.account_email_address),
        metadata: {
          currentLeafMessageUuid: conversation.current_leaf_message_uuid ?? null,
          model: conversation.model ?? null,
        },
      });
    }

    this.ingestParsedData(parsed, progress, {
      projectName: opts?.projectName,
      sourceKind: 'claude_browser_sync',
      syncStateByOriginalId,
    });

    progress.status = 'completed';
    console.log(
      `[import-sync] Claude batch ${batchId}: received ${progress.totalConversations}, handled ${progress.processedConversations}, overwritten ${progress.overwrittenConversations ?? 0}, skipped ${progress.skippedConversations ?? 0}`
    );

    return progress;
  }

  async importGeminiSync(
    conversations: GeminiSyncConversation[],
    opts?: { projectName?: string | null }
  ): Promise<ImportProgress> {
    const batchId = uuid();
    const progress = this.createProgress(batchId, 'gemini');

    const parser = getParser('gemini');
    const parsed = parser.parse(conversations, batchId);
    const syncedAt = new Date().toISOString();

    const syncStateByOriginalId = new Map<string, Omit<ImportSyncState, 'conversationId' | 'sourcePlatform' | 'originalId'>>();
    for (const conversation of conversations) {
      if (!conversation?.id) continue;
      syncStateByOriginalId.set(conversation.id, {
        sourceKind: 'gemini_browser_sync',
        lastSyncedAt: syncedAt,
        sourceUpdatedAt: this.toOptionalString(conversation.updatedAt) ?? this.toOptionalString(conversation.createTime),
        projectName: opts?.projectName?.trim() || this.toOptionalString(conversation.projectName) || undefined,
        workspaceId: this.toOptionalString(conversation.projectId),
        workspaceName: this.toOptionalString(conversation.projectName),
        metadata: {
          ...((conversation.metadata && typeof conversation.metadata === 'object') ? conversation.metadata : {}),
          projectId: conversation.projectId ?? null,
          projectName: conversation.projectName ?? null,
        },
      });
    }

    this.ingestParsedData(parsed, progress, {
      projectName: opts?.projectName,
      sourceKind: 'gemini_browser_sync',
      syncStateByOriginalId,
    });

    progress.status = 'completed';
    console.log(
      `[import-sync] Gemini batch ${batchId}: received ${progress.totalConversations}, handled ${progress.processedConversations}, overwritten ${progress.overwrittenConversations ?? 0}, skipped ${progress.skippedConversations ?? 0}`
    );

    return progress;
  }

  private createProgress(batchId: string, platform: ImportPlatform): ImportProgress {
    return {
      batchId,
      platform,
      status: 'processing',
      totalConversations: 0,
      processedConversations: 0,
      importedConversations: 0,
      overwrittenConversations: 0,
      skippedConversations: 0,
      totalMessages: 0,
    };
  }

  private ingestParsedData(
    parsed: ParseResult,
    progress: ImportProgress,
    opts: IngestOptions
  ): IngestResult {
    const totalBefore = parsed.conversations.length;
    const conversations = parsed.conversations.filter((c) => c.messageCount > 0);
    const validConvIds = new Set(conversations.map((c) => c.id));
    const messages = parsed.messages.filter((m) => validConvIds.has(m.conversationId));
    const skipped = totalBefore - conversations.length;

    progress.totalConversations = totalBefore;
    progress.totalMessages = messages.length;
    progress.skippedConversations = skipped;

    if (skipped > 0) {
      console.log(`[import] Skipped ${skipped} empty conversations (0 messages)`);
    }

    const db = getDb();

    const insertConv = db.prepare(`
      INSERT INTO imported_conversations
      (id, source_platform, original_id, title, source_title, title_source, title_locked, title_generated_at, title_last_message_count, created_at, updated_at, message_count, import_batch_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateConv = db.prepare(`
      UPDATE imported_conversations
      SET title = ?,
          source_title = ?,
          title_source = ?,
          title_locked = ?,
          title_generated_at = ?,
          title_last_message_count = ?,
          created_at = ?,
          updated_at = ?,
          message_count = ?,
          import_batch_id = ?,
          metadata = ?
      WHERE id = ?
    `);

    const findExistingConv = db.prepare(`
      SELECT id, title, source_title, title_source, title_locked, title_generated_at, title_last_message_count
      FROM imported_conversations
      WHERE source_platform = ? AND original_id = ?
      LIMIT 1
    `);

    const deleteExistingMessages = db.prepare(`
      DELETE FROM imported_messages
      WHERE conversation_id = ?
    `);

    const insertMsg = db.prepare(`
      INSERT INTO imported_messages
      (id, conversation_id, role, content, source_model, timestamp, token_count, parent_message_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const finalConversationIds: string[] = [];

    const insertAll = db.transaction(() => {
      const conversationIdMap = new Map<string, string>();

      for (const conv of conversations) {
        const mergedMetadata = this.mergeProjectName(conv.metadata, opts.projectName, opts.sourceKind);
        const metadataJson = mergedMetadata ? JSON.stringify(mergedMetadata) : null;
        const originalId = conv.originalId || null;
        let targetConversationId = conv.id;
        const incomingSourceTitle = conv.title || 'Untitled';

        if (originalId) {
          const existing = findExistingConv.get(conv.sourcePlatform, originalId) as {
            id: string;
            title: string;
            source_title: string | null;
            title_source: ImportedTitleSource | null;
            title_locked: number | null;
            title_generated_at: string | null;
            title_last_message_count: number | null;
          } | undefined;
          if (existing?.id) {
            const titleState = this.resolveUpdatedTitleState(existing, incomingSourceTitle);
            updateConv.run(
              titleState.title,
              titleState.sourceTitle,
              titleState.titleSource,
              titleState.titleLocked ? 1 : 0,
              titleState.titleGeneratedAt,
              titleState.titleLastMessageCount,
              conv.createdAt,
              conv.updatedAt || null,
              conv.messageCount,
              conv.importBatchId,
              metadataJson,
              existing.id
            );
            deleteExistingMessages.run(existing.id);
            targetConversationId = existing.id;
            progress.overwrittenConversations = (progress.overwrittenConversations ?? 0) + 1;
          } else {
            insertConv.run(
              conv.id,
              conv.sourcePlatform,
              originalId,
              incomingSourceTitle,
              incomingSourceTitle,
              'source',
              0,
              null,
              null,
              conv.createdAt,
              conv.updatedAt || null,
              conv.messageCount,
              conv.importBatchId,
              metadataJson
            );
            progress.importedConversations = (progress.importedConversations ?? 0) + 1;
          }
        } else {
          insertConv.run(
            conv.id,
            conv.sourcePlatform,
            null,
            incomingSourceTitle,
            incomingSourceTitle,
            'source',
            0,
            null,
            null,
            conv.createdAt,
            conv.updatedAt || null,
            conv.messageCount,
            conv.importBatchId,
            metadataJson
          );
          progress.importedConversations = (progress.importedConversations ?? 0) + 1;
        }

        conversationIdMap.set(conv.id, targetConversationId);
        finalConversationIds.push(targetConversationId);
        progress.processedConversations++;

        if (originalId && opts.syncStateByOriginalId?.has(originalId)) {
          const syncState = opts.syncStateByOriginalId.get(originalId)!;
          upsertImportSyncState({
            conversationId: targetConversationId,
            sourcePlatform: conv.sourcePlatform,
            originalId,
            ...syncState,
          });
        }
      }

      for (const msg of messages) {
        const targetConversationId = conversationIdMap.get(msg.conversationId) ?? msg.conversationId;
        insertMsg.run(
          msg.id,
          targetConversationId,
          msg.role,
          msg.content,
          msg.sourceModel || null,
          msg.timestamp,
          msg.tokenCount || null,
          msg.parentMessageId || null,
          msg.metadata ? JSON.stringify(msg.metadata) : null
        );
      }
    });

    insertAll();

    return { conversationIds: finalConversationIds };
  }

  private async extractData(filePath: string, _platform: ImportPlatform, originalFilename?: string): Promise<any[]> {
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

      for (const entry of entries) {
        const name = entry.entryName.toLowerCase();
        if (name.endsWith('.json') && !name.startsWith('__MACOSX') && !name.startsWith('.')) {
          if (
            name === 'conversations.json' ||
            name.includes('conversations') ||
            name.includes('my_activity') || name.includes('myactivity') ||
            entries.filter((e) => e.entryName.endsWith('.json')).length === 1
          ) {
            const content = entry.getData().toString('utf-8');
            const parsed = JSON.parse(content);
            return Array.isArray(parsed) ? parsed : [parsed];
          }
        }
      }

      const jsonEntries = entries.filter((e) =>
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

  private mergeProjectName(
    metadata: Record<string, any> | undefined,
    projectName?: string | null,
    sourceKind: ImportSourceKind = 'archive_upload'
  ): Record<string, any> | undefined {
    const nextMetadata: Record<string, any> = {
      ...(metadata ?? {}),
      sourceKind,
    };
    const trimmed = projectName?.trim();
    if (trimmed) {
      nextMetadata.projectName = trimmed;
    }
    return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined;
  }

  private toOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private toIsoTimestamp(value: number | null | undefined): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value * 1000).toISOString();
    }
    return undefined;
  }

  private resolveUpdatedTitleState(
    existing: {
      title: string;
      source_title: string | null;
      title_source: ImportedTitleSource | null;
      title_locked: number | null;
      title_generated_at: string | null;
      title_last_message_count: number | null;
    },
    incomingSourceTitle: string
  ): {
    title: string;
    sourceTitle: string;
    titleSource: ImportedTitleSource;
    titleLocked: boolean;
    titleGeneratedAt: string | null;
    titleLastMessageCount: number | null;
  } {
    const titleLocked = Boolean(existing.title_locked);
    const titleSource = existing.title_source ?? 'source';

    if (titleLocked) {
      return {
        title: existing.title || incomingSourceTitle,
        sourceTitle: incomingSourceTitle,
        titleSource,
        titleLocked: true,
        titleGeneratedAt: existing.title_generated_at ?? null,
        titleLastMessageCount: existing.title_last_message_count ?? null,
      };
    }

    return {
      title: titleSource === 'source' ? incomingSourceTitle : (existing.title || incomingSourceTitle),
      sourceTitle: incomingSourceTitle,
      titleSource,
      titleLocked: false,
      titleGeneratedAt: existing.title_generated_at ?? null,
      titleLastMessageCount: existing.title_last_message_count ?? null,
    };
  }
}

export const importService = new ImportService();
