import type { RichPreviewArtifact, RichPreviewExtractionSource, RichPreviewKind } from '@prism/shared';

export interface RichPreviewExtraction {
  kind: RichPreviewKind | null;
  document: string | null;
  source: RichPreviewExtractionSource | null;
  hasLeadingText: boolean;
  hasTrailingText: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
}

export interface StructuredOutputIssue {
  kind:
    | 'missing_head'
    | 'missing_tail'
    | 'broken_fence'
    | 'mixed_explanation_plus_code'
    | 'html_with_embedded_svg'
    | 'standalone_svg'
    | 'continuation_patch';
  category: 'html' | 'svg' | 'fenced';
  title: string;
  reason: string;
}

export interface ContinuationMergeResult {
  mergedContent: string;
  patchContent: string;
}

export interface StructuredOutputRepairResult {
  issue: StructuredOutputIssue | null;
  displayContent: string;
  mergedWithPrevious: boolean;
  recoveredHeader: boolean;
  recoveredTail: boolean;
}

export function isRichLikeContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return (
    /```(?:html|svg)/i.test(trimmed) ||
    /```[\s\S]*?(?:<!DOCTYPE html|<html[\s>]|<svg[\s>]|<style[\s>]|<body[\s>]|<head[\s>]|<(?:div|section|main|article|header|footer|nav)[\s>])/i.test(trimmed) ||
    /<!DOCTYPE html/i.test(trimmed) ||
    /<html[\s>]/i.test(trimmed) ||
    /<svg[\s>]/i.test(trimmed) ||
    /<(?:head|body|style|meta|title|div|section|main|article|header|footer|nav)[\s>]/i.test(trimmed)
  );
}

interface Candidate {
  kind: RichPreviewKind;
  document: string;
  source: RichPreviewExtractionSource;
  start: number;
  end: number;
  score: number;
}

const PRIORITY: Record<RichPreviewExtractionSource, number> = {
  fenced: 400,
  'raw-html': 300,
  'raw-svg': 200,
  manual: 100,
};

function getAllMatches(regex: RegExp, content: string, map: (match: RegExpExecArray) => Candidate | null): Candidate[] {
  const matches: Candidate[] = [];
  const cloned = new RegExp(regex.source, regex.flags);
  let match: RegExpExecArray | null;
  while ((match = cloned.exec(content)) !== null) {
    const candidate = map(match);
    if (candidate) matches.push(candidate);
  }
  return matches;
}

function buildExtraction(candidate: Candidate, content: string): RichPreviewExtraction {
  return {
    kind: candidate.kind,
    document: candidate.document,
    source: candidate.source,
    hasLeadingText: content.slice(0, candidate.start).trim().length > 0,
    hasTrailingText: content.slice(candidate.end).trim().length > 0,
    selectionStart: candidate.start,
    selectionEnd: candidate.end,
  };
}

