import { v4 as uuid } from 'uuid';
import { ImportedConversation, ImportedMessage } from '@prism/shared';
import { ConversationParser, ParseResult } from './base-parser';

export class ChatGPTParser implements ConversationParser {
  platform = 'chatgpt' as const;

  parse(data: any[], batchId: string): ParseResult {
    const conversations: ImportedConversation[] = [];
    const messages: ImportedMessage[] = [];

    for (const conv of data) {
      const convId = uuid();
      const createdAt = this.toIsoTimestamp(conv.create_time, new Date(0).toISOString());
      const updatedAt = conv.update_time
        ? this.toIsoTimestamp(conv.update_time, createdAt)
        : undefined;
      const convMessages = this.flattenMapping(conv.mapping, convId, createdAt);

      conversations.push({
        id: convId,
        sourcePlatform: 'chatgpt',
        originalId: conv.id,
        title: conv.title || 'Untitled',
        createdAt,
        updatedAt,
        messageCount: convMessages.length,
        importBatchId: batchId,
        metadata: {
          conversationTemplateId: conv.conversation_template_id,
          defaultModelSlug: conv.default_model_slug,
          currentNode: conv.current_node,
          isArchived: conv.is_archived,
          workspaceId: conv.workspace_id ?? conv.workspaceId,
          workspaceName: conv.workspace_name ?? conv.workspaceName,
          accountId: conv.account_id ?? conv.accountId,
          ...((conv.metadata && typeof conv.metadata === 'object') ? conv.metadata : {}),
        },
      });

      messages.push(...convMessages);
    }
    return { conversations, messages };
  }

  private flattenMapping(
    mapping: Record<string, any>,
    conversationId: string,
    fallbackTimestamp: string
  ): ImportedMessage[] {
    const messages: ImportedMessage[] = [];
    const nodeMap = mapping;

    // Find root node (node with no parent or parent not in mapping)
    let rootId: string | null = null;
    for (const [id, node] of Object.entries(nodeMap)) {
      if (!node.parent || !nodeMap[node.parent]) {
        rootId = id;
        break;
      }
    }

    if (!rootId) return messages;

    // BFS to linearize the conversation (follow first child for main thread)
    const visited = new Set<string>();
    const queue: string[] = [rootId];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = nodeMap[nodeId];
      if (!node) continue;

      // Only include nodes that have actual message content
      if (node.message && node.message.content?.parts?.length > 0) {
        const role = node.message.author?.role;
        // Skip 'system' and 'tool' messages; keep 'user' and 'assistant'
        if (role === 'user' || role === 'assistant') {
          const content = node.message.content.parts
            .filter((p: any) => typeof p === 'string')
            .join('\n');

          if (content.trim()) {
            messages.push({
              id: uuid(),
              conversationId,
              role,
              content,
              sourceModel: node.message.metadata?.model_slug || undefined,
              timestamp: node.message.create_time
                ? this.toIsoTimestamp(node.message.create_time, fallbackTimestamp)
                : fallbackTimestamp,
              parentMessageId: node.parent || undefined,
              metadata: {
                originalNodeId: nodeId,
                weight: node.message.weight,
                endTurn: node.message.end_turn,
              },
            });
          }
        }
      }

      // Follow children (first child = main thread)
      if (node.children?.length > 0) {
        queue.push(...node.children);
      }
    }

    return messages;
  }

  private toIsoTimestamp(value: unknown, fallback: string): string {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value * 1000).toISOString();
    }
    return fallback;
  }
}
