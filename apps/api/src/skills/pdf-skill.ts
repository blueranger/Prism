import fs from 'fs';
import { BaseFileSkill, type FileSkillResult } from './base-skill';
import { fileSkillRegistry } from './registry';
import { analyzeImageWithVision, summarizeTextWithLLM } from '../utils/vision';

const MIN_TEXT_LENGTH = 100; // Below this, treat as scanned/image PDF
const MAX_PAGES = parseInt(process.env.FILE_ANALYSIS_MAX_PAGES ?? '20', 10);

/**
 * PdfSkill — extracts text from PDFs using pdf-parse.
 * Falls back to vision OCR for scanned documents (low text content).
 */
class PdfSkill extends BaseFileSkill {
  name = 'pdf';
  supportedMimeTypes = ['application/pdf'];

  async process(filePath: string, _mimeType: string): Promise<FileSkillResult> {
    console.log(`[PdfSkill] Processing: ${filePath}`);

    // Dynamic import for pdf-parse (CommonJS module).
    // Import from lib/pdf-parse directly to avoid the debug-mode auto-run in index.js
    // which tries to read a test PDF file and crashes.
    let pdfParse: any;
    try {
      const mod = await import('pdf-parse/lib/pdf-parse.js');
      pdfParse = mod.default ?? mod;
    } catch {
      throw new Error('pdf-parse package not installed. Run: npm install pdf-parse@1.1.1');
    }

    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer, { max: MAX_PAGES });

    const extractedText = (data.text ?? '').trim();
    const pageCount = data.numpages ?? 0;

    console.log(`[PdfSkill] Extracted ${extractedText.length} chars from ${pageCount} pages`);

    // If very little text was extracted, this is likely a scanned document
    if (extractedText.length < MIN_TEXT_LENGTH) {
      console.log('[PdfSkill] Low text content — falling back to vision OCR');
      return this.processWithVision(buffer, pageCount);
    }

    // Summarize the extracted text using the text model
    const summary = await summarizeTextWithLLM(
      extractedText,
      'You are a document analysis assistant. Provide a concise summary of the following document content. ' +
      'Include the main topics, key points, and any important details. Respond in the same language as the document.'
    );

    return {
      extractedText,
      summary,
      metadata: { pageCount, method: 'text-extraction' },
    };
  }

  /**
   * For scanned PDFs: convert first page to base64 and use vision model.
   */
  private async processWithVision(buffer: Buffer, pageCount: number): Promise<FileSkillResult> {
    // Send the raw PDF buffer as base64 to the vision model
    // Most vision models (GPT-4o, Gemini) can handle PDF pages as images
    const base64 = buffer.toString('base64');

    const prompt =
      'This is a scanned PDF document. Please:\n' +
      '1. Extract all text content (OCR)\n' +
      '2. Describe any images, tables, or diagrams\n' +
      '3. Provide a brief summary of the document\n\n' +
      'Format your response as:\n' +
      '## Extracted Text\n[all text content]\n\n' +
      '## Summary\n[brief summary]';

    const result = await analyzeImageWithVision(base64, 'application/pdf', prompt);

    // Parse the result to separate extracted text and summary
    const textMatch = result.match(/## Extracted Text\n([\s\S]*?)(?=\n## Summary|$)/);
    const summaryMatch = result.match(/## Summary\n([\s\S]*?)$/);

    const extractedText = textMatch?.[1]?.trim() ?? result;
    const summary = summaryMatch?.[1]?.trim() ?? 'Scanned document processed with OCR.';

    return {
      extractedText,
      summary,
      metadata: { pageCount, method: 'vision-ocr' },
    };
  }
}

// Self-register
fileSkillRegistry.register(new PdfSkill());
