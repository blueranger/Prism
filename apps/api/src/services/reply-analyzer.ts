import { v4 as uuid } from 'uuid';
import type { CommProvider } from '@prism/shared';
import { getDb } from '../memory/db';

// --- Tone Detection (keyword-based, no LLM calls) ---

export type DetectedTone = 'formal' | 'casual' | 'friendly' | 'technical' | 'neutral';

const FORMAL_MARKERS = [
  'regards', 'sincerely', 'dear', 'respectfully', 'herewith',
  'pursuant', 'accordingly', 'kindly', 'as per', 'please be advised',
  'i would like to', 'we would like to', 'in accordance', 'for your reference',
  'at your earliest convenience', 'please find attached', 'with respect to',
  'i am writing to', 'we are writing to', 'further to',
];

const CASUAL_MARKERS = [
  'hey', 'hi there', 'gonna', 'wanna', 'gotta', 'btw', 'fyi',
  'lol', 'haha', 'cool', 'awesome', 'no worries', 'sure thing',
  'sounds good', 'yep', 'nope', 'yeah', 'sup', 'cheers',
  'catch up', 'hang out', 'np', 'ty', 'thx', 'omg',
];

const FRIENDLY_MARKERS = [
  'hope you\'re doing well', 'hope this finds you', 'great to hear',
  'thanks so much', 'really appreciate', 'wonderful', 'lovely',
  'looking forward', 'excited', 'glad to', 'happy to help',
  'let me know if', 'feel free to', 'take care', 'best wishes',
  'warm regards', 'have a great', 'hope you had a',
];

const TECHNICAL_MARKERS = [
  'implementation', 'architecture', 'deploy', 'repository', 'merge',
  'pull request', 'api', 'endpoint', 'database', 'refactor',
  'pipeline', 'config', 'dependency', 'runtime', 'compile',
  'debug', 'stack trace', 'regression', 'benchmark', 'latency',
  'throughput', 'algorithm', 'schema', 'migration', 'ci/cd',
];

interface ToneScore {
  tone: DetectedTone;
  score: number;
  markers: string[];
}

/**
 * Detect the tone of a text using keyword matching.
 * Returns the dominant tone and confidence score.
 */
export function detectTone(text: string): { tone: DetectedTone; confidence: number; matchedMarkers: string[] } {
  const lower = text.toLowerCase();

  const scores: ToneScore[] = [
    scoreMarkers(lower, FORMAL_MARKERS, 'formal'),
    scoreMarkers(lower, CASUAL_MARKERS, 'casual'),
    scoreMarkers(lower, FRIENDLY_MARKERS, 'friendly'),
    scoreMarkers(lower, TECHNICAL_MARKERS, 'technical'),
  ];

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  const best = scores[0];

  if (best.score === 0) {
    return { tone: 'neutral', confidence: 0.3, matchedMarkers: [] };
  }

  // Confidence is based on how dominant the top tone is relative to others
  const totalScore = scores.reduce((s, t) => s + t.score, 0);
  const confidence = Math.min(0.95, 0.4 + (best.score / totalScore) * 0.5);

  return { tone: best.tone, confidence, matchedMarkers: best.markers };
}

