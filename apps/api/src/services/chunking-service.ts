/**
 * Text Chunking Service for RAG Indexing
 *
 * Splits text into overlapping chunks suitable for retrieval-augmented generation (RAG).
 * Uses intelligent boundary detection (paragraphs, sentences) to preserve semantic coherence.
 */

/**
 * Options for chunking behavior.
 */
export interface ChunkOptions {
  /**
   * Maximum tokens per chunk. Default: 500
   */
  maxTokens?: number;
  /**
   * Number of overlapping tokens between consecutive chunks. Default: 100
   */
  overlapTokens?: number;
}

/**
 * Represents a single text chunk with metadata.
 */
export interface TextChunkData {
  /**
   * The actual text content of the chunk.
   */
  content: string;
  /**
   * Character offset in the original text where this chunk begins.
   */
  startOffset: number;
  /**
   * Character offset in the original text where this chunk ends.
   */
  endOffset: number;
  /**
   * Estimated token count for this chunk.
   */
  tokenCount: number;
  /**
   * Sequential index of this chunk (0-based).
   */
  chunkIndex: number;
}

/**
 * Estimates token count using a simple heuristic.
 * For English text: ~1 token per 4 characters (on average).
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Finds the best split point for a chunk, preferring semantic boundaries.
 * Priority: paragraph break (\n\n) > line break (\n) > sentence end (. )
 *
 * @param text - The text to find a split point in
 * @param maxOffset - The maximum character offset to search within
 * @returns The character offset of the best split point, or -1 if not found
 */
function findSplitPoint(text: string, maxOffset: number): number {
  const searchText = text.substring(0, maxOffset);

  // Try paragraph boundary first (\n\n)
  const paragraphIdx = searchText.lastIndexOf('\n\n');
  if (paragraphIdx !== -1) {
    return paragraphIdx + 2; // Skip the \n\n
  }

  // Try line break second (\n)
  const lineIdx = searchText.lastIndexOf('\n');
  if (lineIdx !== -1) {
    return lineIdx + 1; // Skip the \n
  }

  // Try sentence boundary third (. followed by space)
  const sentenceIdx = searchText.lastIndexOf('. ');
  if (sentenceIdx !== -1) {
    return sentenceIdx + 2; // Skip the '. '
  }

  // Fallback: just split at maxOffset
  return maxOffset;
}

/**
 * Splits text into overlapping chunks suitable for RAG indexing.
 *
 * The chunking algorithm:
 * 1. Estimates token count from character length (1 token ≈ 4 chars)
 * 2. Creates overlapping chunks (default 500 tokens per chunk, 100 tokens overlap)
 * 3. Prefers semantic boundaries (paragraphs, sentences) over hard cuts
 * 4. Handles edge cases (empty text, very short text)
 *
 * @param text - The text to chunk
 * @param opts - Chunking options
 * @returns Array of text chunks with metadata
 *
 * @example
 * const chunks = chunkText("Long document text...", { maxTokens: 500, overlapTokens: 100 });
 * console.log(chunks[0].content); // First chunk content
 */
export function chunkText(text: string, opts?: ChunkOptions): TextChunkData[] {
  const maxTokens = opts?.maxTokens ?? 500;
  const overlapTokens = opts?.overlapTokens ?? 100;

  // Handle empty or very short text
  if (!text || text.trim().length === 0) {
    return [];
  }

  const totalTokens = estimateTokenCount(text);

  // If text is shorter than max chunk size, return as single chunk
  if (totalTokens <= maxTokens) {
    return [
      {
        content: text,
        startOffset: 0,
        endOffset: text.length,
        tokenCount: totalTokens,
        chunkIndex: 0,
      },
    ];
  }

  const chunks: TextChunkData[] = [];

  // Convert token counts to approximate character offsets (4 chars per token)
  const maxCharsPerChunk = maxTokens * 4;
  const overlapChars = overlapTokens * 4;

  let currentOffset = 0;
  let chunkIndex = 0;

  while (currentOffset < text.length) {
    // Calculate the end of this chunk
    let endOffset = Math.min(currentOffset + maxCharsPerChunk, text.length);

    // If we're not at the end of the text, try to find a better split point
    if (endOffset < text.length) {
      const splitPoint = findSplitPoint(text, endOffset);
      if (splitPoint > currentOffset) {
        endOffset = splitPoint;
      }
    }

    const chunkContent = text.substring(currentOffset, endOffset);
    const chunkTokens = estimateTokenCount(chunkContent);

    chunks.push({
      content: chunkContent,
      startOffset: currentOffset,
      endOffset: endOffset,
      tokenCount: chunkTokens,
      chunkIndex: chunkIndex,
    });

    // Move to next chunk, accounting for overlap
    const moveByChars = Math.max(1, maxCharsPerChunk - overlapChars);
    currentOffset += moveByChars;
    chunkIndex++;

    // Prevent infinite loops on very small overlap
    if (currentOffset >= text.length) {
      break;
    }
  }

  return chunks;
}
