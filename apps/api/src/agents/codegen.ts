import type { AgentInputSchema, AgentResult, Artifact } from '@prism/shared';
import { BaseAgent, MemoryContext } from './base';
import { agentRegistry } from './registry';
import { collectSingle } from '../services/llm-service';
import { saveArtifact } from '../memory/artifact';

/**
 * Code Gen Agent — generates code from descriptions or requirements.
 *
 * Takes a description of what to build plus optional language/framework
 * preferences, asks an LLM to generate code, and stores the result as
 * an artifact in the session.
 */
class CodeGenAgent extends BaseAgent {
  name = 'codegen';
  description =
    'Generates code from architecture descriptions, requirements, or specifications. ' +
    'Can scaffold entire projects or generate individual files.';

  inputSchema: AgentInputSchema = {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'What to generate — e.g. "a REST API for user management with Express and TypeScript"',
      },
      language: {
        type: 'string',
        description: 'Target language (e.g. "typescript", "python"). Defaults to TypeScript.',
      },
      framework: {
        type: 'string',
        description: 'Target framework if applicable (e.g. "express", "react", "fastapi").',
      },
      model: {
        type: 'string',
        description: 'Which LLM to use for generation. Defaults to "claude-sonnet-4-20250514".',
      },
    },
    required: ['description'],
  };

  async execute(
    input: Record<string, unknown>,
    context: MemoryContext
  ): Promise<AgentResult> {
    const description = input.description as string | undefined;
    if (!description) {
      return this.fail('Missing required input: "description". Provide a description of what to generate.');
    }

    const language = (input.language as string) ?? 'TypeScript';
    const framework = (input.framework as string) ?? '';
    const model = (input.model as string) ?? 'claude-sonnet-4-20250514';

    const log: string[] = [];
    log.push(`Starting code generation: ${description}`);
    log.push(`Language: ${language}, Framework: ${framework || 'none specified'}`);
    log.push(`Using model: ${model}`);

    // Build the generation prompt incorporating conversation context
    const contextSummary = context.messages.length > 0
      ? `\n\nConversation context (for reference):\n${context.messages.slice(-5).map((m) => `${m.role}: ${m.content.slice(0, 500)}`).join('\n')}`
      : '';

    const existingArtifacts = context.artifacts
      .filter((a) => a.type === 'code')
      .slice(-3)
      .map((a) => `--- ${a.filePath ?? 'file'} (v${a.version}) ---\n${a.content.slice(0, 1000)}`)
      .join('\n\n');

    const artifactContext = existingArtifacts
      ? `\n\nExisting code artifacts in this session:\n${existingArtifacts}`
      : '';

    const systemPrompt = `You are a code generation agent. Generate clean, production-quality code.

Requirements:
- Language: ${language}
- Framework: ${framework || 'use your best judgment'}
- Follow best practices for the chosen language/framework
- Include necessary imports and type definitions
- Add brief inline comments for complex logic

Output format:
Respond with ONLY the generated code. If multiple files are needed, separate them with:
// === FILE: path/to/file.ext ===
followed by the file content.

Do NOT include any explanation text outside the code blocks.${contextSummary}${artifactContext}`;

    try {
      const { content, error } = await collectSingle(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: description },
      ]);

      if (error) {
        log.push(`LLM error: ${error}`);
        return this.fail(`Code generation failed: ${error}`, log);
      }

      log.push(`Generated ${content.length} characters of code`);

      // Parse multi-file output and create artifacts
      const artifacts = parseAndStoreArtifacts(
        content,
        context.sessionId,
        model,
        log
      );

      log.push(`Created ${artifacts.length} artifact(s)`);

      return this.ok(content, { artifacts, log });
    } catch (err: any) {
      log.push(`Exception: ${err.message}`);
      return this.fail(`Code generation error: ${err.message}`, log);
    }
  }
}

/**
 * Parse generated code into individual file artifacts.
 * Handles both single-file and multi-file output.
 */
function parseAndStoreArtifacts(
  content: string,
  sessionId: string,
  createdBy: string,
  log: string[]
): Artifact[] {
  const artifacts: Artifact[] = [];
  const fileMarker = /\/\/ === FILE: (.+?) ===/g;
  const sections: { filePath: string; content: string }[] = [];

  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let lastPath = '';

  while ((match = fileMarker.exec(content)) !== null) {
    if (lastPath && lastIndex > 0) {
      sections.push({
        filePath: lastPath,
        content: content.slice(lastIndex, match.index).trim(),
      });
    }
    lastPath = match[1];
    lastIndex = match.index + match[0].length;
  }

  if (lastPath) {
    sections.push({
      filePath: lastPath,
      content: content.slice(lastIndex).trim(),
    });
  }

  if (sections.length === 0) {
    // Single file output — no file markers found
    const artifact = saveArtifact(sessionId, 'code', content, createdBy);
    log.push(`Stored single artifact: ${artifact.id}`);
    artifacts.push(artifact);
  } else {
    for (const section of sections) {
      const artifact = saveArtifact(sessionId, 'code', section.content, createdBy, {
        filePath: section.filePath,
      });
      log.push(`Stored artifact for ${section.filePath}: ${artifact.id}`);
      artifacts.push(artifact);
    }
  }

  return artifacts;
}

// Self-register
const codegenAgent = new CodeGenAgent();
agentRegistry.register(codegenAgent);

export default codegenAgent;
