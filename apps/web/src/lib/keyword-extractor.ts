/**
 * Keyword extractor for Knowledge Hints (Scenario 1).
 *
 * Extracts meaningful keywords from user input to match against
 * Knowledge Graph entities. Supports English and Chinese mixed input.
 */

// Common English stop words to filter out
const STOP_WORDS_EN = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'must',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'how',
  'not', 'no', 'nor', 'but', 'and', 'or', 'if', 'then', 'else', 'when', 'where',
  'so', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'to', 'with',
  'about', 'after', 'before', 'between', 'up', 'down', 'out', 'off', 'over', 'under',
  'again', 'further', 'than', 'too', 'very', 'just', 'only', 'also',
  'there', 'here', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'any', 'many', 'much', 'own',
  'same', 'get', 'got', 'make', 'made', 'let', 'know', 'think', 'want',
  'tell', 'use', 'help', 'need', 'try', 'please', 'thank', 'thanks',
]);

// Common Chinese stop words / particles
const STOP_WORDS_ZH = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一個', '上', '也', '很', '到', '說', '要', '去', '你', '會', '著',
  '沒有', '看', '好', '自己', '這', '他', '她', '它', '那', '嗎', '吧',
  '呢', '啊', '喔', '哦', '嗯', '欸', '怎麼', '什麼', '為什麼', '如何',
  '可以', '能', '跟', '把', '被', '讓', '給', '從', '比', '對',
  '但', '而', '或', '還', '因為', '所以', '如果', '雖然', '然後',
  '請', '幫', '想', '做', '用', '來',
]);

/**
 * Extract meaningful keywords from user input text.
 *
 * @param text - User input text (English, Chinese, or mixed)
 * @param maxKeywords - Maximum number of keywords to return (default 3)
 * @returns Array of extracted keywords, ordered by significance
 */
export function extractKeywords(text: string, maxKeywords = 3): string[] {
  if (!text || text.trim().length < 3) return [];

  const keywords: string[] = [];

  // 1. Extract English words (including hyphenated terms and acronyms)
  const englishWords = text.match(/[a-zA-Z][a-zA-Z0-9._-]{1,}/g) || [];
  for (const word of englishWords) {
    const lower = word.toLowerCase();
    if (lower.length >= 2 && !STOP_WORDS_EN.has(lower)) {
      keywords.push(word);
    }
  }

  // 2. Extract Chinese segments (sequences of CJK characters, 2+ chars)
  const chineseSegments = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) || [];
  for (const segment of chineseSegments) {
    if (!STOP_WORDS_ZH.has(segment)) {
      keywords.push(segment);
    }
  }

  // 3. Deduplicate (case-insensitive for English)
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const kw of keywords) {
    const key = kw.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(kw);
    }
  }

  // 4. Sort by length descending (longer = more specific = more significant)
  unique.sort((a, b) => b.length - a.length);

  return unique.slice(0, maxKeywords);
}
