import { v4 as uuid } from 'uuid';
import type { ManualPreviewRequest, RichPreviewArtifact, RichPreviewExtractionSource } from '@prism/shared';
import { getDb } from './db';

function inferStartsWithTag(text: string): string | null {
  const trimmed = text.trim();
  if (/^<!doctype html/i.test(trimmed)) return '!doctype';
  const tagMatch = trimmed.match(/^<([a-z0-9:-]+)/i);
  return tagMatch?.[1]?.toLowerCase() ?? null;
}

function inferExtractionSource(text: string, previewKind: 'html' | 'svg'): RichPreviewExtractionSource {
  if (/^```/i.test(text.trim())) return 'fenced';
  if (previewKind === 'svg') return 'manual';
  return 'manual';
}

export function getRichPreviewArtifact(messageId: string): RichPreviewArtifact | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
        id,
        session_id as sessionId,
        message_id as messageId,
        preview_kind as previewKind,
        selected_text as selectedText,
        selection_start as selectionStart,
        selection_end as selectionEnd,
        source,
        extraction_source as extractionSource,
        has_leading_text as hasLeadingText,
        has_trailing_text as hasTrailingText,
        starts_with_tag as startsWithTag,
        created_at as createdAt
      FROM rich_preview_artifacts
      WHERE message_id = ?`
    )
    .get(messageId) as any;

  if (!row) return null;
  return {
    ...row,
    hasLeadingText: Boolean(row.hasLeadingText),
    hasTrailingText: Boolean(row.hasTrailingText),
  } as RichPreviewArtifact;
}

export function saveManualRichPreviewArtifact(
  sessionId: string,
  messageId: string,
  input: ManualPreviewRequest,
): RichPreviewArtifact {
  const db = getDb();
  const now = Date.now();
  const selectedText = input.selectedText.trim();
  const existing = getRichPreviewArtifact(messageId);
  const artifact: RichPreviewArtifact = {
    id: existing?.id ?? uuid(),
    sessionId,
    messageId,
    previewKind: input.previewKind,
    selectedText,
    selectionStart: input.selectionStart ?? null,
    selectionEnd: input.selectionEnd ?? null,
    source: 'manual',
    extractionSource: inferExtractionSource(selectedText, input.previewKind),
    hasLeadingText: Boolean((input.selectionStart ?? 0) > 0),
    hasTrailingText: Boolean(input.selectionEnd != null && input.selectionEnd >= 0),
    startsWithTag: inferStartsWithTag(selectedText),
    createdAt: now,
  };

  db.prepare(
    `INSERT INTO rich_preview_artifacts (
      id, session_id, message_id, preview_kind, selected_text, selection_start, selection_end,
      source, extraction_source, has_leading_text, has_trailing_text, starts_with_tag, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      preview_kind=excluded.preview_kind,
      selected_text=excluded.selected_text,
      selection_start=excluded.selection_start,
      selection_end=excluded.selection_end,
      source=excluded.source,
      extraction_source=excluded.extraction_source,
      has_leading_text=excluded.has_leading_text,
      has_trailing_text=excluded.has_trailing_text,
      starts_with_tag=excluded.starts_with_tag,
      created_at=excluded.created_at`
  ).run(
    artifact.id,
    artifact.sessionId,
    artifact.messageId,
    artifact.previewKind,
    artifact.selectedText,
    artifact.selectionStart,
    artifact.selectionEnd,
    artifact.source,
    artifact.extractionSource,
    artifact.hasLeadingText ? 1 : 0,
    artifact.hasTrailingText ? 1 : 0,
    artifact.startsWithTag,
    artifact.createdAt,
  );

  return artifact;
}

export function deleteRichPreviewArtifact(messageId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM rich_preview_artifacts WHERE message_id = ?').run(messageId);
}
