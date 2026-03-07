import type { AgentResult } from '@prism/shared';
import type { ExecutionPlan, SubtaskPlan } from './planner';
import { routeStep } from './router';

export interface StepResult {
  stepId: string;
  agentName: string;
  result: AgentResult;
}

export interface SchedulerResult {
  sessionId: string;
  results: StepResult[];
  success: boolean;
}

/**
 * Execute an execution plan respecting dependency ordering.
 *
 * Independent steps (no unmet dependencies) run concurrently.
 * Dependent steps wait for their prerequisites.
 *
 * Calls onStepStart/onStepComplete callbacks for real-time progress.
 */
export async function executePlan(
  plan: ExecutionPlan,
  callbacks?: {
    onStepStart?: (step: SubtaskPlan) => void;
    onStepComplete?: (stepId: string, result: AgentResult) => void;
  }
): Promise<SchedulerResult> {
  const { sessionId, steps } = plan;
  const completed = new Map<string, AgentResult>();
  const results: StepResult[] = [];
  const remaining = new Set(steps.map((s) => s.id));

  // Build a lookup
  const stepMap = new Map(steps.map((s) => [s.id, s]));

  while (remaining.size > 0) {
    // Find all steps whose dependencies are met
    const ready: SubtaskPlan[] = [];
    for (const id of remaining) {
      const step = stepMap.get(id)!;
      const depsReady = step.dependsOn.every((dep) => completed.has(dep));
      if (depsReady) {
        ready.push(step);
      }
    }

    if (ready.length === 0) {
      // Deadlock: remaining steps have unresolvable dependencies
      break;
    }

    // Execute all ready steps concurrently
    const executions = ready.map(async (step) => {
      callbacks?.onStepStart?.(step);

      // Gather dependency outputs for context
      const depResults: Record<string, AgentResult> = {};
      for (const depId of step.dependsOn) {
        depResults[depId] = completed.get(depId)!;
      }

      const result = await routeStep(sessionId, step, depResults);

      callbacks?.onStepComplete?.(step.id, result);

      return { stepId: step.id, agentName: step.target, result };
    });

    const stepResults = await Promise.all(executions);

    for (const sr of stepResults) {
      completed.set(sr.stepId, sr.result);
      remaining.delete(sr.stepId);
      results.push(sr);
    }

    // If any step failed, stop execution
    const anyFailed = stepResults.some((sr) => !sr.result.success);
    if (anyFailed) break;
  }

  return {
    sessionId,
    results,
    success: remaining.size === 0 && results.every((r) => r.result.success),
  };
}
