import { v4 as uuid } from 'uuid';
import { getDb } from '../memory/db';
import { getAdapter } from '../adapters';
import { saveOutline, getOutline, deleteOutline } from '../memory/outline-store';
import type { LLMProvider, SessionOutline, OutlineSection } from '@prism/shared';

const OUTLINE_PROMPT = `You are a conversation analyst. Analyze the following conversation and identify distinct topic segments.

For each segment, provide:
- title: A short descriptive title (3-8 words)
- description: A 1-2 sentence summary of what was discussed
- startIndex: The 0-based index of the first message in this segment
- endIndex: The 0-based index of the last message in this segment
- keyEntities: Notable names, technologies, or concepts mentioned (0-5 items)

Rules:
- Identify 3-10 distinct topic segments
- Every message must belong to exactly one segment
- Segments must be contiguous (no gaps or overlaps)
- startIndex of first segment must be 0
- endIndex of last segment must equal the last message index

Respond in JSON format only:
{
  "sections": [
    {
      "title": "...",
      "description": "...",
      "startIndex": 0,
      "endIndex": 5,
      "keyEntities": ["entity1", "entity2"]
    }
  ]
}

CONVERSATION TITLE: {title}
MESSAGES:
{messages}`;

export class OutlineService {
  /**
   * Generate an outline for a session (native or imported).
   */
  async generateOutline(
    sessionId: string,
    sourceType: 'native' | 'imported',
    provider: LLMProvider = 'openai',
    model: string = 'gpt-4o-mini'
  ): Promise<SessionOutline> {
    const db = getDb();

    // Fetch messages
    let messages: { role: string; content: string }[];
    let title: string;

    if (sourceType === 'native') {
      const session = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as any;
      title = session?.title || 'Untitled Session';

      messages = db.prepare(`
        SELECT role, content FROM messages
        WHERE session_id = ?
        ORDER BY timestamp ASC
      `).all(sessionId) as any[];
    } else {
      const conv = db.prepare('SELECT title FROM imported_conversations WHERE id = ?').get(sessionId) as any;
      title = conv?.title || 'Untitled Conversation';

      messages = db.prepare(`
        SELECT role, content FROM imported_messages
        WHERE conversation_id = ?
        ORDER BY timestamp ASC
      `).all(sessionId) as any[];
    }

    if (messages.length < 2) {
      throw new Error('Not enough messages to generate an outline (minimum 2)');
    }

    // Build numbered message text, truncated for token efficiency
    const numberedMessages = messages.map((m, i) =>
      `[${i}] ${m.role}: ${m.content.slice(0, 300)}`
    ).join('\n');

    // Truncate to ~4000 words
    const truncated = numberedMessages.split(/\s+/).slice(0, 4000).join(' ');

    const prompt = OUTLINE_PROMPT
      .replace('{title}', title)
      .replace('{messages}', truncated);

    // Call LLM
    const adapter = getAdapter(provider);
    let responseText = '';
    const stream = adapter.stream({
      model,
      provider,
      messages: [{ role: 'user' as const, content: prompt }],
      temperature: 0.1,
    });

    for await (const chunk of stream) {
      if (chunk.content) responseText += chunk.content;
    }

    // Parse response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse outline response from LLM');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const rawSections: any[] = parsed.sections || [];

    if (rawSections.length === 0) {
      throw new Error('LLM returned no sections');
    }

    // Build OutlineSection array
    const sections: OutlineSection[] = rawSections.map((s: any) => ({
      id: uuid(),
      title: s.title || 'Untitled Section',
      description: s.description,
      startMessageIndex: s.startIndex ?? 0,
      endMessageIndex: s.endIndex ?? 0,
      messageCount: (s.endIndex ?? 0) - (s.startIndex ?? 0) + 1,
      keyEntities: s.keyEntities || [],
    }));

    // Delete old outline and save new one
    deleteOutline(sessionId, sourceType);

    const outline: SessionOutline = {
      id: uuid(),
      sessionId,
      sourceType,
      sections,
      generatedAt: new Date().toISOString(),
      modelUsed: `${provider}/${model}`,
      version: 1,
    };

    saveOutline(outline);
    console.log(`[outline] Generated outline for ${sourceType}/${sessionId}: ${sections.length} sections`);

    return outline;
  }

  /**
   * Get cached outline.
   */
  getOutline(sessionId: string, sourceType: 'native' | 'imported'): SessionOutline | null {
    return getOutline(sessionId, sourceType);
  }

  /**
   * Delete outline (for regeneration).
   */
  deleteOutline(sessionId: string, sourceType: 'native' | 'imported'): void {
    deleteOutline(sessionId, sourceType);
  }
}

export const outlineService = new OutlineService();
