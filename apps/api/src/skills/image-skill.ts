import fs from 'fs';
import { BaseFileSkill, type FileSkillResult } from './base-skill';
import { fileSkillRegistry } from './registry';
import { analyzeImageWithVision } from '../utils/vision';

/**
 * ImageSkill — analyzes images using a vision-capable LLM.
 * Handles OCR for scanned documents and general image interpretation.
 */
class ImageSkill extends BaseFileSkill {
  name = 'image';
  supportedMimeTypes = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ];

  async process(filePath: string, mimeType: string): Promise<FileSkillResult> {
    console.log(`[ImageSkill] Processing: ${filePath} (${mimeType})`);

    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    const fileSize = buffer.length;

    const prompt =
      'Analyze this image thoroughly. Please:\n' +
      '1. If it contains text (document, screenshot, scan), extract ALL text content (OCR)\n' +
      '2. Describe visual elements (diagrams, charts, photos, etc.)\n' +
      '3. Provide a concise summary of the content and purpose of this image\n\n' +
      'Format your response as:\n' +
      '## Extracted Text\n[any text found in the image, or "No text content" if none]\n\n' +
      '## Description\n[visual description]\n\n' +
      '## Summary\n[brief summary of what this image is about]';

    const result = await analyzeImageWithVision(base64, mimeType, prompt);

    // Parse structured response
    const textMatch = result.match(/## Extracted Text\n([\s\S]*?)(?=\n## Description|$)/);
    const summaryMatch = result.match(/## Summary\n([\s\S]*?)$/);

    const extractedText = textMatch?.[1]?.trim() ?? '';
    const hasText = extractedText && extractedText.toLowerCase() !== 'no text content';
    const summary = summaryMatch?.[1]?.trim() ?? result.slice(0, 500);

    return {
      extractedText: hasText ? extractedText : result,
      summary,
      metadata: {
        mimeType,
        fileSize,
        method: 'vision',
        hasTextContent: hasText,
      },
    };
  }
}

// Self-register
fileSkillRegistry.register(new ImageSkill());
