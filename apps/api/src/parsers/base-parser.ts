import { ImportedConversation, ImportedMessage, ImportPlatform } from '@prism/shared';

export interface ParseResult {
  conversations: ImportedConversation[];
  messages: ImportedMessage[];
}

export interface ConversationParser {
  platform: ImportPlatform;
  /**
   * Parse the extracted file content into normalized conversations + messages.
   * @param data - The raw JSON data (already parsed from file)
   */
  parse(data: any, batchId: string): ParseResult;
}
