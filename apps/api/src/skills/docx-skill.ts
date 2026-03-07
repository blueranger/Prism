import fs from 'fs';
import { BaseFileSkill, type FileSkillResult } from './base-skill';
import { fileSkillRegistry } from './registry';
import { summarizeTextWithLLM } from '../utils/vision';

/**
 * DocxSkill — extracts text from Word documents using mammoth.
 */
class DocxSkill extends BaseFileSkill {
  name = 'docx';
  supportedMimeTypes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];

  async process(filePath: string, _mimeType: string): Promise<FileSkillResult> {
    console.log(`[DocxSkill] Processing: ${filePath}`);

    // Dynamic import for mammoth (ESM-compatible)
    let mammoth: any;
    try {
      const mod = await import('mammoth');
      mammoth = mod.default ?? mod;
    } catch {
      throw new Error('mammoth package not installed. Run: npm install mammoth');
    }

    const buffer = fs.readFileSync(filePath);

    const result = await mammoth.extractRawText({ buffer });
    const extractedText = (result.value ?? '').trim();
    const wordCount = extractedText ? extractedText.split(/\s+/).length : 0;

    console.log(`[DocxSkill] Extracted ${extractedText.length} chars (${wordCount} words)`);

    if (!extractedText) {
      return {
        extractedText: '',
        summary: 'The document appears to be empty or contains only images/charts.',
        metadata: { wordCount: 0, method: 'mammoth' },
      };
    }

    const summary = await summarizeTextWithLLM(
      extractedText,
      'You are a document analysis assistant. Provide a concise summary of the following Word document content. ' +
      'Include the main topics, key points, and any important details. Respond in the same language as the document.'
    );

    return {
      extractedText,
      summary,
      metadata: { wordCount, method: 'mammoth' },
    };
  }
}

// Self-register
fileSkillRegistry.register(new DocxSkill());
