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
      let stopReason: string | undefined;
      let chunkCount = 0;
      let contentChars = 0;
      let thinkingChars = 0;

      for await (const event of stream) {
        chunkCount += 1;
        if (event.type === 'message_delta') {
          const delta = (event as any).delta;
          if (delta?.stop_reason) {
            stopReason = String(delta.stop_reason);
          }
        }
        if (event.type === 'content_block_delta') {
          const delta = event.delta as any;

          if (delta.type === 'thinking_delta' && delta.thinking) {
            thinkingChars += String(delta.thinking).length;
            // Extended thinking content
            yield {
              provider: this.provider,
              model: request.model,
              content: '',
              done: false,
              thinkingContent: delta.thinking,
            };
          } else if (delta.type === 'text_delta') {
            contentChars += String(delta.text).length;
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
      console.log(`[anthropic] Stream finished for ${request.model}`, {
        chunkCount,
        contentChars,
        thinkingChars,
        stopReason: stopReason ?? (finalMessage as any).stop_reason ?? undefined,
      });
      yield {
        provider: this.provider,
        model: request.model,
        content: '',
        done: true,
        stopReason: stopReason ?? (finalMessage as any).stop_reason ?? undefined,
        usage: {
          promptTokens: finalMessage.usage.input_tokens,
          completionTokens: finalMessage.usage.output_tokens,
        },
      };
    } catch (err: any) {
      console.error(`[anthropic] Stream failed for ${request.model}`, {
        error: err.message ?? 'Anthropic request failed',
      });
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
