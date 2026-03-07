import type { AgentResult, AgentToolDefinition } from '@prism/shared';
import { agentRegistry } from '../agents';
import { executeAgent } from '../orchestrator';
import { collectSingle, type ChatMessage } from './llm-service';

/**
 * Tool-use feedback loop.
 *
 * 1. Send prompt + tool definitions to LLM
 * 2. If LLM responds with tool calls, execute the corresponding agents
 * 3. Feed agent results back to the LLM as tool responses
 * 4. Repeat until LLM produces a final text response (max iterations)
 */
export interface ToolLoopResult {
  /** Final text output from the LLM */
  content: string;
  /** All agent executions that occurred */
  agentResults: { agentName: string; taskId: string; result: AgentResult }[];
  /** Number of loop iterations */
  iterations: number;
}

const MAX_ITERATIONS = 5;

/**
 * Run the LLM→Agent feedback loop.
 *
 * The LLM is given tool definitions for all registered agents.
 * When it makes a tool call, we execute the agent and feed the result back.
 */
export async function runToolLoop(
  sessionId: string,
  messages: ChatMessage[],
  model: string = 'gpt-4o'
): Promise<ToolLoopResult> {
  const tools = agentRegistry.toToolDefinitions();
  const agentResults: ToolLoopResult['agentResults'] = [];

  if (tools.length === 0) {
    // No agents registered — just do a normal LLM call
    const { content } = await collectSingle(model, messages);
    return { content, agentResults: [], iterations: 1 };
  }

  // We simulate tool-use by embedding tool descriptions in the system prompt.
  // Full native tool-use would require provider-specific handling in each adapter.
  // This approach works across all providers.
  const toolDescriptions = tools
    .map(
      (t) =>
        `Tool: ${t.name}\nDescription: ${t.description}\nParameters: ${JSON.stringify(t.parameters)}`
    )
    .join('\n\n');

  const toolSystemMessage: ChatMessage = {
    role: 'system',
    content: `You have access to the following tools. To use a tool, respond with EXACTLY this format on its own line:
TOOL_CALL: {"tool": "<tool_name>", "input": {<input_object>}}

You may make at most one tool call per response. After the tool executes, you'll receive the result and can either make another tool call or provide your final answer.

When you have enough information to answer the user, respond normally WITHOUT any TOOL_CALL.

Available tools:
${toolDescriptions}`,
  };

  const conversationMessages: ChatMessage[] = [toolSystemMessage, ...messages];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const { content, error } = await collectSingle(model, conversationMessages);

    if (error) {
      return { content: `Error: ${error}`, agentResults, iterations };
    }

    // Check if the LLM is making a tool call
    const toolCall = parseToolCall(content);

    if (!toolCall) {
      // No tool call — this is the final response
      return { content, agentResults, iterations };
    }

    // Execute the agent
    const { agentName, input } = toolCall;

    if (!agentRegistry.has(agentName)) {
      // Unknown tool — tell the LLM and let it retry
      conversationMessages.push(
        { role: 'assistant', content },
        { role: 'user', content: `Tool "${agentName}" not found. Available tools: ${tools.map((t) => t.name).join(', ')}` }
      );
      continue;
    }

    const { taskId, result } = await executeAgent(sessionId, agentName, input);
    agentResults.push({ agentName, taskId, result });

    // Feed result back to the LLM
    const resultSummary = result.success
      ? `Tool "${agentName}" succeeded:\n${result.output.slice(0, 3000)}`
      : `Tool "${agentName}" failed:\n${result.output}`;

    conversationMessages.push(
      { role: 'assistant', content },
      { role: 'user', content: resultSummary }
    );
  }

  // Hit max iterations — return what we have
  const { content } = await collectSingle(model, [
    ...conversationMessages,
    {
      role: 'user',
      content: 'Please provide your final answer based on the tool results above.',
    },
  ]);

  return { content, agentResults, iterations };
}

/**
 * Parse a TOOL_CALL line from LLM output.
 */
function parseToolCall(
  content: string
): { agentName: string; input: Record<string, unknown> } | null {
  const match = content.match(/TOOL_CALL:\s*(\{[\s\S]*\})/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed.tool !== 'string' || typeof parsed.input !== 'object') {
      return null;
    }
    return { agentName: parsed.tool, input: parsed.input ?? {} };
  } catch {
    return null;
  }
}
