import type { LinkedPageCandidate, UrlPreview, WebPagePreviewResponse } from '@prism/shared';

const URL_REGEX = /https?:\/\/[^\s)]+/gi;
const MAX_URLS = 3;
const MAX_TEXT_CHARS = 8_000;
const MAX_LINK_CANDIDATES = 10;

export interface ResolvedUrlContext {
  url: string;
  title: string | null;
  content: string;
}

interface ResolvedUrlPage extends ResolvedUrlContext {
  normalizedUrl: string;
  host: string;
  html: string;
}

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) ?? [];
  const unique = new Set<string>();

  for (const raw of matches) {
    const trimmed = raw.replace(/[),.;!?]+$/, '');
    try {
      const parsed = new URL(trimmed);
      unique.add(parsed.toString());
    } catch {
      continue;
    }
    if (unique.size >= MAX_URLS) break;
  }

  return [...unique];
}

export async function resolveUrlsFromPrompt(text: string): Promise<ResolvedUrlContext[]> {
  const urls = extractUrls(text);
  const results = await Promise.all(urls.map((url) => resolveUrl(url)));
  return results.filter((item): item is ResolvedUrlContext => Boolean(item));
}

export async function resolveUrlPreview(url: string): Promise<WebPagePreviewResponse | null> {
  const page = await resolveUrlPage(url);
  if (!page) return null;
  const links = discoverLinkedPages(page.url, page.html);
  return {
    page: {
      url: page.url,
      title: page.title,
      content: page.content,
    },
    links,
  };
}

export async function resolveUrl(url: string): Promise<ResolvedUrlContext | null> {
  const page = await resolveUrlPage(url);
  if (!page) return null;
  return { url: page.url, title: page.title, content: page.content };
}

export function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.searchParams.sort();
  const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
  parsed.pathname = normalizedPath;
  return parsed.toString();
}

async function resolveUrlPage(url: string): Promise<ResolvedUrlPage | null> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Prism/0.0.1 (+https://github.com/blueranger/Prism)',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
      },
    });

    if (!response.ok) {
      console.warn(`[url-reader] Failed to fetch ${url}: HTTP ${response.status}`);
      return null;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();

    if (contentType.includes('text/plain')) {
      const text = normalizeWhitespace(body).slice(0, MAX_TEXT_CHARS);
      return text ? {
        url: response.url,
        normalizedUrl: normalizeUrl(response.url),
        host: new URL(response.url).host,
        title: null,
        content: text,
        html: body,
      } : null;
    }

    const title = extractTitle(body);
    const content = extractMainText(body).slice(0, MAX_TEXT_CHARS);
    if (!content) return null;

    return {
      url: response.url,
      normalizedUrl: normalizeUrl(response.url),
      host: new URL(response.url).host,
      title,
      content,
      html: body,
    };
  } catch (err: any) {
    console.warn(`[url-reader] Failed to fetch ${url}: ${err.message}`);
    return null;
  }
}

export function discoverLinkedPages(pageUrl: string, html: string): LinkedPageCandidate[] {
  const page = new URL(pageUrl);
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch?.[1] ?? html;
  const contentRegion = bodyHtml.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? extractBestContentRegion(bodyHtml);
  const anchors = collectMatches(contentRegion, /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  const unique = new Map<string, LinkedPageCandidate>();

  for (const anchor of anchors) {
    const hrefMatch = anchor.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch?.[1]) continue;
    const rawHref = decodeHtmlEntities(hrefMatch[1].trim());
    if (!rawHref || rawHref.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(rawHref)) continue;

    let resolved: URL;
    try {
      resolved = new URL(rawHref, page);
    } catch {
      continue;
    }

    if (!/^https?:$/i.test(resolved.protocol)) continue;
    if (resolved.host !== page.host) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|webp|docx|xlsx|pptx)$/i.test(resolved.pathname)) continue;

    const normalizedUrl = normalizeUrl(resolved.toString());
    if (normalizedUrl === normalizeUrl(page.toString())) continue;
    if (unique.has(normalizedUrl)) continue;

    const ariaLabel = anchor.match(/aria-label=["']([^"']+)["']/i)?.[1]
      ? decodeHtmlEntities(anchor.match(/aria-label=["']([^"']+)["']/i)![1])
      : null;
    const anchorText = cleanupExtractedText(
      decodeHtmlEntities(anchor.replace(/<[^>]+>/g, ' ')),
    ) || ariaLabel || '';
    if (!anchorText || looksLikeWeakLink(anchorText)) continue;

    unique.set(normalizedUrl, {
      url: resolved.toString(),
      normalizedUrl,
      title: null,
      anchorText,
      host: resolved.host,
      snippet: anchorText,
      depth: 1,
    });
    if (unique.size >= MAX_LINK_CANDIDATES) break;
  }

  return [...unique.values()];
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  return decodeHtmlEntities(normalizeWhitespace(match[1])).slice(0, 200) || null;
}

