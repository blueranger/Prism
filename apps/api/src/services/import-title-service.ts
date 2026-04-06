import { getAdapter } from '../adapters';
import { getDb } from '../memory/db';

const TITLE_MODEL = 'gpt-4o-mini';
const RETITLE_MESSAGE_THRESHOLD = 8;
const MAX_CONTEXT_CHARS = 12000;

const TITLE_SYSTEM_PROMPT = `You generate short conversation titles.

Rules:
- Return only the title text, no quotes or markdown.
- Keep it concise and task-focused.
- Prefer 4-12 words.
- Preserve the original language used in the conversation.
- Do not start with conversational phrases like "Help me", "Please", "Question about", "Discussion on", or similar filler.
- Prefer concrete task/topic names over generic summaries.`;

type ConversationRow = {
  id: string;
  title: string;
  source_title: string | null;
  title_source: 'source' | 'ai' | 'manual' | null;
  title_locked: number;
  title_generated_at: string | null;
  title_last_message_count: number | null;
  message_count: number;
};

type MessageRow = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
};

export class ImportTitleService {
  async generateForConversationIds(conversationIds: string[]): Promise<void> {
    if (!process.env.OPENAI_API_KEY) {
      console.log('[import-title] OPENAI_API_KEY not set, skipping auto-title generation');
      return;
    }

    const ids = Array.from(new Set(conversationIds.filter(Boolean)));
    if (ids.length === 0) return;

    for (const conversationId of ids) {
      try {
        await this.generateForConversationId(conversationId);
      } catch (error: any) {
        console.error(`[import-title] Failed for conversation ${conversationId}:`, error.message);
      }
    }
  }

  async generateForConversationId(conversationId: string, opts?: { force?: boolean }): Promise<boolean> {
    const db = getDb();
    const conversation = db.prepare(`
      SELECT id, title, source_title, title_source, title_locked, title_generated_at, title_last_message_count, message_count
      FROM imported_conversations
      WHERE id = ?
      LIMIT 1
    `).get(conversationId) as ConversationRow | undefined;

    if (!conversation) return false;
    if (conversation.title_locked && !opts?.force) return false;
    if (!opts?.force && !this.shouldGenerateTitle(conversation)) return false;

    const messages = db.prepare(`
      SELECT role, content, timestamp
      FROM imported_messages
      WHERE conversation_id = ?
      ORDER BY timestamp ASC
    `).all(conversationId) as MessageRow[];

    const prompt = this.buildPrompt(conversation, messages);
    if (!prompt) return false;

    const adapter = getAdapter('openai');
    let generatedTitle = '';
    const stream = adapter.stream({
      model: TITLE_MODEL,
      provider: 'openai',
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 80,
    });

    for await (const chunk of stream) {
      if (chunk.content) generatedTitle += chunk.content;
      if (chunk.error) {
        throw new Error(chunk.error);
      }
    }

    const normalizedTitle = this.normalizeGeneratedTitle(generatedTitle, conversation.source_title || conversation.title);
    if (!normalizedTitle) return false;

    db.prepare(`
      UPDATE imported_conversations
      SET title = ?,
          title_source = 'ai',
          title_locked = 0,
          title_generated_at = ?,
          title_last_message_count = ?
      WHERE id = ?
        AND (? = 1 OR title_locked = 0)
    `).run(
      normalizedTitle,
      new Date().toISOString(),
      conversation.message_count,
      conversationId,
      opts?.force ? 1 : 0
    );
    return true;
  }

  private shouldGenerateTitle(conversation: ConversationRow): boolean {
    if (!conversation.title_generated_at) return true;
    const lastCount = conversation.title_last_message_count ?? 0;
    return conversation.message_count - lastCount >= RETITLE_MESSAGE_THRESHOLD;
  }

  private buildPrompt(conversation: ConversationRow, messages: MessageRow[]): string | null {
    const usefulMessages = messages
      .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim())
      .map((message) => ({
        role: message.role,
        content: message.content.trim(),
      }));

    if (usefulMessages.length === 0) return null;

    const selectedMessages = [
      ...usefulMessages.slice(0, 4),
      ...usefulMessages.slice(Math.max(usefulMessages.length - 6, 4)),
    ];

    const dedupedMessages: Array<{ role: string; content: string }> = [];
    const seen = new Set<string>();
    for (const message of selectedMessages) {
      const key = `${message.role}:${message.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedupedMessages.push(message);
    }

    const transcript = dedupedMessages
      .map((message) => `[${message.role}] ${message.content}`)
      .join('\n\n')
      .slice(0, MAX_CONTEXT_CHARS);

    if (!transcript.trim()) return null;

    return `Original title: ${conversation.source_title || conversation.title || 'Untitled'}
Message count: ${conversation.message_count}

Conversation excerpt:
${transcript}

Generate one improved title for this conversation.`;
  }

  private normalizeGeneratedTitle(raw: string, fallback: string): string {
    const cleaned = String(raw || '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split('\n')[0]
      ?.trim();

    if (!cleaned) return fallback;
    if (cleaned.length > 120) {
      return cleaned.slice(0, 120).trim();
    }
    return cleaned;
  }
}

export const importTitleService = new ImportTitleService();
