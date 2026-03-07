import type { AgentInputSchema, AgentResult } from '@prism/shared';
import { BaseAgent, MemoryContext } from './base';
import { agentRegistry } from './registry';
import { collectSingle } from '../services/llm-service';
import { saveArtifact } from '../memory/artifact';

/**
 * Test Agent — analyzes code and generates test suites, or evaluates
 * existing code for correctness and potential issues.
 *
 * Two modes:
 *  1. "generate" — generate tests for given code
 *  2. "review" — review code for bugs, edge cases, and improvements
 */
class TestAgent extends BaseAgent {
  name = 'test';
  description =
    'Generates test suites for code or reviews code for correctness. ' +
    'Can generate unit tests, integration tests, and perform code review.';

  inputSchema: AgentInputSchema = {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        description: '"generate" to create tests, "review" to review code for issues. Defaults to "generate".',
      },
      code: {
        type: 'string',
        description: 'The code to test or review. If not provided, uses the latest code artifact from the session.',
      },
      framework: {
        type: 'string',
        description: 'Test framework to use (e.g. "jest", "vitest", "pytest"). Defaults to "vitest".',
      },
      model: {
        type: 'string',
        description: 'Which LLM to use. Defaults to "gpt-4o".',
      },
    },
    required: [],
  };

  async execute(
    input: Record<string, unknown>,
    context: MemoryContext
  ): Promise<AgentResult> {
    const mode = (input.mode as string) ?? 'generate';
    const framework = (input.framework as string) ?? 'vitest';
    const model = (input.model as string) ?? 'gpt-4o';

    const log: string[] = [];
    log.push(`Test agent running in "${mode}" mode`);

    // Get the code to test — either from input or from session artifacts
    let code = input.code as string | undefined;

    if (!code) {
      const codeArtifacts = context.artifacts.filter((a) => a.type === 'code');
      if (codeArtifacts.length === 0) {
        return this.fail(
          'No code provided and no code artifacts found in session. Provide code or generate some first.',
          log
        );
      }
      // Use the most recent code artifact(s)
      code = codeArtifacts
        .slice(-5)
        .map(
          (a) =>
            `${a.filePath ? `// ${a.filePath}\n` : ''}${a.content}`
        )
        .join('\n\n');
      log.push(`Using ${Math.min(codeArtifacts.length, 5)} code artifact(s) from session`);
    }

    if (mode === 'generate') {
      return this.generateTests(code, framework, model, context, log);
    } else if (mode === 'review') {
      return this.reviewCode(code, model, context, log);
    } else {
      return this.fail(`Unknown mode: "${mode}". Use "generate" or "review".`, log);
    }
  }

  private async generateTests(
    code: string,
    framework: string,
    model: string,
    context: MemoryContext,
    log: string[]
  ): Promise<AgentResult> {
    log.push(`Generating ${framework} tests using ${model}`);

    const systemPrompt = `You are a test generation agent. Generate comprehensive tests for the provided code.

Requirements:
- Test framework: ${framework}
- Write clear, descriptive test names
- Cover happy paths, edge cases, and error cases
- Use proper mocking where needed
- Include necessary imports

Output format:
Respond with ONLY the test code. If multiple test files are needed, separate them with:
// === FILE: path/to/test.ext ===
followed by the test content.

Do NOT include any explanation text outside the code.`;

    try {
      const { content, error } = await collectSingle(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Generate tests for the following code:\n\n${code}` },
      ]);

      if (error) {
        log.push(`LLM error: ${error}`);
        return this.fail(`Test generation failed: ${error}`, log);
      }

      log.push(`Generated ${content.length} characters of tests`);

      // Store as artifact
      const artifact = saveArtifact(
        context.sessionId,
        'code',
        content,
        model,
        { filePath: `tests/generated.test.ts` }
      );
      log.push(`Stored test artifact: ${artifact.id}`);

      return this.ok(content, { artifacts: [artifact], log });
    } catch (err: any) {
      log.push(`Exception: ${err.message}`);
      return this.fail(`Test generation error: ${err.message}`, log);
    }
  }

  private async reviewCode(
    code: string,
    model: string,
    context: MemoryContext,
    log: string[]
  ): Promise<AgentResult> {
    log.push(`Reviewing code using ${model}`);

    const systemPrompt = `You are a code review agent. Analyze the provided code for:

1. **Bugs & Errors**: Logic errors, off-by-one, null/undefined issues
2. **Security**: Injection, XSS, secrets exposure, unsafe patterns
3. **Performance**: Unnecessary re-renders, N+1 queries, memory leaks
4. **Best Practices**: Naming, structure, error handling, type safety

Format your response as:
## Summary
(1-2 sentence overview)

## Issues Found
(numbered list with severity: 🔴 Critical, 🟡 Warning, 🔵 Info)

## Suggestions
(specific, actionable improvements)`;

    try {
      const { content, error } = await collectSingle(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Review the following code:\n\n${code}` },
      ]);

      if (error) {
        log.push(`LLM error: ${error}`);
        return this.fail(`Code review failed: ${error}`, log);
      }

      log.push(`Review complete: ${content.length} characters`);

      // Store review as a document artifact
      const artifact = saveArtifact(
        context.sessionId,
        'document',
        content,
        model,
        { filePath: 'review/code-review.md' }
      );

      return this.ok(content, { artifacts: [artifact], log });
    } catch (err: any) {
      log.push(`Exception: ${err.message}`);
      return this.fail(`Code review error: ${err.message}`, log);
    }
  }
}

// Self-register
const testAgent = new TestAgent();
agentRegistry.register(testAgent);

export default testAgent;
