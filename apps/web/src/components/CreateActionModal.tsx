'use client';

import { useEffect, useState } from 'react';
import type { ActionType, ActionChannelHint, ActionScenario, CreateActionRequest } from '@prism/shared';

const ACTION_TYPES: ActionType[] = ['email', 'message', 'summary', 'follow_up', 'custom'];
const CHANNEL_HINTS: ActionChannelHint[] = ['email', 'teams', 'line', 'manual', 'other'];
interface Props {
  open: boolean;
  selectedMessageIds?: string[];
  onClose: () => void;
  onCreate: (payload: CreateActionRequest) => Promise<void>;
}

export default function CreateActionModal({ open, selectedMessageIds = [], onClose, onCreate }: Props) {
  const [actionType, setActionType] = useState<ActionType>('email');
  const [scenario, setScenario] = useState<ActionScenario>('new');
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [instruction, setInstruction] = useState('');
  const [outputExpectation, setOutputExpectation] = useState('');
  const [channelHint, setChannelHint] = useState<ActionChannelHint>('email');
  const [replyTemplate, setReplyTemplate] = useState('');
  const [lastAutoFill, setLastAutoFill] = useState({ title: '', target: '', outputExpectation: '' });
  const [submitting, setSubmitting] = useState(false);

  const isReplyCapable = actionType === 'email' || actionType === 'message';
  const isReplyScenario = isReplyCapable && scenario === 'reply';

  useEffect(() => {
    if (!isReplyScenario) {
      setReplyTemplate('');
      setLastAutoFill({ title: '', target: '', outputExpectation: '' });
      return;
    }

    const suggestion = inferReplyTemplateDetails(replyTemplate, actionType);
    setTitle((prev) => replaceAutoFilledValue(prev, lastAutoFill.title, suggestion.title));
    setTarget((prev) => replaceAutoFilledValue(prev, lastAutoFill.target, suggestion.target));
    setOutputExpectation((prev) =>
      replaceAutoFilledValue(prev, lastAutoFill.outputExpectation, suggestion.outputExpectation),
    );
    setLastAutoFill(suggestion);
  }, [replyTemplate, actionType, isReplyScenario, lastAutoFill.title, lastAutoFill.target, lastAutoFill.outputExpectation]);

  if (!open) return null;

  function resetForm() {
    setActionType('email');
    setScenario('new');
    setTitle('');
    setTarget('');
    setInstruction('');
    setOutputExpectation('');
    setChannelHint('email');
    setReplyTemplate('');
    setLastAutoFill({ title: '', target: '', outputExpectation: '' });
  }

  async function handleSubmit() {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await onCreate({
        actionType,
        title: title.trim(),
        target: target.trim() || undefined,
        selectedMessageIds,
        actionScenario: scenario,
        sourceTemplate: isReplyScenario ? replyTemplate.trim() || undefined : undefined,
        instruction: instruction.trim() || undefined,
        channelHint,
        outputExpectation: outputExpectation.trim() || undefined,
      });
      resetForm();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[520px] max-w-[calc(100vw-2rem)] rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-100">Create Action</h2>
            <p className="mt-1 text-xs text-gray-500">
              Create an isolated action thread from this topic discussion.
            </p>
          </div>
          <button onClick={onClose} className="text-lg text-gray-500 hover:text-gray-300">&times;</button>
        </div>

        <div className="space-y-3 px-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-gray-400">
              Action Type
              <select
                value={actionType}
                onChange={(e) => setActionType(e.target.value as ActionType)}
                className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-2 text-sm text-gray-100"
              >
                {ACTION_TYPES.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-gray-400">
              Channel Hint
              <select
                value={channelHint}
                onChange={(e) => setChannelHint(e.target.value as ActionChannelHint)}
                className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-2 text-sm text-gray-100"
              >
                {CHANNEL_HINTS.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>

          {isReplyCapable && (
            <div className="grid grid-cols-2 gap-3">
              {([
                { value: 'new', label: `New ${actionType}` },
                { value: 'reply', label: `Reply to ${actionType}` },
              ] as const).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setScenario(option.value)}
                  className={`rounded border px-3 py-2 text-sm transition-colors ${
                    scenario === option.value
                      ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                      : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}

          <label className="block text-xs text-gray-400">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isReplyScenario ? `Reply to ${actionType}` : 'Draft customer email'}
              className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-2 text-sm text-gray-100"
            />
          </label>

          {isReplyScenario && (
            <label className="block text-xs text-gray-400">
              {actionType === 'email' ? 'Email template / original message' : 'Message template / original thread'}
              <textarea
                value={replyTemplate}
                onChange={(e) => setReplyTemplate(e.target.value)}
                rows={6}
                placeholder={
                  actionType === 'email'
                    ? 'Paste the email you want to reply to. Target and output expectation will be auto-filled from the content.'
                    : 'Paste the message or thread you want to reply to. Target and output expectation will be auto-filled from the content.'
                }
                className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-2 text-sm text-gray-100"
              />
            </label>
          )}

          <label className="block text-xs text-gray-400">
            Target Audience
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={isReplyScenario ? 'Auto-filled from template, editable' : 'Acme stakeholder / PM / vendor'}
              className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-2 text-sm text-gray-100"
            />
          </label>

          <label className="block text-xs text-gray-400">
            Instruction
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              placeholder={
                isReplyScenario
                  ? `Add any extra guidance for how to reply to this ${actionType}.`
                  : 'Politely summarize the issue and ask for next steps.'
              }
              className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-2 text-sm text-gray-100"
            />
          </label>

          <label className="block text-xs text-gray-400">
            Output Expectation
            <input
              value={outputExpectation}
              onChange={(e) => setOutputExpectation(e.target.value)}
              placeholder={isReplyScenario ? 'Auto-filled from template, editable' : 'Short professional email with clear CTA'}
              className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-2 text-sm text-gray-100"
            />
          </label>

          <div className="rounded border border-gray-800 bg-gray-950/60 px-3 py-2 text-xs text-gray-500">
            Context scope: {selectedMessageIds.length > 0 ? `${selectedMessageIds.length} selected message(s)` : 'Topic summary fallback'}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-800 px-4 py-3">
          <button
            onClick={() => {
              resetForm();
              onClose();
            }}
            className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !title.trim()}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating...' : 'Create Action'}
          </button>
        </div>
      </div>
    </div>
  );
}

function replaceAutoFilledValue(currentValue: string, previousAutoValue: string, nextAutoValue: string) {
  if (!currentValue.trim() || currentValue === previousAutoValue) {
    return nextAutoValue;
  }
  return currentValue;
}

function inferReplyTemplateDetails(template: string, actionType: ActionType) {
  const normalized = template.trim();
  if (!normalized) {
    return { title: '', target: '', outputExpectation: '' };
  }

  const signatureLine = inferSignatureLine(normalized);
  const subject =
    normalized.match(/^(?:subject|re)\s*:\s*(.+)$/im)?.[1]?.trim() ??
    normalized.match(/^\s*subject\s*:\s*(.+)$/im)?.[1]?.trim() ??
    null;
  const recipientLine =
    normalized.match(/^\s*(?:to|cc)\s*:\s*(.+)$/im)?.[1]?.trim() ??
    normalized.match(/^\s*(?:dear|hi|hello)\s+([^,\n:]+)[,:]?/im)?.[1]?.trim() ??
    normalized.match(/^\s*@([A-Za-z0-9_.-]+)/m)?.[1]?.trim() ??
    null;

  const recipient = cleanupAudience(signatureLine ?? recipientLine);
  const target = recipient ?? `Reply recipient (${actionType})`;
  const title = subject
    ? `Reply: ${subject}`
    : recipient
      ? `Reply to ${recipient}`
      : `Reply to ${actionType}`;

  const lower = normalized.toLowerCase();
  const actionIntent = inferReplyIntent(lower);
  const outputExpectation =
    actionType === 'email'
      ? `Professional email reply to ${target} that ${actionIntent}`
      : `Concise message reply to ${target} that ${actionIntent}`;

  return { title, target, outputExpectation };
}

function cleanupAudience(input: string | null) {
  if (!input) return null;
  return input
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/;+$/, '')
    .trim();
}

function inferSignatureLine(template: string) {
  const lines = template
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || line.length > 80) continue;
    if (/^(thanks|thank you|best|best regards|regards|cheers|sincerely|warm regards)[,!.\s]*$/i.test(line)) {
      const next = lines[i + 1];
      if (next && looksLikePersonName(next)) return next;
      continue;
    }
    if (/^[-–—]\s*[A-Za-z][A-Za-z .'-]{1,40}$/.test(line)) {
      return line.replace(/^[-–—]\s*/, '').trim();
    }
  }
  return null;
}

function looksLikePersonName(value: string) {
  return /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(value) && !/\b(team|support|hello|thanks|regards)\b/i.test(value);
}

function inferReplyIntent(lower: string) {
  if (/\b(confirm|confirmation|verify)\b/.test(lower)) {
    return 'confirms the requested details clearly';
  }
  if (/\b(send|share|provide|attach)\b/.test(lower)) {
    return 'answers the request and includes the requested information';
  }
  if (/\bapprove|approval\b/.test(lower)) {
    return 'gives a clear approval decision and next steps';
  }
  if (/\b(schedule|meeting|time|availability)\b/.test(lower)) {
    return 'proposes the next step and clarifies timing';
  }
  if (/\b(question|ask|could you|can you|please)\b/.test(lower)) {
    return 'responds to the questions directly and closes with the right call to action';
  }
  return 'addresses the message clearly and ends with an appropriate next step';
}
