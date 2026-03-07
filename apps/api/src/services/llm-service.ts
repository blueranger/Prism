import { LLMRequest, StreamChunk, MODELS, MessageRole, ThinkingConfig } from '@prism/shared';
import { getAdapterForModel } from '../adapters';

export type ChatMessage = { role: MessageRole; content: string };

/**
 * Stream a prompt to a single model with the given context.
 */
export async function* streamSingle(
  model: string,
  messages: ChatMessage[],
  thinking?: ThinkingConfig
): AsyncGenerator<StreamChunk> {
  const config = MODELS[model];
  if (!config) throw new Error(`Unknown model: ${model}`);

  const adapter = getAdapterForModel(model);
  const request: LLMRequest = {
    messages,
    model: config.model,
    provider: config.provider,
    thinking,
  };

  yield* adapter.stream(request);
}

/**
 * Stream a prompt to multiple models in parallel.
 * Accepts either a shared history (original Phase 1 behavior)
 * or per-model context via contextPerModel.
 */
export async function* streamParallel(
  prompt: string,
  models: string[],
  opts: {
    history?: ChatMessage[];
    contextPerModel?: Record<string, ChatMessage[]>;
    thinking?: Record<string, ThinkingConfig>;
  } = {}
): AsyncGenerator<StreamChunk> {
  const { history = [], contextPerModel, thinking } = opts;

  // Create a stream for each model
  const streams = models.map((model) => {
    const config = MODELS[model];
    if (!config) throw new Error(`Unknown model: ${model}`);

    // Use per-model context if provided, otherwise shared history
    let messages: ChatMessage[];
    if (contextPerModel?.[model]) {
      messages = [...contextPerModel[model], { role: 'user' as const, content: prompt }];
    } else {
      messages = [...history, { role: 'user' as const, content: prompt }];
    }

    const adapter = getAdapterForModel(model);
    const request: LLMRequest = {
      messages,
      model: config.model,
      provider: config.provider,
      thinking: thinking?.[model],
    };

    return adapter.stream(request);
  });

  // Interleave chunks from all streams using a shared queue
  const queue: StreamChunk[] = [];
  let activeStreams = streams.length;
  let resolveWait: (() => void) | null = null;

  const readers = streams.map(async (stream, idx) => {
    const modelName = models[idx];
    const modelConfig = MODELS[modelName];
    console.log(`[streamParallel] Reader ${idx} starting for ${modelName}`);
    try {
      let chunkCount = 0;
      for await (const chunk of stream) {
        chunkCount++;
        if (chunkCount === 1) {
          console.log(`[streamParallel] First chunk from ${modelName} (done=${chunk.done}, error=${chunk.error ?? 'none'})`);
        }
        queue.push(chunk);
        resolveWait?.();
      }
      console.log(`[streamParallel] Reader ${idx} (${modelName}) finished, ${chunkCount} chunks`);
    } catch (err: any) {
      console.error(`[streamParallel] Reader ${idx} (${modelName}) error:`, err.message);
      // Use the actual model info so frontend can mark the correct model as done
      queue.push({
        provider: modelConfig?.provider ?? 'openai',
        model: modelName,
        content: '',
        done: true,
        error: err.message,
      });
      resolveWait?.();
    } finally {
      activeStreams--;
      resolveWait?.();
    }
  });

  // Yield chunks as they arrive, with a safety timeout
  const STREAM_TIMEOUT_MS = 120_000; // 2 minutes max per model
  const startTime = Date.now();

  while (activeStreams > 0 || queue.length > 0) {
    if (queue.length > 0) {
      yield queue.shift()!;
    } else {
      // Wait for new chunks with a timeout to prevent hanging forever
      await Promise.race([
        new Promise<void>((resolve) => { resolveWait = resolve; }),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);

      // Safety: if total time exceeds timeout, force-finish remaining streams
      if (Date.now() - startTime > STREAM_TIMEOUT_MS && activeStreams > 0) {
        console.warn(`[llm-service] streamParallel timeout after ${STREAM_TIMEOUT_MS}ms, ${activeStreams} streams still active`);
        // Push done markers for any models that haven't finished
        for (let i = 0; i < models.length; i++) {
          const mName = models[i];
          const mConfig = MODELS[mName];
          // We can't easily track which specific readers are done, so just push timeout errors
          // The frontend will deduplicate via markDone
          queue.push({
            provider: mConfig?.provider ?? 'openai',
            model: mName,
            content: '',
            done: true,
            error: 'Request timed out',
          });
        }
        activeStreams = 0;
        break;
      }
    }
  }

  // Drain any remaining chunks in queue
  while (queue.length > 0) {
    yield queue.shift()!;
  }

  await Promise.allSettled(readers);
}

/**
 * Collect a full (non-streaming) response from a single model.
 * Used when we need the complete text before passing to another stage.
 */
export async function collectSingle(
  model: string,
  messages: ChatMessage[],
  thinking?: ThinkingConfig
): Promise<{ content: string; thinkingContent?: string; error?: string }> {
  let content = '';
  let thinkingContent = '';
  let error: string | undefined;

  for await (const chunk of streamSingle(model, messages, thinking)) {
    if (chunk.error) {
      error = chunk.error;
    }
    content += chunk.content;
    if (chunk.thinkingContent) {
      thinkingContent += chunk.thinkingContent;
    }
  }

  return { content, thinkingContent: thinkingContent || undefined, error };
}

/**
 * Interleave multiple async generators of StreamChunks into one.
 * Used by compare/synthesize to merge critic streams.
 */
export async function* interleaveStreams(
  streams: AsyncGenerator<StreamChunk>[]
): AsyncGenerator<StreamChunk> {
  const queue: StreamChunk[] = [];
  let activeStreams = streams.length;
  let resolveWait: (() => void) | null = null;

  const readers = streams.map(async (stream) => {
    // Peek at the first chunk to get model info for error reporting
    let lastModel = 'unknown';
    let lastProvider: StreamChunk['provider'] = 'openai';
    try {
      for await (const chunk of stream) {
        lastModel = chunk.model;
        lastProvider = chunk.provider;
        queue.push(chunk);
        resolveWait?.();
      }
    } catch (err: any) {
      queue.push({
        provider: lastProvider,
        model: lastModel,
        content: '',
        done: true,
        error: err.message,
      });
      resolveWait?.();
    } finally {
      activeStreams--;
      resolveWait?.();
    }
  });

  const startTime = Date.now();
  const TIMEOUT_MS = 120_000;

  while (activeStreams > 0 || queue.length > 0) {
    if (queue.length > 0) {
      yield queue.shift()!;
    } else {
      await Promise.race([
        new Promise<void>((resolve) => { resolveWait = resolve; }),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);

      if (Date.now() - startTime > TIMEOUT_MS && activeStreams > 0) {
        console.warn(`[llm-service] interleaveStreams timeout, ${activeStreams} streams still active`);
        activeStreams = 0;
        break;
      }
    }
  }

  while (queue.length > 0) {
    yield queue.shift()!;
  }

  await Promise.allSettled(readers);
}
