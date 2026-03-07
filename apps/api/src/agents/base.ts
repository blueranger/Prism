import type {
  AgentDefinition,
  AgentInputSchema,
  AgentResult,
  Artifact,
} from '@prism/shared';

/**
 * MemoryContext — the slice of Prism's memory layer available to an agent.
 * Agents are stateless: they receive context, execute, and return results.
 */
export interface MemoryContext {
  sessionId: string;
  /** Recent conversation messages (already assembled by Context Builder) */
  messages: { role: string; content: string }[];
  /** Artifacts generated in this session so far */
  artifacts: Artifact[];
}

/**
 * Abstract base class for all Prism agents.
 *
 * Every agent must:
 *  1. Declare its name, description, and input schema (for LLM tool-use)
 *  2. Implement execute() which performs work and returns AgentResult
 *
 * Agents are stateless — all state lives in the Memory Layer.
 * The Orchestrator supplies MemoryContext to each agent call.
 */
export abstract class BaseAgent implements AgentDefinition {
  abstract name: string;
  abstract description: string;
  abstract inputSchema: AgentInputSchema;

  /**
   * Execute the agent's task.
   * @param input — validated against inputSchema by the orchestrator
   * @param context — session context from the Memory Layer
   * @returns AgentResult with output, artifacts, and execution log
   */
  abstract execute(
    input: Record<string, unknown>,
    context: MemoryContext
  ): Promise<AgentResult>;

  /** Helper: create a successful result */
  protected ok(
    output: string,
    opts?: { artifacts?: Artifact[]; log?: string[] }
  ): AgentResult {
    return {
      success: true,
      output,
      artifacts: opts?.artifacts ?? [],
      log: opts?.log ?? [],
    };
  }

  /** Helper: create a failed result */
  protected fail(error: string, log?: string[]): AgentResult {
    return {
      success: false,
      output: error,
      artifacts: [],
      log: log ?? [error],
    };
  }
}
