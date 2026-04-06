import { GoogleGenerativeAI } from '@google/generative-ai';
import { LLMProvider, LLMRequest, StreamChunk } from '@prism/shared';
import { LLMAdapter } from './common';

export class GoogleAdapter extends LLMAdapter {
  provider: LLMProvider = 'google';
  private genAI: GoogleGenerativeAI | null = null;

  private getGenAI(): GoogleGenerativeAI {
    if (!this.genAI) {
      this.genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY ?? '');
    }
    return this.genAI;
  }

  async *stream(request: LLMRequest): AsyncGenerator<StreamChunk> {
    try {
      console.log(`[google] Starting stream for ${request.model} with ${request.messages.length} messages`);
      const model = this.getGenAI().getGenerativeModel({ model: request.model });

      const systemMessage = request.messages.find((m) => m.role === 'system');
      const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

      // Build chat history (all messages except the last user message)
      const history = nonSystemMessages.slice(0, -1).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      const lastMessage = nonSystemMessages[nonSystemMessages.length - 1];

      // Build generation config
      const generationConfig: Record<string, any> = {
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        maxOutputTokens: request.maxTokens,
      };

      // Thinking mode: add thinkingConfig
      if (request.thinking?.enabled && request.thinking.budgetTokens !== undefined) {
        generationConfig.thinkingConfig = {
          thinkingBudget: request.thinking.budgetTokens,
        };
        console.log(`[google] Thinking enabled: budgetTokens=${request.thinking.budgetTokens}`);
      }

      const chat = model.startChat({
        history,
        ...(systemMessage
          ? { systemInstruction: { role: 'user', parts: [{ text: systemMessage.content }] } }
          : {}),
        generationConfig,
      });

      const result = await chat.sendMessageStream(lastMessage.content);
      let stopReason: string | undefined;
      let chunkCount = 0;
      let contentChars = 0;
      let thinkingChars = 0;

      for await (const chunk of result.stream) {
        chunkCount += 1;
        // Access candidate parts to distinguish thinking vs response content
        const candidate = (chunk as any).candidates?.[0];
        const parts = candidate?.content?.parts;

        if (parts && Array.isArray(parts)) {
          for (const part of parts) {
            if (part.thought && part.text) {
              thinkingChars += String(part.text).length;
              // Thinking content (part has thought: true flag)
              yield {
                provider: this.provider,
                model: request.model,
                content: '',
                done: false,
                thinkingContent: part.text,
              };
            } else if (part.text) {
              contentChars += String(part.text).length;
              // Regular response content
              yield {
                provider: this.provider,
                model: request.model,
                content: part.text,
                done: false,
              };
            }
          }
        } else {
          // Fallback: use chunk.text() for non-thinking responses
          const text = chunk.text();
          if (text) {
            contentChars += String(text).length;
            yield {
              provider: this.provider,
              model: request.model,
              content: text,
              done: false,
            };
          }
        }
      }

      try {
        const finalResponse = await result.response;
        stopReason = (finalResponse as any)?.candidates?.[0]?.finishReason
          ?? (finalResponse as any)?.candidates?.[0]?.finish_reason
          ?? undefined;
      } catch {
        // Ignore final response metadata failure; streaming content already arrived.
      }

      console.log(`[google] Stream finished for ${request.model}`, {
        chunkCount,
        contentChars,
        thinkingChars,
        stopReason,
      });

      yield {
        provider: this.provider,
        model: request.model,
        content: '',
        done: true,
        stopReason,
      };
    } catch (err: any) {
      console.error(`[google] Stream failed for ${request.model}`, {
        error: err.message ?? 'Google AI request failed',
      });
      yield {
        provider: this.provider,
        model: request.model,
        content: '',
        done: true,
        error: err.message ?? 'Google AI request failed',
      };
    }
  }
}