function extractMainText(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch?.[1] ?? html;
  const mainHtml = bodyHtml.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? null;

  const semanticText = extractSemanticText(mainHtml ?? bodyHtml);
  if (semanticText) {
    return cleanupExtractedText(semanticText);
  }

  const candidateHtml = extractBestContentRegion(bodyHtml);

  const withoutScripts = candidateHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const text = withoutScripts
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return cleanupExtractedText(decodeHtmlEntities(normalizeWhitespace(text)));
}

function extractSemanticText(html: string): string {
  const blocks = collectMatches(
    html,
    /<(h1|h2|h3|h4|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi,
  )
    .map((block) => block.replace(/<[^>]+>/g, ' '))
    .map((block) => decodeHtmlEntities(normalizeWhitespace(block)))
    .filter(Boolean)
    .filter((block) => !looksLikeCss(block));

  return normalizeWhitespace(blocks.join('\n'));
}

function extractBestContentRegion(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch?.[1] ?? html;

  const candidates = [
    ...collectMatches(body, /<article\b[\s\S]*?<\/article>/gi),
    ...collectMatches(body, /<main\b[\s\S]*?<\/main>/gi),
    ...collectMatches(body, /<section\b[^>]*class="[^"]*(content|article|main)[^"]*"[^>]*>[\s\S]*?<\/section>/gi),
    ...collectMatches(body, /<div\b[^>]*class="[^"]*(post-content|entry-content|article-content|main-content|content-area|fusion-text)[^"]*"[^>]*>[\s\S]*?<\/div>/gi),
  ];

  if (candidates.length === 0) {
    return body;
  }

  return candidates
    .map((candidate) => ({
      html: candidate,
      score: estimateContentScore(candidate),
    }))
    .sort((a, b) => b.score - a.score)[0]?.html ?? body;
}

function collectMatches(text: string, regex: RegExp): string[] {
  const matches = text.match(regex);
  return matches ?? [];
}

function estimateContentScore(html: string): number {
  const stripped = html.replace(/<[^>]+>/g, ' ');
  const text = normalizeWhitespace(decodeHtmlEntities(stripped));
  const paragraphCount = (html.match(/<p\b/gi) ?? []).length;
  const headingCount = (html.match(/<h[1-4]\b/gi) ?? []).length;
  const listItemCount = (html.match(/<li\b/gi) ?? []).length;
  const semanticBlockCount = paragraphCount + headingCount + listItemCount;
  return semanticBlockCount * 5000 + text.length;
}

function cleanupExtractedText(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !looksLikeCss(line))
    .filter((line) => !looksLikeBoilerplate(line));

  return normalizeWhitespace(lines.join('\n'));
}

function looksLikeCss(line: string): boolean {
  if (line.length < 3) return false;
  if (/@font-face|\/\*|Compiled CSS|--[a-z0-9-]+\s*:|unicode-range:|font-family:|font-style:|font-weight:|src:\s*url\(|background-color:|border-radius:|padding:|margin:|display:|position:|line-height:|letter-spacing:|text-transform:|opacity:|transition:|max-width:|min-width:/i.test(line)) {
    return true;
  }
  if (/^[a-z-]+\s*:\s*[^:]+;?$/i.test(line) && !/https?:\/\//i.test(line)) {
    return true;
  }
  if (line.includes('{') || line.includes('}')) return true;
  if ((line.match(/;/g) ?? []).length >= 2) return true;
  return false;
}

function looksLikeBoilerplate(line: string): boolean {
  if (line.length > 220 && !/[.?!:]|\d/.test(line.slice(0, 80))) return true;
  if (/^(home|menu|search|skip to content)$/i.test(line)) return true;
  return false;
}

function looksLikeWeakLink(text: string): boolean {
  if (text.length < 4) return true;
  if (/^(read more|click here|home|menu|search|back)$/i.test(text)) return true;
  return false;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function buildUrlContextMessage(items: ResolvedUrlContext[]): string | null {
  if (items.length === 0) return null;

  const blocks = items.map((item, index) => {
    const label = item.title ? `${item.title} (${item.url})` : item.url;
    return [
      `[URL ${index + 1}] ${label}`,
      item.content,
    ].join('\n');
  });

  return [
    'The user included URL(s). Use the fetched page content below as additional context.',
    ...blocks,
  ].join('\n\n');
}

export function buildUrlContextPreview(items: ResolvedUrlContext[]): string[] {
  return items.map((item, index) => {
    const label = item.title ? `${item.title} (${item.url})` : item.url;
    const normalized = item.content.replace(/\r\n/g, '\n');
    return [
      `[URL ${index + 1}] ${label}`,
      '--- head ---',
      normalized.slice(0, 500),
      '--- tail ---',
      normalized.slice(-300),
    ].join('\n');
  });
}