export function extractRichPreview(content: string): RichPreviewExtraction {
  if (!content.trim()) {
    return {
      kind: null,
      document: null,
      source: null,
      hasLeadingText: false,
      hasTrailingText: false,
      selectionStart: null,
      selectionEnd: null,
    };
  }

  const candidates: Candidate[] = [
    ...getAllMatches(/```html\s*([\s\S]*?)```/gi, content, (match) => ({
      kind: 'html',
      document: (match[1] ?? '').trim(),
      source: 'fenced',
      start: match.index,
      end: match.index + match[0].length,
      score: PRIORITY.fenced + (match[1]?.length ?? 0),
    })),
    ...getAllMatches(/```svg\s*([\s\S]*?)```/gi, content, (match) => ({
      kind: 'svg',
      document: (match[1] ?? '').trim(),
      source: 'fenced',
      start: match.index,
      end: match.index + match[0].length,
      score: PRIORITY.fenced + (match[1]?.length ?? 0) - 50,
    })),
    ...getAllMatches(/<!DOCTYPE html[\s\S]*?<\/html>/gi, content, (match) => ({
      kind: 'html',
      document: match[0].trim(),
      source: 'raw-html',
      start: match.index,
      end: match.index + match[0].length,
      score: PRIORITY['raw-html'] + match[0].length,
    })),
    ...getAllMatches(/<html[\s\S]*?<\/html>/gi, content, (match) => ({
      kind: 'html',
      document: match[0].trim(),
      source: 'raw-html',
      start: match.index,
      end: match.index + match[0].length,
      score: PRIORITY['raw-html'] + match[0].length - 10,
    })),
    ...getAllMatches(/<svg\b[\s\S]*?<\/svg>/gi, content, (match) => ({
      kind: 'svg',
      document: match[0].trim(),
      source: 'raw-svg',
      start: match.index,
      end: match.index + match[0].length,
      score: PRIORITY['raw-svg'] + match[0].length,
    })),
    ...getAllMatches(/<!DOCTYPE html[\s\S]*$/gi, content, (match) => ({
      kind: 'html',
      document: match[0].trim(),
      source: 'raw-html',
      start: match.index,
      end: content.length,
      score: PRIORITY['raw-html'] + match[0].length - 40,
    })),
    ...getAllMatches(/<html[\s\S]*$/gi, content, (match) => ({
      kind: 'html',
      document: match[0].trim(),
      source: 'raw-html',
      start: match.index,
      end: content.length,
      score: PRIORITY['raw-html'] + match[0].length - 60,
    })),
    ...getAllMatches(/<svg\b[\s\S]*$/gi, content, (match) => ({
      kind: 'svg',
      document: match[0].trim(),
      source: 'raw-svg',
      start: match.index,
      end: content.length,
      score: PRIORITY['raw-svg'] + match[0].length - 60,
    })),
  ].filter((candidate) => candidate.document.trim().length > 0);

  if (candidates.length === 0) {
    return {
      kind: null,
      document: null,
      source: null,
      hasLeadingText: false,
      hasTrailingText: false,
      selectionStart: null,
      selectionEnd: null,
    };
  }

  candidates.sort((a, b) => b.score - a.score);
  return buildExtraction(candidates[0], content);
}

