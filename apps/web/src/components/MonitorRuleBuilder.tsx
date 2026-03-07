'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import type { MonitorRuleConditions, MonitorAction, MonitorRuleActionConfig, CommProvider, MonitorRule } from '@prism/shared';
import {
  fetchMonitorRules,
  createMonitorRule,
  updateMonitorRule,
  deleteMonitorRule,
  testMonitorRule,
} from '@/lib/api';

const PROVIDERS: { value: CommProvider | 'all'; label: string }[] = [
  { value: 'all', label: 'All Providers' },
  { value: 'outlook', label: 'Outlook' },
  { value: 'teams', label: 'Teams' },
  { value: 'line', label: 'LINE' },
];

const ACTIONS: { value: MonitorAction; label: string; description: string }[] = [
  { value: 'notify', label: 'Notify', description: 'Send a notification when matched' },
  { value: 'draft_reply', label: 'Draft Reply', description: 'Auto-draft a reply using AI' },
  { value: 'draft_and_notify', label: 'Draft + Notify', description: 'Draft a reply and notify' },
];

interface TestMatch {
  ruleId: string;
  ruleName: string;
  messageId: string;
  sender: string;
  subject: string | null;
  preview: string;
  timestamp: number;
}

export default function MonitorRuleBuilder() {
  const open = useChatStore((s) => s.commRuleBuilderOpen);
  const editingRule = useChatStore((s) => s.commEditingRule);
  const setOpen = useChatStore((s) => s.setCommRuleBuilderOpen);
  const setEditingRule = useChatStore((s) => s.setCommEditingRule);
  const setRules = useChatStore((s) => s.setCommRules);

  // Form state
  const [ruleName, setRuleName] = useState('');
  const [provider, setProvider] = useState<CommProvider | 'all'>('all');
  const [action, setAction] = useState<MonitorAction>('notify');
  const [keywords, setKeywords] = useState('');
  const [senders, setSenders] = useState('');
  const [subjectContains, setSubjectContains] = useState('');
  const [isGroup, setIsGroup] = useState<boolean | undefined>(undefined);
  const [startHour, setStartHour] = useState('');
  const [endHour, setEndHour] = useState('');
  const [tone, setTone] = useState('');
  const [instruction, setInstruction] = useState('');

  // List / test state
  const [rules, setLocalRules] = useState<MonitorRule[]>([]);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [testResults, setTestResults] = useState<TestMatch[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Load rules when opened
  useEffect(() => {
    if (open) {
      loadRules();
      if (editingRule) {
        populateForm(editingRule);
        setView('form');
      } else {
        setView('list');
      }
    }
  }, [open, editingRule]);

  async function loadRules() {
    const data = await fetchMonitorRules();
    setLocalRules(data);
    setRules(data);
  }

  function populateForm(rule: MonitorRule) {
    setRuleName(rule.ruleName);
    setProvider(rule.provider);
    setAction(rule.action);
    setKeywords(rule.conditions.keywords?.join(', ') ?? '');
    setSenders(rule.conditions.senders?.join(', ') ?? '');
    setSubjectContains(rule.conditions.subjectContains?.join(', ') ?? '');
    setIsGroup(rule.conditions.isGroup);
    setStartHour(rule.conditions.timeRange?.startHour?.toString() ?? '');
    setEndHour(rule.conditions.timeRange?.endHour?.toString() ?? '');
    setTone(rule.actionConfig?.tone ?? '');
    setInstruction(rule.actionConfig?.instruction ?? '');
  }

  function resetForm() {
    setRuleName('');
    setProvider('all');
    setAction('notify');
    setKeywords('');
    setSenders('');
    setSubjectContains('');
    setIsGroup(undefined);
    setStartHour('');
    setEndHour('');
    setTone('');
    setInstruction('');
    setTestResults(null);
    setEditingRule(null);
  }

  function buildConditions(): MonitorRuleConditions {
    const conditions: MonitorRuleConditions = {};
    const kw = keywords.split(',').map((s) => s.trim()).filter(Boolean);
    if (kw.length > 0) conditions.keywords = kw;
    const sn = senders.split(',').map((s) => s.trim()).filter(Boolean);
    if (sn.length > 0) conditions.senders = sn;
    const sc = subjectContains.split(',').map((s) => s.trim()).filter(Boolean);
    if (sc.length > 0) conditions.subjectContains = sc;
    if (isGroup !== undefined) conditions.isGroup = isGroup;
    if (startHour !== '' && endHour !== '') {
      conditions.timeRange = { startHour: parseInt(startHour, 10), endHour: parseInt(endHour, 10) };
    }
    return conditions;
  }

  function buildActionConfig(): MonitorRuleActionConfig | null {
    if (action === 'notify') return null;
    const config: MonitorRuleActionConfig = {};
    if (tone) config.tone = tone;
    if (instruction) config.instruction = instruction;
    if (Object.keys(config).length === 0) return null;
    return config;
  }

  async function handleSave() {
    if (!ruleName.trim()) return;
    setLoading(true);

    const conditions = buildConditions();
    const actionConfig = buildActionConfig();

    if (editingRule) {
      const updated = await updateMonitorRule(editingRule.id, {
        ruleName,
        provider,
        conditions,
        action,
        actionConfig,
      });
      if (updated) {
        await loadRules();
        resetForm();
        setView('list');
      }
    } else {
      const created = await createMonitorRule({
        provider,
        ruleName,
        conditions,
        action,
        actionConfig,
      });
      if (created) {
        await loadRules();
        resetForm();
        setView('list');
      }
    }

    setLoading(false);
  }

  async function handleDelete(id: string) {
    const ok = await deleteMonitorRule(id);
    if (ok) await loadRules();
  }

  async function handleToggle(rule: MonitorRule) {
    await updateMonitorRule(rule.id, { enabled: !rule.enabled });
    await loadRules();
  }

  async function handleTest(id: string) {
    setTestResults(null);
    const results = await testMonitorRule(id);
    setTestResults(results);
  }

  function handleClose() {
    setOpen(false);
    setEditingRule(null);
    resetForm();
    setView('list');
    setTestResults(null);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-sm font-semibold text-gray-200">Monitor Rules</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Auto-trigger actions when incoming messages match conditions
            </p>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-500 hover:text-gray-300 transition-colors text-lg"
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {view === 'list' && (
            <>
              {/* New Rule button */}
              <button
                onClick={() => { resetForm(); setView('form'); }}
                className="mb-4 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg transition-colors"
              >
                + New Rule
              </button>

              {rules.length === 0 && (
                <div className="text-center py-8">
                  <p className="text-sm text-gray-500 mb-2">No rules yet.</p>
                  <p className="text-xs text-gray-600">
                    Create a rule to auto-draft replies or get notified when messages match conditions.
                  </p>
                </div>
              )}

              {rules.length > 0 && (
                <div className="space-y-2">
                  {rules.map((rule) => (
                    <div
                      key={rule.id}
                      className="border border-gray-800 rounded-lg px-4 py-3 flex items-center gap-3"
                    >
                      {/* Toggle */}
                      <button
                        onClick={() => handleToggle(rule)}
                        className={`w-8 h-4 rounded-full transition-colors relative ${
                          rule.enabled ? 'bg-green-600' : 'bg-gray-700'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                            rule.enabled ? 'left-4' : 'left-0.5'
                          }`}
                        />
                      </button>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-200 truncate">
                            {rule.ruleName}
                          </span>
                          <span className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded capitalize">
                            {rule.provider}
                          </span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                            rule.action === 'notify'
                              ? 'bg-blue-600/20 text-blue-400'
                              : rule.action === 'draft_reply'
                                ? 'bg-green-600/20 text-green-400'
                                : 'bg-purple-600/20 text-purple-400'
                          }`}>
                            {rule.action.replace('_', ' ')}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {formatConditionsSummary(rule.conditions)}
                        </p>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleTest(rule.id)}
                          className="text-[10px] text-gray-500 hover:text-gray-300 px-2 py-1 rounded transition-colors"
                        >
                          Test
                        </button>
                        <button
                          onClick={() => { setEditingRule(rule); populateForm(rule); setView('form'); }}
                          className="text-[10px] text-gray-500 hover:text-gray-300 px-2 py-1 rounded transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(rule.id)}
                          className="text-[10px] text-red-400 hover:text-red-300 px-2 py-1 rounded transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Test results */}
              {testResults !== null && (
                <div className="mt-4 border-t border-gray-800 pt-4">
                  <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">
                    Test Results ({testResults.length} match{testResults.length !== 1 ? 'es' : ''})
                  </p>
                  {testResults.length === 0 && (
                    <p className="text-xs text-gray-600">No recent messages matched this rule.</p>
                  )}
                  {testResults.map((m) => (
                    <div key={m.messageId} className="bg-gray-800/50 rounded-lg px-3 py-2 mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-gray-300">{m.sender}</span>
                        {m.subject && (
                          <span className="text-[10px] text-gray-500 truncate">{m.subject}</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5 truncate">{m.preview}</p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {view === 'form' && (
            <div className="space-y-4">
              {/* Back button */}
              <button
                onClick={() => { resetForm(); setView('list'); }}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                &larr; Back to rules
              </button>

              {/* Rule name */}
              <div>
                <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                  Rule Name
                </label>
                <input
                  type="text"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  placeholder="e.g., Urgent Client Emails"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Provider + Action row */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                    Provider
                  </label>
                  <select
                    value={provider}
                    onChange={(e) => setProvider(e.target.value as CommProvider | 'all')}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                    Action
                  </label>
                  <select
                    value={action}
                    onChange={(e) => setAction(e.target.value as MonitorAction)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
                  >
                    {ACTIONS.map((a) => (
                      <option key={a.value} value={a.value}>{a.label}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-gray-600 mt-0.5">
                    {ACTIONS.find((a) => a.value === action)?.description}
                  </p>
                </div>
              </div>

              {/* Conditions */}
              <div className="border-t border-gray-800 pt-4">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">
                  Conditions (all must match)
                </p>

                <div className="space-y-3">
                  {/* Keywords */}
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1">
                      Keywords (comma-separated)
                    </label>
                    <input
                      type="text"
                      value={keywords}
                      onChange={(e) => setKeywords(e.target.value)}
                      placeholder="e.g., urgent, asap, critical"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  {/* Senders */}
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1">
                      Senders (comma-separated emails/IDs)
                    </label>
                    <input
                      type="text"
                      value={senders}
                      onChange={(e) => setSenders(e.target.value)}
                      placeholder="e.g., boss@company.com, vip@client.com"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  {/* Subject Contains */}
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1">
                      Subject Contains (comma-separated)
                    </label>
                    <input
                      type="text"
                      value={subjectContains}
                      onChange={(e) => setSubjectContains(e.target.value)}
                      placeholder="e.g., invoice, proposal, review"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  {/* Time Range + Group row */}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">
                        Start Hour (0-23)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={startHour}
                        onChange={(e) => setStartHour(e.target.value)}
                        placeholder="e.g., 9"
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">
                        End Hour (0-23)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={endHour}
                        onChange={(e) => setEndHour(e.target.value)}
                        placeholder="e.g., 17"
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">
                        Group Thread
                      </label>
                      <select
                        value={isGroup === undefined ? '' : isGroup ? 'true' : 'false'}
                        onChange={(e) => {
                          const val = e.target.value;
                          setIsGroup(val === '' ? undefined : val === 'true');
                        }}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
                      >
                        <option value="">Any</option>
                        <option value="true">Groups only</option>
                        <option value="false">Direct only</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              {/* Action Config (only for draft actions) */}
              {action !== 'notify' && (
                <div className="border-t border-gray-800 pt-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">
                    Draft Settings
                  </p>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">
                        Reply Tone
                      </label>
                      <select
                        value={tone}
                        onChange={(e) => setTone(e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
                      >
                        <option value="">Auto (from learning)</option>
                        <option value="formal">Formal</option>
                        <option value="casual">Casual</option>
                        <option value="friendly">Friendly</option>
                        <option value="technical">Technical</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-500 mb-1">
                        Custom Instruction
                      </label>
                      <textarea
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                        placeholder="e.g., Always acknowledge receipt and provide an ETA"
                        rows={2}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-none"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Save button */}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleSave}
                  disabled={!ruleName.trim() || loading}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs rounded-lg transition-colors"
                >
                  {loading ? 'Saving...' : editingRule ? 'Update Rule' : 'Create Rule'}
                </button>
                <button
                  onClick={() => { resetForm(); setView('list'); }}
                  className="px-4 py-2 text-gray-400 hover:text-gray-200 text-xs transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatConditionsSummary(conditions: MonitorRuleConditions): string {
  const parts: string[] = [];
  if (conditions.keywords?.length) {
    parts.push(`keywords: ${conditions.keywords.join(', ')}`);
  }
  if (conditions.senders?.length) {
    parts.push(`from: ${conditions.senders.join(', ')}`);
  }
  if (conditions.subjectContains?.length) {
    parts.push(`subject: ${conditions.subjectContains.join(', ')}`);
  }
  if (conditions.timeRange) {
    parts.push(`${conditions.timeRange.startHour}:00–${conditions.timeRange.endHour}:00`);
  }
  if (conditions.isGroup !== undefined) {
    parts.push(conditions.isGroup ? 'groups only' : 'direct only');
  }
  return parts.length > 0 ? parts.join(' · ') : 'No conditions (matches all)';
}
