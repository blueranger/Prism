import { Router } from 'express';
import type { AgentExecRequest } from '@prism/shared';
import { agentRegistry } from '../agents';
import { executeAgent } from '../orchestrator';
import { planWithLLM, planSingleAgent, executePlan } from '../orchestrator';
import { getSessionTasks, getSessionExecutionLog } from '../memory/execution-log';
import { runToolLoop } from '../services/tool-loop';
import { buildSessionContext } from '../memory/context-builder';

const router = Router();

/**
 * GET /api/agents — list all registered agents and their schemas.
 */
router.get('/', (_req, res) => {
  const agents = agentRegistry.list().map((a) => ({
    name: a.name,
    description: a.description,
    inputSchema: a.inputSchema,
  }));
  res.json({ agents });
});

/**
 * GET /api/agents/tools — get agents as LLM tool definitions.
 */
router.get('/tools', (_req, res) => {
  res.json({ tools: agentRegistry.toToolDefinitions() });
});

/**
 * POST /api/agents/execute — execute a single agent directly.
 */
router.post('/execute', async (req, res) => {
  const { sessionId, agentName, input } = req.body as AgentExecRequest;

  if (!sessionId || !agentName) {
    res.status(400).json({ error: 'sessionId and agentName are required' });
    return;
  }

  if (!agentRegistry.has(agentName)) {
    res.status(404).json({ error: `Agent "${agentName}" not found` });
    return;
  }

  try {
    const { taskId, result } = await executeAgent(sessionId, agentName, input ?? {});
    res.json({ taskId, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agents/plan — use LLM to plan and execute a complex task.
 *
 * SSE endpoint that streams progress events as the plan executes.
 */
router.post('/plan', async (req, res) => {
  const { sessionId, instruction, model } = req.body as {
    sessionId: string;
    instruction: string;
    model?: string;
  };

  if (!sessionId || !instruction) {
    res.status(400).json({ error: 'sessionId and instruction are required' });
    return;
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Phase 1: Plan
    send({ type: 'planning', message: 'Analyzing task and creating execution plan...' });

    const plan = await planWithLLM(sessionId, instruction, model);

    if (plan.steps.length === 0) {
      send({ type: 'error', message: 'Could not decompose task into executable steps' });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    send({
      type: 'plan',
      reasoning: plan.reasoning ?? null,
      steps: plan.steps.map((s) => ({
        id: s.id,
        target: s.target,
        description: s.description,
        dependsOn: s.dependsOn,
      })),
    });

    // Phase 2: Execute
    const result = await executePlan(plan, {
      onStepStart: (step) => {
        send({ type: 'step_start', stepId: step.id, agent: step.target, description: step.description });
      },
      onStepComplete: (stepId, stepResult) => {
        send({
          type: 'step_complete',
          stepId,
          success: stepResult.success,
          output: stepResult.output.slice(0, 2000), // Truncate for SSE
          artifactCount: stepResult.artifacts.length,
        });
      },
    });

    send({
      type: 'complete',
      success: result.success,
      totalSteps: result.results.length,
      artifacts: result.results.flatMap((r) =>
        r.result.artifacts.map((a) => ({
          id: a.id,
          type: a.type,
          filePath: a.filePath,
        }))
      ),
    });
  } catch (err: any) {
    send({ type: 'error', message: err.message });
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

/**
 * POST /api/agents/tool-loop — run the LLM→Agent feedback loop.
 *
 * The LLM can invoke agents as tools, and agent results are fed back
 * to the LLM until it produces a final text response.
 */
router.post('/tool-loop', async (req, res) => {
  const { sessionId, prompt, model } = req.body as {
    sessionId: string;
    prompt: string;
    model?: string;
  };

  if (!sessionId || !prompt) {
    res.status(400).json({ error: 'sessionId and prompt are required' });
    return;
  }

  try {
    // Build conversation context
    const ctx = buildSessionContext(sessionId, model ?? 'gpt-4o');
    const messages = [
      ...ctx.messages,
      { role: 'user' as const, content: prompt },
    ];

    const result = await runToolLoop(sessionId, messages, model);

    res.json({
      content: result.content,
      agentResults: result.agentResults.map((ar) => ({
        agentName: ar.agentName,
        taskId: ar.taskId,
        success: ar.result.success,
        output: ar.result.output.slice(0, 2000),
        artifactCount: ar.result.artifacts.length,
      })),
      iterations: result.iterations,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents/tasks/:sessionId — get all tasks for a session.
 */
router.get('/tasks/:sessionId', (req, res) => {
  const tasks = getSessionTasks(req.params.sessionId);
  res.json({ tasks });
});

/**
 * GET /api/agents/log/:sessionId — get execution log for a session.
 */
router.get('/log/:sessionId', (req, res) => {
  const log = getSessionExecutionLog(req.params.sessionId);
  res.json({ log });
});

export default router;
