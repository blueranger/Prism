/**
 * Vision utility — sends images to a vision-capable LLM for OCR / interpretation.
 *
 * Bypasses the existing text-only adapter layer; calls SDKs directly.
 * The model is configured via FILE_ANALYSIS_VISION_MODEL env var.
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

type VisionProvider = 'openai' | 'anthropic' | 'google';

interface VisionConfig {
  provider: VisionProvider;
  model: string;
}

/**
 * Infer provider from model name.
 */
function parseVisionModel(modelStr: string): VisionConfig {
  const model = modelStr.trim();
  if (model.startsWith('gpt-') || model.startsWith('o')) {
    return { provider: 'openai', model };
  }
  if (model.startsWith('claude-')) {
    return { provider: 'anthropic', model };
  }
  if (model.startsWith('gemini-')) {
    return { provider: 'google', model };
  }
  // Default to OpenAI
  return { provider: 'openai', model };
}

/**
 * Analyze an image using the configured vision model.
 *
 * @param base64 - Base64-encoded image data (no data: prefix)
 * @param mimeType - e.g. 'image/png', 'image/jpeg'
 * @param prompt - The instruction for the vision model
 * @returns The model's text response
 */
export async function analyzeImageWithVision(
  base64: string,
  mimeType: string,
  prompt: string
): Promise<string> {
  const modelStr = process.env.FILE_ANALYSIS_VISION_MODEL ?? 'gpt-4o';
  const config = parseVisionModel(modelStr);

  console.log(`[vision] Analyzing image with ${config.provider}/${config.model}`);

  switch (config.provider) {
    case 'openai':
      return analyzeWithOpenAI(base64, mimeType, prompt, config.model);
    case 'anthropic':
      return analyzeWithAnthropic(base64, mimeType, prompt, config.model);
    case 'google':
      return analyzeWithGoogle(base64, mimeType, prompt, config.model);
    default:
      throw new Error(`Unsupported vision provider: ${config.provider}`);
  }
}

/**
 * Generate a text summary using the configured text model.
 * Used for summarizing already-extracted text (no vision needed).
 */
export async function summarizeTextWithLLM(text: string, prompt: string): Promise<string> {
  const modelStr = process.env.FILE_ANALYSIS_TEXT_MODEL ?? process.env.FILE_ANALYSIS_VISION_MODEL ?? 'gpt-4o-mini';
  const config = parseVisionModel(modelStr);

  console.log(`[vision] Summarizing text with ${config.provider}/${config.model}`);

  switch (config.provider) {
    case 'openai': {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: text.slice(0, 50000) },
        ],
        max_tokens: 2000,
      });
      return response.choices[0]?.message?.content ?? '';
    }
    case 'anthropic': {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: config.model,
        max_tokens: 2000,
        system: prompt,
        messages: [{ role: 'user', content: text.slice(0, 50000) }],
      });
      const block = response.content[0];
      return block.type === 'text' ? block.text : '';
    }
    case 'google': {
      const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY ?? '');
      const model = genAI.getGenerativeModel({ model: config.model });
      const result = await model.generateContent([prompt + '\n\n' + text.slice(0, 50000)]);
      return result.response.text();
    }
    default:
      throw new Error(`Unsupported text provider: ${config.provider}`);
  }
}

// --- Provider-specific implementations ---

async function analyzeWithOpenAI(
  base64: string,
  mimeType: string,
  prompt: string,
  model: string
): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
            },
          },
        ],
      },
    ],
    max_tokens: 4000,
  });

  return response.choices[0]?.message?.content ?? '';
}

async function analyzeWithAnthropic(
  base64: string,
  mimeType: string,
  prompt: string,
  model: string
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Anthropic only supports specific media types
  const supportedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const mediaType = supportedTypes.includes(mimeType) ? mimeType : 'image/png';

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: base64,
            },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const block = response.content[0];
  return block.type === 'text' ? block.text : '';
}

async function analyzeWithGoogle(
  base64: string,
  mimeType: string,
  prompt: string,
  model: string
): Promise<string> {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY ?? '');
  const genModel = genAI.getGenerativeModel({ model });

  const result = await genModel.generateContent([
    prompt,
    {
      inlineData: {
        mimeType,
        data: base64,
      },
    },
  ]);

  return result.response.text();
}
