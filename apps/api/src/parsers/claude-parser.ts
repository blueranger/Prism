import { v4 as uuid } from 'uuid';
import { ConversationParser, ParseResult } from './base-parser';
import { ImportedConversation, ImportedMessage } from '@prism/shared';

export class ClaudeParser implements ConversationParser {
  platform = 'claude' as const;

  parse(data: any[], batchId: string): ParseResult {
    const conversations: ImportedConversation[] = [];
    const messages: ImportedMessage[] = [];

    for (const conv of data) {
      const convId = uuid();
      const convMessages: ImportedMessage[] = [];

      const chatMessages = conv.chat_messages || [];
      for (const msg of chatMessages) {
        const role = msg.sender === 'human' ? 'user' : 'assistant';
        // Content can be in msg.text or msg.content[].text
        let content = msg.text || '';
        if (!content && Array.isArray(msg.content)) {
          content = msg.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
        }

        if (content.trim()) {
          convMessages.push({
            id: uuid(),
            conversationId: convId,
            role,
            content,
            timestamp: msg.created_at || conv.created_at || new Date().toISOString(),
            metadata: {
              originalUuid: msg.uuid,
              updatedAt: msg.updated_at,
            },
          });
        }
      }

      conversations.push({
        id: convId,
        sourcePlatform: 'claude',
        originalId: conv.uuid,
        title: conv.name || 'Untitled',
        createdAt: conv.created_at || new Date().toISOString(),
        updatedAt: conv.updated_at,
        messageCount: convMessages.length,
        importBatchId: batchId,
      });

      messages.push(...convMessages);
    }
    return { conversations, messages };
  }
}
