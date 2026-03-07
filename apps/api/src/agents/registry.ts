import type { AgentToolDefinition } from '@prism/shared';
import { BaseAgent } from './base';

/**
 * AgentRegistry — singleton registry for all available agents.
 *
 * Agents self-register at import time. The Orchestrator and LLM tool-use
 * layer query the registry to discover available agents and their schemas.
 */
class AgentRegistry {
  private agents = new Map<string, BaseAgent>();

  register(agent: BaseAgent): void {
    if (this.agents.has(agent.name)) {
      throw new Error(`Agent "${agent.name}" is already registered`);
    }
    this.agents.set(agent.name, agent);
  }

  get(name: string): BaseAgent | undefined {
    return this.agents.get(name);
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  list(): BaseAgent[] {
    return Array.from(this.agents.values());
  }

  names(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Export all agents as tool definitions for LLM function-calling.
   * Each agent becomes a tool the LLM can invoke.
   */
  toToolDefinitions(): AgentToolDefinition[] {
    return this.list().map((agent) => ({
      name: agent.name,
      description: agent.description,
      parameters: agent.inputSchema,
    }));
  }
}

export const agentRegistry = new AgentRegistry();
