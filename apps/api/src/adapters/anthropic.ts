import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, LLMRequest, StreamChunk } from '@prism/shared';
import { LLMAdapter } from './common';

export class AnthropicAdapter extends LLMAdapter {
  provider: LLMProvider = 'anthropic';
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return this.client;
  }

  async *stream(request: LLMRequest): AsyncGenerator<StreamChunk> {
    try {
      console.log(`[anthropic] Starting stream for ${request.model} with ${request.messages.length} messages`);
      const systemMessage = request.messages.find((m) => m.role === 'system');
      const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

      // Build API parameters
      const params: Record<string, any> = {
        model: request.model,
        max_tokens: request.maxTokens ?? 4096,
        system: systemMessage?.content,
        messages: nonSystemMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      };

      // Extended thinking mode
      if (request.thinking?.enabled && request.thinking.budgetTokens) {
        params.thinking = {
          type: 'enabled',
          budget_tokens: request.thinking.budgetTokens,
        };
        // Anthropic requires temperature=1 when thinking is enabled
        params.temperature = 1;
        console.log(`[anthropic] Extended thinking enabled: budget_tokens=${request.thinking.budgetTokens}`);
      } else if (request.temperature !== undefined) {
        params.temperature = request.temperature;
      }

      const stream = this.getClient().messages.stream(params as any);

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          const delta = event.delta as any;

          if (delta.type === 'thinking_delta' && delta.thinking) {
            // Extended thinking content
            yield {
              provider: this.provider,
              model: request.model,
              content: '',
              done: false,
              thinkingContent: delta.thinking,
            };
          } else if (delta.type === 'text_delta') {
            // Regular response content
            yield {
              provider: this.provider,
              model: request.model,
              content: delta.text,
              done: false,
            };
          }
        }
      }

      const finalMessage = await stream.finalMessage();
      yield {
        provider: this.provider,
        model: request.model,
        content: '',
        done: true,
        usage: {
          promptTokens: finalMessage.usage.input_tokens,
          completionTokens: finalMessage.usage.output_tokens,
        },
      };
    } catch (err: any) {
      yield {
        provider: this.provider,
        model: request.model,
        content: '',
        done: true,
        error: err.message ?? 'Anthropic request failed',
      };
    }
  }
}
