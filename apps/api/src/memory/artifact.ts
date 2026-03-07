import { v4 as uuid } from 'uuid';
import type { Artifact, ArtifactType } from '@prism/shared';
import { getDb } from './db';

export function saveArtifact(
  sessionId: string,
  type: ArtifactType,
  content: string,
  createdBy: string,
  opts?: { filePath?: string; parentVersion?: number }
): Artifact {
  const db = getDb();

  // Determine version: if parentVersion provided, increment; otherwise find max
  let version = 1;
  if (opts?.parentVersion) {
    version = opts.parentVersion + 1;
  } else {
    const row = db
      .prepare('SELECT MAX(version) as maxVer FROM artifacts WHERE session_id = ? AND type = ?')
      .get(sessionId, type) as { maxVer: number | null } | undefined;
    if (row?.maxVer) {
      version = row.maxVer + 1;
    }
  }

  const artifact: Artifact = {
    id: uuid(),
    sessionId,
    type,
    content,
    filePath: opts?.filePath ?? null,
    createdBy,
    version,
    parentVersion: opts?.parentVersion ?? null,
    timestamp: Date.now(),
  };

  db.prepare(
    `INSERT INTO artifacts (id, session_id, type, content, file_path, created_by, version, parent_version, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    artifact.id, artifact.sessionId, artifact.type, artifact.content,
    artifact.filePath, artifact.createdBy, artifact.version,
    artifact.parentVersion, artifact.timestamp
  );

  return artifact;
}

export function getSessionArtifacts(sessionId: string): Artifact[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, session_id as sessionId, type, content, file_path as filePath,
              created_by as createdBy, version, parent_version as parentVersion, timestamp
       FROM artifacts WHERE session_id = ? ORDER BY timestamp ASC`
    )
    .all(sessionId) as Artifact[];
}

export function getArtifact(id: string): Artifact | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, session_id as sessionId, type, content, file_path as filePath,
              created_by as createdBy, version, parent_version as parentVersion, timestamp
       FROM artifacts WHERE id = ?`
    )
    .get(id) as Artifact | undefined;
}

export function getArtifactHistory(sessionId: string, type: ArtifactType): Artifact[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, session_id as sessionId, type, content, file_path as filePath,
              created_by as createdBy, version, parent_version as parentVersion, timestamp
       FROM artifacts WHERE session_id = ? AND type = ? ORDER BY version ASC`
    )
    .all(sessionId, type) as Artifact[];
}
