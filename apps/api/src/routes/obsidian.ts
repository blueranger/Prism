import { Router } from 'express';
import { execFile } from 'child_process';
import type { ImportedSourceExportRequest, KnowledgeNoteExportRequest } from '@prism/shared';
import { getAppSetting, setAppSetting } from '../memory/settings-store';
import {
  assertImportedConversation,
  normalizeKnowledgeDestination,
} from '../services/import-transform-service';
import { exportImportedKnowledgeNoteWithWiki, exportImportedRawSourceWithWiki } from '../services/wiki-service';

const router = Router();
const OBSIDIAN_VAULT_PATH_KEY = 'obsidian_vault_path';

function normalizeVaultPath(rawValue: string): string {
  let value = rawValue.trim();
  if (!value) return '';

  // Handle users pasting a whole terminal line like "brian@Mac ~ % /Users/..."
  const absoluteMatch = value.match(/(\/Users\/.+|\/Volumes\/.+|~\/.+)$/);
  if (absoluteMatch?.[1]) {
    value = absoluteMatch[1].trim();
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }

  value = value.replace(/\\ /g, ' ');

  if (value.startsWith('~/')) {
    const home = process.env.HOME || '';
    value = home ? `${home}/${value.slice(2)}` : value;
  }

  // Remove trailing slash to keep stored path stable.
  value = value.replace(/\/+$/, '');
  return value;
}

router.get('/settings', (_req, res) => {
  res.json({
    vaultPath: getAppSetting(OBSIDIAN_VAULT_PATH_KEY),
  });
});

router.post('/settings', (req, res) => {
  const vaultPath = typeof req.body?.vaultPath === 'string' ? normalizeVaultPath(req.body.vaultPath) : '';
  if (!vaultPath) {
    return res.status(400).json({ error: 'vaultPath is required' });
  }
  setAppSetting(OBSIDIAN_VAULT_PATH_KEY, vaultPath);
  res.json({ ok: true, vaultPath });
});

router.post('/pick-folder', (_req, res) => {
  execFile(
    'osascript',
    [
      '-e',
      'POSIX path of (choose folder with prompt "Select your Obsidian vault")',
    ],
    (error, stdout) => {
      if (error) {
        console.error('[obsidian] pick folder failed:', error);
        return res.status(500).json({ error: 'Failed to pick Obsidian vault folder' });
      }
      const vaultPath = normalizeVaultPath(stdout || '');
      if (!vaultPath) {
        return res.status(400).json({ error: 'No folder selected' });
      }
      res.json({ ok: true, vaultPath });
    }
  );
});

router.post('/export/raw-source', async (req, res) => {
  try {
    const body = req.body as ImportedSourceExportRequest;
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : '';
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }
    const vaultPath = typeof body?.vaultPath === 'string' && body.vaultPath.trim()
      ? normalizeVaultPath(body.vaultPath)
      : getAppSetting(OBSIDIAN_VAULT_PATH_KEY);
    if (!vaultPath) {
      return res.status(400).json({ error: 'Obsidian vault path is not configured' });
    }

    const { conversation, messages } = assertImportedConversation(conversationId);
    const result = await exportImportedRawSourceWithWiki({ vaultPath, conversation, messages });
    res.json(result);
  } catch (error: any) {
    console.error('[obsidian] raw source export failed:', error);
    res.status(500).json({ error: error.message || 'Failed to export raw source note' });
  }
});

router.post('/export/knowledge-note', async (req, res) => {
  try {
    const body = req.body as KnowledgeNoteExportRequest;
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : '';
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!conversationId || !content) {
      return res.status(400).json({ error: 'conversationId and content are required' });
    }
    const vaultPath = typeof body?.vaultPath === 'string' && body.vaultPath.trim()
      ? normalizeVaultPath(body.vaultPath)
      : getAppSetting(OBSIDIAN_VAULT_PATH_KEY);
    if (!vaultPath) {
      return res.status(400).json({ error: 'Obsidian vault path is not configured' });
    }

    const { conversation } = assertImportedConversation(conversationId);
    const routing = normalizeKnowledgeDestination(typeof body?.destinationType === 'string' ? body.destinationType : undefined);
    const result = await exportImportedKnowledgeNoteWithWiki({
      vaultPath,
      conversation,
      content,
      title: body.title,
      destinationType: routing.destinationType,
      knowledgeMaturity: routing.knowledgeMaturity as 'context' | 'incubating' | 'evergreen',
      compilerRunId: typeof (body as any)?.compilerRunId === 'string' ? (body as any).compilerRunId : null,
    });
    res.json(result);
  } catch (error: any) {
    console.error('[obsidian] knowledge note export failed:', error);
    res.status(500).json({ error: error.message || 'Failed to export knowledge note' });
  }
});

router.post('/reveal', async (req, res) => {
  const filePath = typeof req.body?.filePath === 'string' ? req.body.filePath.trim() : '';
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }

  execFile('open', ['-R', filePath], (error) => {
    if (error) {
      console.error('[obsidian] reveal failed:', error);
      return res.status(500).json({ error: 'Failed to reveal file in Finder' });
    }
    res.json({ ok: true });
  });
});

export default router;
