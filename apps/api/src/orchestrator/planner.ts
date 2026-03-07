import type { AgentTask } from '@prism/shared';
import { agentRegistry } from '../agents/registry';
import { collectSingle } from '../services/llm-service';

/**
 * SubtaskPlan — a decomposed step produced by the planner.
 * Each step maps to either an LLM call or an agent execution.
 */
export interface SubtaskPlan {
  /** Unique step label (e.g. "step_1") */
  id: string;
  /** Which agent to invoke (or "llm" for a direct LLM call) */
  target: string;
  /** Input to pass to the agent */
  input: Record<string, unknown>;
  /** IDs of steps that must complete before this one runs */
  dependsOn: string[];
  /** Human-readable description */
  description: string;
}

export interface ExecutionPlan {
  sessionId: string;
  steps: SubtaskPlan[];
  /** The planner's reasoning: why these agents, this order, these dependencies */
  reasoning: string | null;
}

/**
 * Plan a single agent execution — the simplest case.
 * Used when the user or LLM explicitly requests a specific agent.
 */
export function planSingleAgent(
  sessionId: string,
  agentName: string,
  input: Record<string, unknown>
): ExecutionPlan {
  return {
    sessionId,
    reasoning: null,
    steps: [
      {
        id: 'step_1',
        target: agentName,
        input,
        dependsOn: [],
        description: `Execute ${agentName} agent`,
      },
    ],
  };
}

/**
 * Use an LLM to decompose a complex task into subtasks.
 * The LLM is given the list of available agents and asked to plan.
 *
 * Returns a structured plan that the Scheduler can execute.
 */
export async function planWithLLM(
  sessionId: string,
  userInstruction: string,
  plannerModel: string = 'gpt-4o'
): Promise<ExecutionPlan> {
  const agents = agentRegistry.list();

  const agentDescriptions = agents
    .map(
      (a) =>
        `- ${a.name}: ${a.description}\n  Input: ${JSON.stringify(a.inputSchema)}`
    )
    .join('\n');

  const systemPrompt = `You are a task planner for Prism, a multi-LLM orchestrator.
Given a user's request and the available agents, decompose the request into a sequence of steps.

Available agents:
${agentDescriptions}

Respond with a JSON object containing:
1. "reasoning": string — explain your thought process: why you chose these agents, why this ordering, and what the dependencies between steps are. Be concise but informative.
2. "steps": array of step objects. Each step has:
   - "id": string (e.g. "step_1")
   - "target": string (agent name from the list above)
   - "input": object matching the agent's input schema
   - "dependsOn": string[] (IDs of steps that must complete first)
   - "description": string (brief description of what this step does)

If the task only needs one agent, return a single step.
If no agent can handle the request, return an empty steps array.

IMPORTANT: Only use agents from the list above. Respond with ONLY the JSON object, no other text.`;

  const { content } = await collectSingle(plannerModel, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userInstruction },
  ]);

  try {
    // Extract JSON from the response (handle markdown code blocks)
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);

    // Support both old format (raw array) and new format ({ reasoning, steps })
    let steps: SubtaskPlan[];
    let reasoning: string | null = null;

    if (Array.isArray(parsed)) {
      steps = parsed;
    } else if (parsed && Array.isArray(parsed.steps)) {
      steps = parsed.steps;
      reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : null;
    } else {
      return { sessionId, reasoning: null, steps: [] };
    }

    // Validate each step references a known agent
    const validSteps = steps.filter(
      (step) => agentRegistry.has(step.target) && step.id && step.input
    );

    return { sessionId, reasoning, steps: validSteps };
  } catch {
    // If LLM returns non-parseable output, return empty plan
    return { sessionId, reasoning: null, steps: [] };
  }
}
