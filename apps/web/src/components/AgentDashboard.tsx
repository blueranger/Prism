'use client';

import { useState, useEffect } from 'react';
import { MODELS } from '@prism/shared';
import { useChatStore } from '@/stores/chat-store';
import { fetchAgents, streamAgentPlan, executeAgentDirect, fetchAgentTasks } from '@/lib/api';

interface AgentInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

export default function AgentDashboard() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [instruction, setInstruction] = useState('');
  const [plannerModel, setPlannerModel] = useState('gpt-4o');

  // Direct execution state
  const [directAgent, setDirectAgent] = useState('');
  const [directInput, setDirectInput] = useState('');
  const [directResult, setDirectResult] = useState<{
    taskId: string;
    result: any;
  } | null>(null);

  const sessionId = useChatStore((s) => s.sessionId);
  const agentIsExecuting = useChatStore((s) => s.agentIsExecuting);
  const agentPlanSteps = useChatStore((s) => s.agentPlanSteps);
  const agentPlanReasoning = useChatStore((s) => s.agentPlanReasoning);
  const agentPlanMessage = useChatStore((s) => s.agentPlanMessage);
  const agentFinalResult = useChatStore((s) => s.agentFinalResult);
  const agentTasks = useChatStore((s) => s.agentTasks);
  const setAgentTasks = useChatStore((s) => s.setAgentTasks);

  const modelIds = Object.keys(MODELS);

  // Load agents on mount
  useEffect(() => {
    fetchAgents().then(setAgents);
  }, []);

  // Load tasks when session changes
  useEffect(() => {
    if (sessionId) {
      fetchAgentTasks(sessionId).then(setAgentTasks);
    }
  }, [sessionId, setAgentTasks]);

  const handlePlanExecute = () => {
    if (!sessionId || !instruction.trim() || agentIsExecuting) return;
    streamAgentPlan(sessionId, instruction.trim(), plannerModel);
    setInstruction('');
  };

  const handleDirectExecute = async () => {
    if (!sessionId || !directAgent || agentIsExecuting) return;
    let parsedInput: Record<string, unknown> = {};
    if (directInput.trim()) {
      try {
        parsedInput = JSON.parse(directInput);
      } catch {
        setDirectResult({
          taskId: '',
          result: { success: false, output: 'Invalid JSON input' },
        });
        return;
      }
    }
    const result = await executeAgentDirect(sessionId, directAgent, parsedInput);
    if (result) {
      setDirectResult(result);
      // Refresh tasks
      fetchAgentTasks(sessionId).then(setAgentTasks);
    }
  };

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0 overflow-auto">
      {!sessionId && (
        <div className="bg-yellow-900/20 border border-yellow-700 rounded-lg p-3">
          <p className="text-xs text-yellow-400">
            Send a prompt in Parallel mode first to create a session, then use agents.
          </p>
        </div>
      )}

      {/* Agent Plan Execution */}
      <section className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-200 mb-3">
          Plan &amp; Execute
        </h3>
        <p className="text-xs text-gray-500 mb-3">
          Describe a task and the planner will decompose it into agent steps.
        </p>

        <div className="flex gap-2 mb-3">
          <select
            value={plannerModel}
            onChange={(e) => setPlannerModel(e.target.value)}
            disabled={agentIsExecuting}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 disabled:opacity-50"
          >
            {modelIds.map((id) => (
              <option key={id} value={id}>
                {MODELS[id].displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="e.g. Generate a REST API for user management and write tests for it"
            disabled={agentIsExecuting || !sessionId}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handlePlanExecute();
            }}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          />
          <button
            onClick={handlePlanExecute}
            disabled={agentIsExecuting || !sessionId || !instruction.trim()}
            className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {agentIsExecuting ? 'Executing...' : 'Execute Plan'}
          </button>
        </div>

        {/* Plan progress */}
        {agentPlanMessage && (
          <div className="mt-3 text-xs text-indigo-400 animate-pulse">
            {agentPlanMessage}
          </div>
        )}

        {agentPlanSteps.length > 0 && (
          <div className="mt-3 space-y-2">
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Execution Plan
            </h4>

            {/* Planner reasoning */}
            {agentPlanReasoning && (
              <div className="px-3 py-2 bg-indigo-950/40 border border-indigo-800/50 rounded text-xs text-indigo-300 leading-relaxed whitespace-pre-wrap">
                <span className="font-semibold text-indigo-400">Planner reasoning: </span>
                {agentPlanReasoning}
              </div>
            )}

            {agentPlanSteps.map((step) => (
              <div
                key={step.id}
                className="flex items-center gap-3 px-3 py-2 bg-gray-800 rounded"
              >
                <StepStatusIcon status={step.status} />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium text-gray-200">
                    {step.target}
                  </span>
                  <span className="text-xs text-gray-500 ml-2">
                    {step.description}
                  </span>
                </div>
                {step.artifactCount !== undefined && step.artifactCount > 0 && (
                  <span className="text-xs text-green-400">
                    {step.artifactCount} artifact{step.artifactCount > 1 ? 's' : ''}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {agentFinalResult && (
          <div
            className={`mt-3 p-3 rounded text-xs ${
              agentFinalResult.success
                ? 'bg-green-900/20 border border-green-700 text-green-400'
                : 'bg-red-900/20 border border-red-700 text-red-400'
            }`}
          >
            {agentFinalResult.success
              ? `Plan completed successfully (${agentFinalResult.totalSteps} steps, ${agentFinalResult.artifacts.length} artifacts)`
              : `Plan failed after ${agentFinalResult.totalSteps} steps`}
          </div>
        )}
      </section>

      {/* Direct Agent Execution */}
      <section className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-200 mb-3">
          Direct Execution
        </h3>
        <p className="text-xs text-gray-500 mb-3">
          Execute a specific agent directly with custom input.
        </p>

        <div className="flex gap-2 mb-3">
          <select
            value={directAgent}
            onChange={(e) => setDirectAgent(e.target.value)}
            disabled={agentIsExecuting}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 disabled:opacity-50"
          >
            <option value="">Select agent</option>
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name} — {a.description.slice(0, 60)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={directInput}
            onChange={(e) => setDirectInput(e.target.value)}
            placeholder='JSON input, e.g. {"description": "a todo app"}'
            disabled={agentIsExecuting || !sessionId || !directAgent}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleDirectExecute();
            }}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          />
          <button
            onClick={handleDirectExecute}
            disabled={agentIsExecuting || !sessionId || !directAgent}
            className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Run
          </button>
        </div>

        {directResult && (
          <div className="mt-3">
            <div
              className={`p-3 rounded text-xs ${
                directResult.result?.success
                  ? 'bg-green-900/20 border border-green-700'
                  : 'bg-red-900/20 border border-red-700'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={
                    directResult.result?.success
                      ? 'text-green-400'
                      : 'text-red-400'
                  }
                >
                  {directResult.result?.success ? 'Success' : 'Failed'}
                </span>
                {directResult.taskId && (
                  <span className="text-gray-500">
                    Task: {directResult.taskId.slice(0, 8)}...
                  </span>
                )}
              </div>
              <pre className="text-gray-300 whitespace-pre-wrap max-h-60 overflow-auto">
                {typeof directResult.result?.output === 'string'
                  ? directResult.result.output.slice(0, 2000)
                  : JSON.stringify(directResult.result, null, 2).slice(0, 2000)}
              </pre>
            </div>
          </div>
        )}
      </section>

      {/* Task History */}
      {agentTasks.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-gray-200 mb-3">
            Task History
          </h3>
          <div className="space-y-2">
            {agentTasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-3 px-3 py-2 bg-gray-800 rounded text-xs"
              >
                <TaskStatusBadge status={task.status} />
                <span className="font-medium text-gray-200">
                  {task.agentName}
                </span>
                <span className="text-gray-500 truncate flex-1">
                  {JSON.stringify(task.input).slice(0, 80)}
                </span>
                <span className="text-gray-600 text-[10px]">
                  {new Date(task.createdAt).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return (
        <span className="w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
      );
    case 'completed':
      return <span className="w-4 h-4 rounded-full bg-green-500 text-[10px] flex items-center justify-center text-white">&#10003;</span>;
    case 'failed':
      return <span className="w-4 h-4 rounded-full bg-red-500 text-[10px] flex items-center justify-center text-white">&#10007;</span>;
    default:
      return <span className="w-4 h-4 rounded-full bg-gray-600" />;
  }
}

function TaskStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-gray-600 text-gray-300',
    running: 'bg-indigo-600 text-indigo-100',
    completed: 'bg-green-700 text-green-100',
    failed: 'bg-red-700 text-red-100',
  };

  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
        colors[status] ?? colors.pending
      }`}
    >
      {status}
    </span>
  );
}
