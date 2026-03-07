import { v4 as uuid } from 'uuid';
import type { AgentTask, AgentResult, AgentStatus, ExecutionLogEntry } from '@prism/shared';
import { getDb } from './db';

// --- Agent Tasks ---

export function createTask(
  sessionId: string,
  agentName: string,
  input: Record<string, unknown>
): AgentTask {
  const db = getDb();
  const now = Date.now();
  const task: AgentTask = {
    id: uuid(),
    sessionId,
    agentName,
    input,
    status: 'pending',
    result: null,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO agent_tasks (id, session_id, agent_name, input, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(task.id, task.sessionId, task.agentName, JSON.stringify(task.input), task.status, task.createdAt, task.updatedAt);

  return task;
}

export function updateTaskStatus(taskId: string, status: AgentStatus, result?: AgentResult): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE agent_tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?`
  ).run(status, result ? JSON.stringify(result) : null, now, taskId);
}

export function getTask(taskId: string): AgentTask | undefined {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, session_id as sessionId, agent_name as agentName, input, status, result,
            created_at as createdAt, updated_at as updatedAt
     FROM agent_tasks WHERE id = ?`
  ).get(taskId) as any;

  if (!row) return undefined;
  return {
    ...row,
    input: JSON.parse(row.input),
    result: row.result ? JSON.parse(row.result) : null,
  };
}

export function getSessionTasks(sessionId: string): AgentTask[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, session_id as sessionId, agent_name as agentName, input, status, result,
            created_at as createdAt, updated_at as updatedAt
     FROM agent_tasks WHERE session_id = ? ORDER BY created_at ASC`
  ).all(sessionId) as any[];

  return rows.map((row) => ({
    ...row,
    input: JSON.parse(row.input),
    result: row.result ? JSON.parse(row.result) : null,
  }));
}

// --- Execution Log Entries ---

export function logExecution(
  sessionId: string,
  taskId: string,
  agentName: string,
  input: Record<string, unknown>
): ExecutionLogEntry {
  const db = getDb();
  const entry: ExecutionLogEntry = {
    id: uuid(),
    sessionId,
    taskId,
    agentName,
    input: JSON.stringify(input),
    output: null,
    success: null,
    startedAt: Date.now(),
    completedAt: null,
  };

  db.prepare(
    `INSERT INTO execution_log (id, session_id, task_id, agent_name, input, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(entry.id, entry.sessionId, entry.taskId, entry.agentName, entry.input, entry.startedAt);

  return entry;
}

export function completeExecution(
  logId: string,
  output: string,
  success: boolean
): void {
  const db = getDb();
  db.prepare(
    `UPDATE execution_log SET output = ?, success = ?, completed_at = ? WHERE id = ?`
  ).run(output, success ? 1 : 0, Date.now(), logId);
}

export function getSessionExecutionLog(sessionId: string): ExecutionLogEntry[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, session_id as sessionId, task_id as taskId, agent_name as agentName,
            input, output, success, started_at as startedAt, completed_at as completedAt
     FROM execution_log WHERE session_id = ? ORDER BY started_at ASC`
  ).all(sessionId) as any[];

  return rows.map((row) => ({
    ...row,
    success: row.success === null ? null : row.success === 1,
  }));
}

export function getTaskExecutionLog(taskId: string): ExecutionLogEntry[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, session_id as sessionId, task_id as taskId, agent_name as agentName,
            input, output, success, started_at as startedAt, completed_at as completedAt
     FROM execution_log WHERE task_id = ? ORDER BY started_at ASC`
  ).all(taskId) as any[];

  return rows.map((row) => ({
    ...row,
    success: row.success === null ? null : row.success === 1,
  }));
}
