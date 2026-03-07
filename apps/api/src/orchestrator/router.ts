import type { AgentResult } from '@prism/shared';
import type { SubtaskPlan } from './planner';
import { agentRegistry } from '../agents/registry';
import { buildSessionContext } from '../memory/context-builder';
import { getSessionArtifacts } from '../memory/artifact';
import {
  createTask,
  updateTaskStatus,
  logExecution,
  completeExecution,
} from '../memory/execution-log';
import type { MemoryContext } from '../agents/base';

/**
 * Route a single execution step to the appropriate agent.
 *
 * 1. Looks up the agent in the registry
 * 2. Creates a task record and execution log entry
 * 3. Builds MemoryContext from the session
 * 4. Executes the agent
 * 5. Records the result
 */
export async function routeStep(
  sessionId: string,
  step: SubtaskPlan,
  _depResults: Record<string, AgentResult>
): Promise<AgentResult> {
  const agent = agentRegistry.get(step.target);

  if (!agent) {
    return {
      success: false,
      output: `Agent "${step.target}" not found in registry`,
      artifacts: [],
      log: [`Agent "${step.target}" not found`],
    };
  }

  // Create DB records
  const task = createTask(sessionId, step.target, step.input);
  const logEntry = logExecution(sessionId, task.id, step.target, step.input);

  // Build memory context for the agent
  const context = buildMemoryContext(sessionId);

  // Update task status to running
  updateTaskStatus(task.id, 'running');

  try {
    const result = await agent.execute(step.input, context);

    // Record completion
    updateTaskStatus(task.id, result.success ? 'completed' : 'failed', result);
    completeExecution(logEntry.id, result.output, result.success);

    return result;
  } catch (err: any) {
    const errorMsg = err.message ?? 'Unknown error during agent execution';
    const failResult: AgentResult = {
      success: false,
      output: errorMsg,
      artifacts: [],
      log: [errorMsg],
    };

    updateTaskStatus(task.id, 'failed', failResult);
    completeExecution(logEntry.id, errorMsg, false);

    return failResult;
  }
}

/**
 * Execute a single agent by name (direct invocation, no planner needed).
 * Used by the agent execution API endpoint and the LLM tool-use loop.
 */
export async function executeAgent(
  sessionId: string,
  agentName: string,
  input: Record<string, unknown>
): Promise<{ taskId: string; result: AgentResult }> {
  const agent = agentRegistry.get(agentName);

  if (!agent) {
    return {
      taskId: '',
      result: {
        success: false,
        output: `Agent "${agentName}" not found`,
        artifacts: [],
        log: [`Agent "${agentName}" not found`],
      },
    };
  }

  // Validate required fields
  const required = agent.inputSchema.required ?? [];
  const missing = required.filter((field) => !(field in input) || input[field] === undefined || input[field] === '');
  if (missing.length > 0) {
    return {
      taskId: '',
      result: {
        success: false,
        output: `Missing required input field(s): ${missing.map((f) => `"${f}"`).join(', ')}`,
        artifacts: [],
        log: [`Missing required input: ${missing.join(', ')}`],
      },
    };
  }

  const task = createTask(sessionId, agentName, input);
  const logEntry = logExecution(sessionId, task.id, agentName, input);

  const context = buildMemoryContext(sessionId);

  updateTaskStatus(task.id, 'running');

  try {
    const result = await agent.execute(input, context);
    updateTaskStatus(task.id, result.success ? 'completed' : 'failed', result);
    completeExecution(logEntry.id, result.output, result.success);
    return { taskId: task.id, result };
  } catch (err: any) {
    const errorMsg = err.message ?? 'Unknown error';
    const failResult: AgentResult = {
      success: false,
      output: errorMsg,
      artifacts: [],
      log: [errorMsg],
    };
    updateTaskStatus(task.id, 'failed', failResult);
    completeExecution(logEntry.id, errorMsg, false);
    return { taskId: task.id, result: failResult };
  }
}

/**
 * Build a MemoryContext for agent execution from session data.
 */
function buildMemoryContext(sessionId: string): MemoryContext {
  // Use the context builder to get recent conversation history.
  // We use a large-context model as target to maximize available context.
  const builtCtx = buildSessionContext(sessionId, 'gemini-2.5-flash');
  const artifacts = getSessionArtifacts(sessionId);

  return {
    sessionId,
    messages: builtCtx.messages,
    artifacts,
  };
}
