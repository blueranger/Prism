/**
 * Base class for file processing skills.
 *
 * Each skill handles one or more MIME types and knows how to extract
 * text and produce a summary from the file content.
 */

export interface FileSkillResult {
  /** Raw extracted text from the file */
  extractedText: string;
  /** AI-generated summary of the file content */
  summary: string;
  /** Optional metadata (page count, dimensions, etc.) */
  metadata?: Record<string, unknown>;
}

export abstract class BaseFileSkill {
  abstract name: string;
  abstract supportedMimeTypes: string[];

  /**
   * Process a file and return extracted text + summary.
   */
  abstract process(filePath: string, mimeType: string): Promise<FileSkillResult>;

  /**
   * Check if this skill can handle the given MIME type.
   */
  canHandle(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType);
  }
}