function extractGenericFencedBlock(content: string): string | null {
  const match = content.match(/```(?:html|svg)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() || null;
}

function extractCodeishTail(content: string): string | null {
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return /^(?:<!DOCTYPE html|<html[\s>]|<\/?[a-zA-Z][^>]*>|[.#@a-zA-Z_-][\w\s:>#.,\-\[\]="'()]*\{|\/\*|<!--|-->|@media|[{}]|[a-z-]+\s*:|x\d+=|cx=|cy=)/.test(trimmed);
  });
  if (startIndex === -1) return null;
  return lines.slice(startIndex).join('\n').trim() || null;
}

function normalizeContinuationPatch(content: string): string | null {
  const fenced = extractGenericFencedBlock(content);
  if (fenced) return fenced;

  const codeish = extractCodeishTail(content);
  if (!codeish) return null;

  return codeish
    .replace(/^(?:以上就是[\s\S]{0,240}?完整[\s\S]{0,240}?(?:貼在|接續|運作)[\s\S]*?\n)+/i, '')
    .replace(/^(?:[-=]{3,}\s*)+/g, '')
    .replace(/\n{2,}(?:以上就是|整份文件包含：|所有視覺元素皆為|將這段貼在)[\s\S]*$/i, '')
    .trim();
}

function computeOverlapSuffixPrefix(base: string, patch: string, maxWindow = 1200): number {
  const baseTail = base.slice(-maxWindow);
  const max = Math.min(baseTail.length, patch.length);
  for (let len = max; len >= 24; len -= 1) {
    if (baseTail.slice(-len) === patch.slice(0, len)) return len;
  }
  return 0;
}

export function mergeStructuredContinuation(previousContent: string, continuationContent: string): ContinuationMergeResult | null {
  const previousIssue = detectStructuredOutputIssue(previousContent);
  if (!previousIssue) return null;

  const patch = normalizeContinuationPatch(continuationContent);
  if (!patch) return null;

  const overlap = computeOverlapSuffixPrefix(previousContent, patch);
  const mergedContent = `${previousContent}${overlap > 0 ? patch.slice(overlap) : patch}`;
  return {
    mergedContent,
    patchContent: patch,
  };
}

function recoverMissingHead(previousContent: string, currentContent: string): string | null {
  const prevTrimmed = previousContent.trim();
  const currTrimmed = currentContent.trim();
  if (!prevTrimmed || !currTrimmed) return null;

  const hasCurrentHtmlStart = /^(?:<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<style[\s>]|<svg[\s>])/i.test(currTrimmed);
  const previousLooksLikeHeader = /(?:<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<style[\s>])/i.test(prevTrimmed);
  if (hasCurrentHtmlStart || !previousLooksLikeHeader) return null;

  const splitPoints = [
    prevTrimmed.lastIndexOf('<svg'),
    prevTrimmed.lastIndexOf('<div'),
    prevTrimmed.lastIndexOf('<body'),
    prevTrimmed.lastIndexOf('<html'),
    prevTrimmed.lastIndexOf('<!DOCTYPE html'),
  ].filter((value) => value >= 0);
  const headerEnd = splitPoints.length > 0 ? Math.min(...splitPoints) : prevTrimmed.length;
  const header = prevTrimmed.slice(0, headerEnd).trim();
  if (!header) return null;

  return `${header}\n${currTrimmed}`;
}

export function diagnoseStructuredOutput(content: string, previousContent?: string | null): StructuredOutputIssue | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const fenceCount = (trimmed.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) {
    return {
      kind: 'broken_fence',
      category: 'fenced',
      title: 'Detected issue: Unfinished fenced block',
      reason: 'The response looks like an unfinished fenced block.',
    };
  }

  const lower = trimmed.toLowerCase();
  const hasHtmlSignals =
    /<!doctype html/i.test(trimmed) ||
    /<html[\s>]/i.test(trimmed) ||
    /<(?:head|body|style|meta|title|div|section|main|article|header|footer|nav)[\s>]/i.test(trimmed) ||
    /(?:^|\n)\s*[.#@a-zA-Z][\w\s:>#.,\-\[\]="'()]*\s*\{[\s\S]*?\}/.test(trimmed);
  const hasSvgSignals = /<svg[\s>]/i.test(trimmed);
  const startsLikeHtmlDocument = /^(?:<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<style[\s>]|<svg[\s>])/i.test(trimmed);
  const startsLikeTail = /^(?:<\/?[a-z]+[^>]*>|[.#][\w-]+\s*\{|[a-z-]+\s*:|x\d+=|cx=|cy=|fill=|stroke=)/i.test(trimmed);

  if (/^(?:以上就是|將這段貼在|整份文件包含：|所有視覺元素皆為)/i.test(trimmed) || /```(?:html|svg)?/i.test(trimmed)) {
    return {
      kind: 'continuation_patch',
      category: hasSvgSignals && !hasHtmlSignals ? 'svg' : 'html',
      title: 'Detected issue: Continuation patch',
      reason: 'This response looks like a continuation patch with explanation text around the code block.',
    };
  }

  if (hasHtmlSignals && hasSvgSignals) {
    return {
      kind: 'html_with_embedded_svg',
      category: 'html',
      title: 'Detected issue: Mixed HTML with embedded SVG',
      reason: 'This output is HTML that contains one or more embedded SVG blocks.',
    };
  }

  if (hasSvgSignals && !hasHtmlSignals) {
    const missingSvgTail = lower.includes('<svg') && !lower.includes('</svg>');
    return {
      kind: missingSvgTail ? 'missing_tail' : 'standalone_svg',
      category: 'svg',
      title: missingSvgTail ? 'Detected issue: SVG tail missing' : 'Detected issue: Standalone SVG',
      reason: missingSvgTail
        ? 'The SVG document is missing its closing </svg> tag.'
        : 'This output looks like a standalone SVG document or fragment.',
    };
  }

  if (hasHtmlSignals) {
    if (!startsLikeHtmlDocument && startsLikeTail) {
      return {
        kind: 'missing_head',
        category: 'html',
        title: 'Detected issue: HTML header missing',
        reason: 'This output appears to start mid-file. The HTML header or opening <style> block is missing.',
      };
    }

    if (lower.includes('<html') && !lower.includes('</html>')) {
      return {
        kind: 'missing_tail',
        category: 'html',
        title: 'Detected issue: HTML tail missing',
        reason: 'The HTML document is missing its closing </html> tag.',
      };
    }

    if (lower.includes('<body') && !lower.includes('</body>')) {
      return {
        kind: 'missing_tail',
        category: 'html',
        title: 'Detected issue: HTML tail missing',
        reason: 'The <body> section is not closed.',
      };
    }

    if (lower.includes('<style') && !lower.includes('</style>')) {
      return {
        kind: 'missing_tail',
        category: 'html',
        title: 'Detected issue: HTML tail missing',
        reason: 'The <style> block is not closed, so the HTML document is incomplete.',
      };
    }

    if (!startsLikeHtmlDocument && previousContent) {
      return {
        kind: 'missing_head',
        category: 'html',
        title: 'Detected issue: HTML header missing',
        reason: 'This output looks like a partial middle or tail section and may need its header recovered from the previous response.',
      };
    }

    if (/以下是[\s\S]{0,40}(?:html|svg)/i.test(trimmed)) {
      return {
        kind: 'mixed_explanation_plus_code',
        category: 'html',
        title: 'Detected issue: Mixed explanation + code',
        reason: 'This response mixes explanation text with HTML/SVG content.',
      };
    }
  }

  return null;
}

