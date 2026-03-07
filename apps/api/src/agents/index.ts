/**
 * Import all agent modules to trigger self-registration.
 * This file must be imported at startup.
 */
import './codegen';
import './test';
import './reply-draft';
import './triage';
import './line-monitor';
import './file-analysis';

export { agentRegistry } from './registry';
export { BaseAgent } from './base';
export type { MemoryContext } from './base';
