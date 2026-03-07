/**
 * Embedding Service
 *
 * Generates and manages vector embeddings using OpenAI's embedding models.
 * Provides utilities for embedding storage, retrieval, and similarity computation.
 */

import { OpenAI } from 'openai';

/**
 * Lazy-initialized OpenAI client (avoids crash when env var isn't loaded yet)
 */
let _openaiClient: OpenAI | null = null;
function getOpenAIClient(): OpenAI {
  if (!_openaiClient) {
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openaiClient;
}

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1536', 10);
const BATCH_SIZE = 2048; // Max texts per API call
const RETRY_ATTEMPTS = 1;
const RETRY_DELAY_MS = 1000;

/**
 * Logs a message with embedding service prefix
 */
function log(message: string, ...args: unknown[]): void {
  console.log(`[embedding] ${message}`, ...args);
}

/**
 * Logs an error with embedding service prefix
 */
function logError(message: string, ...args: unknown[]): void {
  console.error(`[embedding] ERROR: ${message}`, ...args);
}

/**
 * Sleeps for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gets an embedding for a single text string.
 * Includes retry logic on failure.
 *
 * @param text - The text to embed
 * @returns Embedding as Float32Array (1536 dimensions for text-embedding-3-small)
 * @throws Error if embedding fails after retries
 *
 * @example
 * const embedding = await getEmbedding("Hello, world!");
 * console.log(embedding.length); // 1536
 */
export async function getEmbedding(text: string): Promise<Float32Array> {
  const embeddings = await getEmbeddings([text]);
  return embeddings[0];
}

/**
 * Gets embeddings for multiple text strings in batch.
 * Automatically splits into batches if more than 2048 texts.
 * Includes retry logic on failure.
 *
 * @param texts - Array of texts to embed
 * @returns Array of embeddings (Float32Array), in same order as input
 * @throws Error if all retry attempts fail
 *
 * @example
 * const embeddings = await getEmbeddings(["text1", "text2", "text3"]);
 * console.log(embeddings.length); // 3
 */
export async function getEmbeddings(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) {
    return [];
  }

  log(`Generating embeddings for ${texts.length} text(s) using ${EMBEDDING_MODEL}`);

  const allEmbeddings: Float32Array[] = [];

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, Math.min(i + BATCH_SIZE, texts.length));
    const batchEmbeddings = await getEmbeddingsBatch(batch);
    allEmbeddings.push(...batchEmbeddings);
  }

  log(`Successfully generated ${allEmbeddings.length} embedding(s)`);
  return allEmbeddings;
}

/**
 * Gets embeddings for a single batch (up to 2048 texts).
 * Includes retry logic.
 *
 * @param texts - Batch of texts (max 2048)
 * @returns Array of embeddings
 * @throws Error if all retries fail
 */
async function getEmbeddingsBatch(texts: string[]): Promise<Float32Array[]> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await getOpenAIClient().embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
      });

      // Convert embeddings to Float32Array
      const embeddings: Float32Array[] = response.data
        .sort((a, b) => a.index - b.index) // Ensure correct order
        .map((item) => new Float32Array(item.embedding));

      log(`Batch processed: ${texts.length} texts -> ${embeddings.length} embeddings`);
      return embeddings;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logError(`Attempt ${attempt + 1}/${RETRY_ATTEMPTS + 1} failed: ${lastError.message}`);

      if (attempt < RETRY_ATTEMPTS) {
        log(`Retrying in ${RETRY_DELAY_MS}ms...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(
    `Failed to generate embeddings after ${RETRY_ATTEMPTS + 1} attempts: ${lastError?.message}`
  );
}

/**
 * Computes cosine similarity between two embeddings.
 * Result ranges from -1 (opposite) to 1 (identical).
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @returns Cosine similarity score (-1 to 1)
 * @throws Error if vectors have different lengths
 *
 * @example
 * const similarity = cosineSimilarity(embedding1, embedding2);
 * console.log(similarity); // 0.95
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0; // Handle zero vectors
  }

  return dotProduct / (normA * normB);
}

/**
 * Converts a Float32Array embedding to a Buffer for SQLite BLOB storage.
 *
 * Format:
 * - 4 bytes: length (uint32, big-endian)
 * - N*4 bytes: floating point values (float32, big-endian)
 *
 * @param embedding - Float32Array to convert
 * @returns Buffer suitable for database storage
 *
 * @example
 * const buffer = embeddingToBuffer(embedding);
 * // Store in SQLite BLOB column
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
  const length = embedding.length;
  const buffer = Buffer.alloc(4 + length * 4);

  // Write length as uint32 big-endian
  buffer.writeUInt32BE(length, 0);

  // Write float32 values big-endian
  for (let i = 0; i < length; i++) {
    buffer.writeFloatBE(embedding[i], 4 + i * 4);
  }

  return buffer;
}

/**
 * Converts a Buffer (from SQLite BLOB) back to a Float32Array embedding.
 *
 * @param buffer - Buffer containing embedded data
 * @returns Reconstructed Float32Array
 * @throws Error if buffer is malformed
 *
 * @example
 * const embedding = bufferToEmbedding(buffer);
 * console.log(embedding.length); // 1536
 */
export function bufferToEmbedding(buffer: Buffer): Float32Array {
  if (buffer.length < 4) {
    throw new Error(`Invalid embedding buffer: too short (${buffer.length} bytes)`);
  }

  const length = buffer.readUInt32BE(0);
  const expectedLength = 4 + length * 4;

  if (buffer.length !== expectedLength) {
    throw new Error(
      `Invalid embedding buffer: expected ${expectedLength} bytes, got ${buffer.length}`
    );
  }

  const embedding = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    embedding[i] = buffer.readFloatBE(4 + i * 4);
  }

  return embedding;
}

/**
 * Gets basic information about the embedding configuration.
 *
 * @returns Configuration details
 */
export function getEmbeddingConfig(): {
  model: string;
  dimensions: number;
  batchSize: number;
} {
  return {
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    batchSize: BATCH_SIZE,
  };
}
