import { v4 as uuid } from 'uuid';
import type { CompilerArtifact, CompilerRunSummary, CompiledSourceType, ObsidianDestinationType } from '@prism/shared';
import { getDb } from './db';

type CompilerRunRow = {
  id: string;
  source_id: string;
  source_type: CompiledSourceType;
  source_title: string;
  destination_type?: ObsidianDestinationType | null;
  status: CompilerRunSummary['status'];
  model?: string | null;
  created_at: number;
  completed_at?: number | null;
  graph_updates_count: number;
  memory_candidates_count: number;
  trigger_candidates_count: number;
  concept_count: number;
  related_note_count: number;
  backlink_suggestion_count: number;
  article_candidate_count: number;
  summary_json?: string | null;
  artifacts_json?: string | null;
  error?: string | null;
};

function mapCompilerRun(row: CompilerRunRow): CompilerRunSummary {
  let parsedSummary: Partial<CompilerRunSummary> = {};
  let parsedArtifacts: CompilerArtifact | null = null;
  try {
    parsedSummary = row.summary_json ? JSON.parse(row.summary_json) : {};
  } catch {
    parsedSummary = {};
  }
  try {
    parsedArtifacts = row.artifacts_json ? JSON.parse(row.artifacts_json) : null;
  } catch {
    parsedArtifacts = null;
  }

  return {
    id: row.id,
    sourceId: row.source_id,
    sourceType: row.source_type,
    sourceTitle: row.source_title,
    destinationType: row.destination_type ?? null,
    status: row.status,
    model: row.model ?? null,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    graphUpdatesCount: row.graph_updates_count,
    memoryCandidatesCount: row.memory_candidates_count,
    triggerCandidatesCount: row.trigger_candidates_count,
    conceptCount: row.concept_count,
    relatedNoteCount: row.related_note_count,
    backlinkSuggestionCount: row.backlink_suggestion_count,
    articleCandidateCount: row.article_candidate_count,
    errors: Array.isArray((parsedSummary as any).errors) ? (parsedSummary as any).errors : undefined,
    artifacts: parsedArtifacts,
  };
}

export function createCompilerRun(input: {
  sourceId: string;
  sourceType: CompiledSourceType;
  sourceTitle: string;
  destinationType?: ObsidianDestinationType | null;
  model?: string | null;
}): CompilerRunSummary {
  const db = getDb();
  const id = uuid();
  const createdAt = Date.now();
  db.prepare(`
    INSERT INTO compiler_runs (
      id, source_id, source_type, source_title, destination_type, status, model, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    id,
    input.sourceId,
    input.sourceType,
    input.sourceTitle,
    input.destinationType ?? null,
    input.model ?? null,
    createdAt
  );

  return {
    id,
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    sourceTitle: input.sourceTitle,
    destinationType: input.destinationType ?? null,
    status: 'pending',
    model: input.model ?? null,
    createdAt,
    completedAt: null,
    graphUpdatesCount: 0,
    memoryCandidatesCount: 0,
    triggerCandidatesCount: 0,
    conceptCount: 0,
    relatedNoteCount: 0,
    backlinkSuggestionCount: 0,
    articleCandidateCount: 0,
    artifacts: null,
  };
}

export function completeCompilerRun(input: {
  id: string;
  status: CompilerRunSummary['status'];
  graphUpdatesCount?: number;
  memoryCandidatesCount?: number;
  triggerCandidatesCount?: number;
  conceptCount?: number;
  relatedNoteCount?: number;
  backlinkSuggestionCount?: number;
  articleCandidateCount?: number;
  artifacts?: CompilerArtifact | null;
  errors?: string[];
}): CompilerRunSummary | null {
  const db = getDb();
  const completedAt = Date.now();
  db.prepare(`
    UPDATE compiler_runs
    SET status = ?,
        completed_at = ?,
        graph_updates_count = ?,
        memory_candidates_count = ?,
        trigger_candidates_count = ?,
        concept_count = ?,
        related_note_count = ?,
        backlink_suggestion_count = ?,
        article_candidate_count = ?,
        summary_json = ?,
        artifacts_json = ?,
        error = ?
    WHERE id = ?
  `).run(
    input.status,
    completedAt,
    input.graphUpdatesCount ?? 0,
    input.memoryCandidatesCount ?? 0,
    input.triggerCandidatesCount ?? 0,
    input.conceptCount ?? 0,
    input.relatedNoteCount ?? 0,
    input.backlinkSuggestionCount ?? 0,
    input.articleCandidateCount ?? 0,
    JSON.stringify({ errors: input.errors ?? [] }),
    input.artifacts ? JSON.stringify(input.artifacts) : null,
    input.errors?.length ? input.errors.join(' | ') : null,
    input.id
  );
  return getCompilerRun(input.id);
}

export function getCompilerRun(id: string): CompilerRunSummary | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM compiler_runs WHERE id = ? LIMIT 1').get(id) as CompilerRunRow | undefined;
  return row ? mapCompilerRun(row) : null;
}

export function listCompilerRuns(opts: {
  sourceId?: string;
  sourceType?: CompiledSourceType;
  limit?: number;
} = {}): CompilerRunSummary[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.sourceId) {
    clauses.push('source_id = ?');
    params.push(opts.sourceId);
  }
  if (opts.sourceType) {
    clauses.push('source_type = ?');
    params.push(opts.sourceType);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts.limit ?? 20;
  const rows = db.prepare(`
    SELECT *
    FROM compiler_runs
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit) as CompilerRunRow[];
  return rows.map(mapCompilerRun);
}
