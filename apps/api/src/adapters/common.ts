import { LLMProvider, LLMRequest, StreamChunk } from '@prism/shared';

export abstract class LLMAdapter {
  abstract provider: LLMProvider;

  abstract stream(request: LLMRequest): AsyncGenerator<StreamChunk>;
}