export function repairStructuredOutput(input: {
  current: string;
  previous?: string | null;
  stopReason?: string | null;
}): StructuredOutputRepairResult {
  const { current, previous, stopReason } = input;
  let displayContent = current;
  let mergedWithPrevious = false;
  let recoveredHeader = false;
  let recoveredTail = false;

  const diagnosis = diagnoseStructuredOutput(current, previous);

  if (previous) {
    const recovered = recoverMissingHead(previous, displayContent);
    if (recovered) {
      displayContent = recovered;
      mergedWithPrevious = true;
      recoveredHeader = true;
    }

    const mergedTail = mergeStructuredContinuation(previous, displayContent);
    if (mergedTail) {
      displayContent = mergedTail.mergedContent;
      mergedWithPrevious = true;
      recoveredTail = true;
    }
  }

  const finalIssue =
    !recoveredTail && !recoveredHeader && diagnosis
      ? diagnosis
      : diagnoseStructuredOutput(displayContent, previous);

  if (stopReason === 'max_tokens' && finalIssue?.kind === 'missing_tail') {
    return {
      issue: {
        ...finalIssue,
        reason: `${finalIssue.reason} The model also stopped because it hit its output token limit.`,
      },
      displayContent,
      mergedWithPrevious,
      recoveredHeader,
      recoveredTail,
    };
  }

  return {
    issue: finalIssue,
    displayContent,
    mergedWithPrevious,
    recoveredHeader,
    recoveredTail,
  };
}

export function buildPreviewDoc(document: string, kind: RichPreviewKind): string {
  if (kind === 'html') {
    const trimmed = document.trim();
    if (/^<!DOCTYPE html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
      return trimmed;
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><style>html,body{margin:0;padding:0;background:#0b1220;color:#e5e7eb}body{padding:16px;font-family:system-ui,-apple-system,sans-serif}</style></head><body>${trimmed}</body></html>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><style>html,body{margin:0;padding:0;background:#0b1220;display:flex;align-items:center;justify-content:center;min-height:100vh}svg{max-width:100%;height:auto}</style></head><body>${document}</body></html>`;
}

export function isValidPreviewSelection(text: string, kind: RichPreviewKind): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (kind === 'html') {
    return (
      /^<!doctype html/i.test(trimmed) ||
      /^<html[\s>]/i.test(trimmed) ||
      /<\/html>\s*$/i.test(trimmed) ||
      /<(?:head|body|style|meta|title|div|section|main|article|header|footer|nav)[\s>]/i.test(trimmed) ||
      /(?:^|\n)\s*[.#@a-zA-Z][\w\s:>#.,\-\[\]="'()]*\s*\{[\s\S]*?\}/.test(trimmed)
    );
  }
  return /^<svg[\s>]/i.test(trimmed);
}

export function previewArtifactToExtraction(artifact: RichPreviewArtifact): RichPreviewExtraction {
  return {
    kind: artifact.previewKind,
    document: artifact.selectedText,
    source: artifact.source === 'manual' ? 'manual' : artifact.extractionSource ?? 'manual',
    hasLeadingText: Boolean(artifact.hasLeadingText),
    hasTrailingText: Boolean(artifact.hasTrailingText),
    selectionStart: artifact.selectionStart ?? null,
    selectionEnd: artifact.selectionEnd ?? null,
  };
}

export function detectStructuredOutputIssue(content: string): StructuredOutputIssue | null {
  return diagnoseStructuredOutput(content, null);
}
