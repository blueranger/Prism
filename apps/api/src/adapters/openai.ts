import OpenAI from 'openai';
import { LLMProvider, LLMRequest, StreamChunk } from '@prism/shared';
import { LLMAdapter } from './common';

export class OpenAIAdapter extends LLMAdapter {
  provider: LLMProvider = 'openai';
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return this.client;
  }

  async *stream(request: LLMRequest): AsyncGenerator<StreamChunk> {
    try {
      console.log(`[openai] Starting stream for ${request.model} with ${request.messages.length} messages`);

      // Build API parameters
      const params: Record<string, any> = {
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        stream: true,
      };

      // Thinking / reasoning mode
      if (request.thinking?.enabled && request.thinking.effort) {
        params.reasoning_effort = request.thinking.effort;
        // DO NOT include temperature for reasoning models — OpenAI rejects it
        console.log(`[openai] Thinking enabled: reasoning_effort=${request.thinking.effort}`);
      } else if (request.temperature !== undefined) {
        params.temperature = request.temperature;
      }

      const stream = await (this.getClient().chat.completions as any).create(params);
      console.log(`[openai] Stream created for ${request.model}`);

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta as any;

        // Thinking / reasoning content (OpenAI returns this in delta.reasoning or delta.reasoning_content)
        const reasoning = delta?.reasoning ?? delta?.reasoning_content;
        if (reasoning) {
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
          yield {
            provider: this.provider,
            model: request.model,
            content: delta.content,
            done: false,
          };
        }
      }

      yield {
        provider: this.provider,
        model: request.model,
        content: '',
        done: true,
      };
    } catch (err: any) {
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