function scoreMarkers(text: string, markers: string[], tone: DetectedTone): ToneScore {
  const matched: string[] = [];
  let score = 0;

  for (const marker of markers) {
    // Use word boundary where possible; multi-word phrases just use includes
    const found = marker.includes(' ')
      ? text.includes(marker)
      : new RegExp(`\\b${escapeRegex(marker)}\\b`, 'i').test(text);

    if (found) {
      matched.push(marker);
      // Longer markers are more specific → worth more
      score += 1 + (marker.length > 8 ? 0.5 : 0);
    }
  }

  return { tone, score, markers: matched };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Content Analysis ---

/**
 * Detect whether a text contains a question.
 */
export function containsQuestion(text: string): boolean {
  return text.includes('?');
}

/**
 * Detect whether a text contains action items or requests.
 */
export function containsActionItem(text: string): boolean {
  return /\b(action item|todo|task|follow[- ]?up|please|could you|would you|can you|will you|need you to|make sure|don't forget|deadline|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|eod|eow|end of))\b/i.test(text);
}

// --- Reply Analysis (full pipeline) ---

export interface ReplyAnalysis {
  tone: DetectedTone;
  toneConfidence: number;
  replyLengthChars: number;
  containsQuestion: boolean;
  containsActionItem: boolean;
  matchedMarkers: string[];
}

/**
 * Analyze a reply text and return structured analysis data.
 */
export function analyzeReply(replyText: string): ReplyAnalysis {
  const toneResult = detectTone(replyText);

  return {
    tone: toneResult.tone,
    toneConfidence: toneResult.confidence,
    replyLengthChars: replyText.length,
    containsQuestion: containsQuestion(replyText),
    containsActionItem: containsActionItem(replyText),
    matchedMarkers: toneResult.matchedMarkers,
  };
}

// --- Learning Storage ---

/**
 * Record a reply learning entry with full analysis.
 */
export function recordLearning(params: {
  provider: CommProvider;
  senderId: string;
  senderName: string;
  contextMessage: string;
  userReply: string;
  wasEditedFromDraft: boolean;
}): void {
  const analysis = analyzeReply(params.userReply);
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO reply_learning
     (id, provider, sender_id, sender_name, context_message, user_reply, tone, reply_length_chars, contains_question, contains_action_item, was_edited_from_draft, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    params.provider,
    params.senderId,
    params.senderName,
    params.contextMessage.slice(0, 500),
    params.userReply,
    analysis.tone,
    analysis.replyLengthChars,
    analysis.containsQuestion ? 1 : 0,
    analysis.containsActionItem ? 1 : 0,
    params.wasEditedFromDraft ? 1 : 0,
    now
  );
}

// --- Sender Pattern Queries ---

export interface SenderStats {
  senderId: string;
  senderName: string;
  provider: CommProvider;
  replyCount: number;
  avgLength: number;
  dominantTone: DetectedTone | null;
  toneBreakdown: Record<string, number>;
  questionRate: number;        // 0.0–1.0
  actionItemRate: number;      // 0.0–1.0
  editRate: number;            // 0.0–1.0 — how often user edits AI drafts
  lastReplyAt: number;
}

/**
 * Get aggregated stats for all senders the user has replied to.
 */
export function listSenderStats(): SenderStats[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT
       sender_id,
       sender_name,
       provider,
       COUNT(*) as reply_count,
       AVG(reply_length_chars) as avg_length,
       SUM(contains_question) as question_count,
       SUM(contains_action_item) as action_item_count,
       SUM(was_edited_from_draft) as edit_count,
       MAX(created_at) as last_reply_at
     FROM reply_learning
     GROUP BY provider, sender_id
     ORDER BY last_reply_at DESC`
  ).all() as any[];

  return rows.map((row) => {
    const toneBreakdown = getToneBreakdown(row.provider, row.sender_id);
    const dominantTone = getDominantTone(toneBreakdown);

    return {
      senderId: row.sender_id,
      senderName: row.sender_name,
      provider: row.provider,
      replyCount: row.reply_count,
      avgLength: Math.round(row.avg_length ?? 0),
      dominantTone,
      toneBreakdown,
      questionRate: row.reply_count > 0 ? row.question_count / row.reply_count : 0,
      actionItemRate: row.reply_count > 0 ? row.action_item_count / row.reply_count : 0,
      editRate: row.reply_count > 0 ? row.edit_count / row.reply_count : 0,
      lastReplyAt: row.last_reply_at,
    };
  });
}

/**
 * Get detailed stats for a specific sender.
 */
export function getSenderStats(provider: string, senderId: string): SenderStats | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT
       sender_id,
       sender_name,
       provider,
       COUNT(*) as reply_count,
       AVG(reply_length_chars) as avg_length,
       SUM(contains_question) as question_count,
       SUM(contains_action_item) as action_item_count,
       SUM(was_edited_from_draft) as edit_count,
       MAX(created_at) as last_reply_at
     FROM reply_learning
     WHERE provider = ? AND sender_id = ?
     GROUP BY provider, sender_id`
  ).get(provider, senderId) as any;

  if (!row) return null;

  const toneBreakdown = getToneBreakdown(row.provider, row.sender_id);
  const dominantTone = getDominantTone(toneBreakdown);

  return {
    senderId: row.sender_id,
    senderName: row.sender_name,
    provider: row.provider,
    replyCount: row.reply_count,
    avgLength: Math.round(row.avg_length ?? 0),
    dominantTone,
    toneBreakdown,
    questionRate: row.reply_count > 0 ? row.question_count / row.reply_count : 0,
    actionItemRate: row.reply_count > 0 ? row.action_item_count / row.reply_count : 0,
    editRate: row.reply_count > 0 ? row.edit_count / row.reply_count : 0,
    lastReplyAt: row.last_reply_at,
  };
}

/**
 * Get recent learning entries for a sender (for example replies in prompts).
 */
export function getSenderLearnings(provider: string, senderId: string, limit: number = 10): any[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM reply_learning
     WHERE provider = ? AND sender_id = ?
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(provider, senderId, limit) as any[];
}

/**
 * Clear all learning data for a specific sender.
 */
export function clearSenderLearning(provider: string, senderId: string): number {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM reply_learning WHERE provider = ? AND sender_id = ?'
  ).run(provider, senderId);
  return result.changes;
}

