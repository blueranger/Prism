import fs from 'fs';
import AdmZip from 'adm-zip';
import { BaseFileSkill, type FileSkillResult } from './base-skill';
import { fileSkillRegistry } from './registry';
import { summarizeTextWithLLM } from '../utils/vision';

const MAX_SLIDES = 50;

/**
 * PptxSkill — extracts text from PowerPoint presentations.
 * PPTX files are ZIP archives containing XML slides.
 * We extract <a:t> text nodes from each slide XML.
 */
class PptxSkill extends BaseFileSkill {
  name = 'pptx';
  supportedMimeTypes = [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ];

  async process(filePath: string, _mimeType: string): Promise<FileSkillResult> {
    console.log(`[PptxSkill] Processing: ${filePath}`);

    const buffer = fs.readFileSync(filePath);
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    // Find slide XML files and sort by slide number
    const slideEntries = entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => {
        const numA = parseInt(a.entryName.match(/slide(\d+)/)?.[1] ?? '0', 10);
        const numB = parseInt(b.entryName.match(/slide(\d+)/)?.[1] ?? '0', 10);
        return numA - numB;
      })
      .slice(0, MAX_SLIDES);

    const slideCount = slideEntries.length;
    const parts: string[] = [];

    for (let i = 0; i < slideEntries.length; i++) {
      const xml = slideEntries[i].getData().toString('utf8');
      // Extract all <a:t> text nodes (PowerPoint text runs)
      const textNodes = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) ?? [];
      const texts = textNodes.map((node) => {
        const match = node.match(/<a:t[^>]*>([^<]*)<\/a:t>/);
        return match?.[1] ?? '';
      });

      const slideText = texts.join(' ').trim();
      if (slideText) {
        parts.push(`[Slide ${i + 1}]\n${slideText}`);
      }
    }

    // Also try to extract notes
    const noteEntries = entries
      .filter((e) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.entryName))
      .slice(0, MAX_SLIDES);

    const hasNotes = noteEntries.length > 0;

    const extractedText = parts.join('\n\n');

    console.log(`[PptxSkill] Extracted text from ${slideCount} slides`);

    if (!extractedText.trim()) {
      return {
        extractedText: '',
        summary: 'The presentation appears to be empty or contains only images/charts without text.',
        metadata: { slideCount, hasNotes, method: 'xml-extraction' },
      };
    }

    const summary = await summarizeTextWithLLM(
      extractedText,
      'You are a presentation analysis assistant. Summarize the content of this PowerPoint presentation. ' +
      'Describe the main themes, key points per slide, and the overall narrative or structure. ' +
      'Respond in the same language as the presentation content.'
    );

    return {
      extractedText,
      summary,
      metadata: { slideCount, hasNotes, method: 'xml-extraction' },
    };
  }
}

// Self-register
fileSkillRegistry.register(new PptxSkill());
