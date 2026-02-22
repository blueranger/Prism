import { v4 as uuid } from 'uuid';
import { ConversationParser, ParseResult } from './base-parser';
import { ImportedConversation, ImportedMessage } from '@prism/shared';

export class GeminiParser implements ConversationParser {
  platform = 'gemini' as const;

  parse(data: any[], batchId: string): ParseResult {
    const conversations: ImportedConversation[] = [];
    const messages: ImportedMessage[] = [];

    // Google Takeout Gemini export: array of conversation objects
    // or MyActivity.json with prompt/response entries
    for (const conv of data) {
      const convId = uuid();
      const convMessages: ImportedMessage[] = [];

      if (conv.chunks) {
        // Format: { title, chunks: [{ type: 'USER'|'MODEL', content }] }
        for (const chunk of conv.chunks) {
          const role = chunk.type === 'USER' ? 'user' : 'assistant';
          const content = typeof chunk.content === 'string'
            ? chunk.content
            : JSON.stringify(chunk.content);

          if (content.trim()) {
            convMessages.push({
              id: uuid(),
              conversationId: convId,
              role,
              content,
              timestamp: chunk.timestamp || conv.createTime || new Date().toISOString(),
            });
          }
        }
      } else if (conv.entries) {
        // Alternative format from MyActivity.json
        for (const entry of conv.entries) {
          if (entry.query) {
            convMessages.push({
              id: uuid(), conversationId: convId, role: 'user',
              content: entry.query, timestamp: entry.timestamp || new Date().toISOString(),
            });
          }
          if (entry.response) {
            convMessages.push({
              id: uuid(), conversationId: convId, role: 'assistant',
              content: entry.response, timestamp: entry.timestamp || new Date().toISOString(),
            });
          }
        }
      }

      if (convMessages.length > 0) {
        conversations.push({
          id: convId,
          sourcePlatform: 'gemini',
          originalId: conv.id || undefined,
          title: conv.title || conv.name || 'Gemini Conversation',
          createdAt: conv.createTime || conv.created || new Date().toISOString(),
          messageCount: convMessages.length,
          importBatchId: batchId,
        });
        messages.push(...convMessages);
      }
    }
    return { conversations, messages };
  }
}