/**
 * Build style guidance text for the system prompt based on learned patterns.
 * Returns null if no learnings exist.
 */
export function buildStyleGuidance(provider: string, senderId: string): string | null {
  const stats = getSenderStats(provider, senderId);
  if (!stats || stats.replyCount === 0) return null;

  const learnings = getSenderLearnings(provider, senderId, 5);
  const lines: string[] = [];

  lines.push(`Based on ${stats.replyCount} past replies to ${stats.senderName}:`);
  lines.push(`- Average reply length: ~${stats.avgLength} characters`);

  if (stats.dominantTone) {
    lines.push(`- Typical tone: ${stats.dominantTone}`);
    const breakdown = Object.entries(stats.toneBreakdown)
      .filter(([, count]) => count > 0)
      .map(([t, count]) => `${t}: ${count}`)
      .join(', ');
    if (breakdown) {
      lines.push(`  (breakdown: ${breakdown})`);
    }
  }

  if (stats.questionRate > 0.3) {
    lines.push(`- You often include questions in replies (${Math.round(stats.questionRate * 100)}% of the time)`);
  }
  if (stats.actionItemRate > 0.3) {
    lines.push(`- You often include action items or requests (${Math.round(stats.actionItemRate * 100)}% of the time)`);
  }
  if (stats.editRate > 0.5) {
    lines.push(`- Note: You frequently edit AI-generated drafts, so be extra careful to match your natural style`);
  }

  // Include example replies
  if (learnings.length > 0) {
    lines.push('');
    lines.push('Example past replies:');
    for (const l of learnings.slice(0, 3)) {
      const contextPreview = l.context_message.length > 80
        ? l.context_message.slice(0, 80) + '...'
        : l.context_message;
      const replyPreview = l.user_reply.length > 150
        ? l.user_reply.slice(0, 150) + '...'
        : l.user_reply;
      lines.push(`  Context: "${contextPreview}"`);
      lines.push(`  Your reply: "${replyPreview}"`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// --- Internal helpers ---

function getToneBreakdown(provider: string, senderId: string): Record<string, number> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT tone, COUNT(*) as cnt
     FROM reply_learning
     WHERE provider = ? AND sender_id = ? AND tone IS NOT NULL
     GROUP BY tone`
  ).all(provider, senderId) as { tone: string; cnt: number }[];

  const breakdown: Record<string, number> = {};
  for (const r of rows) {
    breakdown[r.tone] = r.cnt;
  }
  return breakdown;
}

function getDominantTone(breakdown: Record<string, number>): DetectedTone | null {
  const entries = Object.entries(breakdown);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0] as DetectedTone;
}
