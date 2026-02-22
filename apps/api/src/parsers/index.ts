import { ImportPlatform } from '@prism/shared';
import { ConversationParser } from './base-parser';
import { ChatGPTParser } from './chatgpt-parser';
import { ClaudeParser } from './claude-parser';
import { GeminiParser } from './gemini-parser';

const parsers: Record<ImportPlatform, ConversationParser> = {
  chatgpt: new ChatGPTParser(),
  claude: new ClaudeParser(),
  gemini: new GeminiParser(),
};

export function getParser(platform: ImportPlatform): ConversationParser {
  const parser = parsers[platform];
  if (!parser) throw new Error(`Unknown platform: ${platform}`);
  return parser;
}

export { ConversationParser, ParseResult } from './base-parser';
