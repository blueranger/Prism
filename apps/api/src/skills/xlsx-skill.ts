import fs from 'fs';
import { BaseFileSkill, type FileSkillResult } from './base-skill';
import { fileSkillRegistry } from './registry';
import { summarizeTextWithLLM } from '../utils/vision';

const MAX_ROWS_PER_SHEET = 50;

/**
 * XlsxSkill — extracts data from Excel spreadsheets using SheetJS (xlsx).
 */
class XlsxSkill extends BaseFileSkill {
  name = 'xlsx';
  supportedMimeTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];

  async process(filePath: string, _mimeType: string): Promise<FileSkillResult> {
    console.log(`[XlsxSkill] Processing: ${filePath}`);

    // Dynamic import for xlsx
    let XLSX: any;
    try {
      const mod = await import('xlsx');
      XLSX = mod.default ?? mod;
    } catch {
      throw new Error('xlsx package not installed. Run: npm install xlsx');
    }

    const buffer = fs.readFileSync(filePath);
    const workbook = XLSX.read(buffer, { type: 'buffer' });

    const sheetNames = workbook.SheetNames as string[];
    const sheetCount = sheetNames.length;
    let totalRows = 0;
    const parts: string[] = [];

    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName];
      // Convert to array of arrays
      const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      totalRows += rows.length;

      // Take headers + first N rows
      const display = rows.slice(0, MAX_ROWS_PER_SHEET + 1); // +1 for header
      const truncated = rows.length > MAX_ROWS_PER_SHEET + 1;

      // Format as tab-separated text
      const formatted = display
        .map((row: any[]) => row.map((cell: any) => String(cell ?? '')).join('\t'))
        .join('\n');

      parts.push(
        `=== Sheet: ${sheetName} (${rows.length} rows) ===\n` +
        formatted +
        (truncated ? `\n... (${rows.length - MAX_ROWS_PER_SHEET - 1} more rows truncated)` : '')
      );
    }

    const extractedText = parts.join('\n\n');

    console.log(`[XlsxSkill] Extracted ${sheetCount} sheets, ${totalRows} total rows`);

    if (!extractedText.trim()) {
      return {
        extractedText: '',
        summary: 'The spreadsheet appears to be empty.',
        metadata: { sheetCount, totalRows: 0, method: 'sheetjs' },
      };
    }

    const summary = await summarizeTextWithLLM(
      extractedText,
      'You are a spreadsheet analysis assistant. Summarize the content of this Excel spreadsheet. ' +
      'Describe the sheets, columns, data patterns, and any key insights visible from the data. ' +
      'Respond in the same language as the spreadsheet content.'
    );

    return {
      extractedText,
      summary,
      metadata: { sheetCount, totalRows, method: 'sheetjs' },
    };
  }
}

// Self-register
fileSkillRegistry.register(new XlsxSkill());
