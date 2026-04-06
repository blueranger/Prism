import OpenAI from 'openai';
import { LLMProvider, LLMRequest, StreamChunk } from '@prism/shared';
import { LLMAdapter } from './common';

export class OpenAIAdapter extends LLMAdapter {
  provider: LLMProvider = 'openai';
  private client: OpenAI | null = null;

  private usesMaxCompletionTokens(model: string): boolean {
    return model.startsWith('gpt-5') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4');
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return this.client;
  }

  private buildContentPreview(content: string): { head: string; tail: string } {
    const normalized = content.replace(/\r\n/g, '\n');
    return {
      head: normalized.slice(0, 400),
      tail: normalized.slice(-400),
    };
  }

  async *stream(request: LLMRequest): AsyncGenerator<StreamChunk> {
    try {
      console.log(`[openai] Starting stream for ${request.model} with ${request.messages.length} messages`);

      // Build API parameters
      const params: Record<string, any> = {
        model: request.model,
        messages: request.messages,
        stream: true,
      };
      if (request.maxTokens !== undefined) {
        if (this.usesMaxCompletionTokens(request.model)) {
          params.max_completion_tokens = request.maxTokens;
        } else {
          params.max_tokens = request.maxTokens;
        }
      }

      // Thinking / reasoning mode
      if (request.thinking?.enabled && request.thinking.effort) {
        params.reasoning_effort = request.thinking.effort;
        // DO NOT include temperature for reasoning models — OpenAI rejects it
        console.log(`[openai] Thinking enabled: reasoning_effort=${request.thinking.effort}`);
      } else if (request.temperature !== undefined) {
        params.temperature = request.temperature;
      }

      const stream = await (this.getClient().chat.completions as any).create(params);
      let stopReason: string | undefined;
      let chunkCount = 0;
      let contentChars = 0;
      let thinkingChars = 0;
      let assembledContent = '';
      let firstContentChunk: string | null = null;
      console.log(`[openai] Stream created for ${request.model}`);

      for await (const chunk of stream) {
        chunkCount += 1;
        const choice = chunk.choices[0];
        const delta = choice?.delta as any;
        if (choice?.finish_reason) {
          stopReason = String(choice.finish_reason);
        }

        // Thinking / reasoning content (OpenAI returns this in delta.reasoning or delta.reasoning_content)
        const reasoning = delta?.reasoning ?? delta?.reasoning_content;
        if (reasoning) {
          thinkingChars += String(reasoning).length;
          yield {
            provider: this.provider,
            model: request.model,
            content: '',
            done: false,
            thinkingContent: reasoning,
          };
        }

        // Regular response content
        if (delta?.content) {
          const contentPiece = String(delta.content);
          if (firstContentChunk === null) {
            firstContentChunk = contentPiece;
          }
          contentChars += contentPiece.length;
          assembledContent += contentPiece;
          yield {
            provider: this.provider,
            model: request.model,
            content: contentPiece,
            done: false,
          };
        }
      }

      const preview = this.buildContentPreview(assembledContent);
      console.log(`[openai] Stream finished for ${request.model}`, {
        chunkCount,
        contentChars,
        thinkingChars,
        stopReason,
      });
      if (firstContentChunk !== null) {
        console.log(`[openai] ${request.model} first content chunk >>>\n${firstContentChunk}\n<<< [end first chunk]`);
      }
      if (assembledContent.trim()) {
        console.log(`[openai] ${request.model} content preview (head) >>>\n${preview.head}\n<<< [end head]`);
        console.log(`[openai] ${request.model} content preview (tail) >>>\n${preview.tail}\n<<< [end tail]`);
      }

      yield {
        provider: this.provider,
        model: request.model,
        content: '',
        done: true,
        stopReason,
      };
    } catch (err: any) {
      console.error(`[openai] Stream failed for ${request.model}`, {
        error: err.message ?? 'OpenAI request failed',
      });
      yield {
        provider: this.provider,
        model: request.model,
        content: '',
        done: true,
        error: err.message ?? 'OpenAI request failed',
      };
    }
  }
}
