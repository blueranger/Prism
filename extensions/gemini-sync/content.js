(function () {
  const API_BASE = 'http://localhost:3001';
  const ROOT_ID = 'prism-gemini-sync-root';
  const STYLE_ID = 'prism-gemini-sync-style';
  const BUTTON_ID = 'prism-gemini-sync-button';
  const STORAGE_KEY_LAST_SYNC = 'prism_gemini_sync_last_summary_v1';
  const SYNC_BATCH_MAX_BYTES = 6 * 1024 * 1024;
  const SYNC_BATCH_MAX_ITEMS = 8;

  let conversations = [];
  let projects = [];
  let filterText = '';
  let selectedProject = '';
  let loadingList = false;
  let syncing = false;
  let lastSyncSummary = null;
  const selectedIds = new Set();

  ensureStyles();
  ensureLauncher();

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID} {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483646;
        border: 0;
        border-radius: 999px;
        padding: 10px 16px;
        background: #2563eb;
        color: white;
        font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
        cursor: pointer;
      }
      #${ROOT_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: none;
        background: rgba(3, 7, 18, 0.7);
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${ROOT_ID}.open { display: flex; }
      #${ROOT_ID} .prism-modal {
        width: min(920px, calc(100vw - 32px));
        max-height: min(760px, calc(100vh - 32px));
        background: #0b1220;
        color: #e5e7eb;
        border: 1px solid #1f2937;
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
        display: flex;
        flex-direction: column;
      }
      #${ROOT_ID} .prism-header, #${ROOT_ID} .prism-toolbar, #${ROOT_ID} .prism-footer {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      #${ROOT_ID} .prism-header { justify-content: space-between; margin-bottom: 12px; }
      #${ROOT_ID} .prism-title { font-size: 18px; font-weight: 700; }
      #${ROOT_ID} .prism-subtitle { color: #94a3b8; font-size: 12px; margin-top: 2px; }
      #${ROOT_ID} .prism-toolbar { margin-bottom: 12px; flex-wrap: wrap; }
      #${ROOT_ID} .prism-toolbar-secondary { margin-top: -4px; }
      #${ROOT_ID} input[type="text"], #${ROOT_ID} select {
        background: #111827;
        color: #e5e7eb;
        border: 1px solid #374151;
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 13px;
      }
      #${ROOT_ID} .prism-search { flex: 1; min-width: 220px; }
      #${ROOT_ID} .prism-list {
        border: 1px solid #1f2937;
        background: #07101d;
        border-radius: 14px;
        overflow: auto;
        min-height: 280px;
        flex: 1;
      }
      #${ROOT_ID} .prism-row {
        display: grid;
        grid-template-columns: 28px 42px 1fr auto;
        gap: 10px;
        align-items: start;
        padding: 12px 14px;
        border-bottom: 1px solid #111827;
      }
      #${ROOT_ID} .prism-row:last-child { border-bottom: 0; }
      #${ROOT_ID} .prism-row:hover { background: rgba(17, 24, 39, 0.9); }
      #${ROOT_ID} .prism-row-index {
        font-size: 12px;
        color: #64748b;
        padding-top: 2px;
        text-align: right;
      }
      #${ROOT_ID} .prism-row-title { font-size: 13px; font-weight: 600; color: #f8fafc; }
      #${ROOT_ID} .prism-row-meta { font-size: 11px; color: #94a3b8; margin-top: 4px; }
      #${ROOT_ID} .prism-badge {
        display: inline-block;
        background: rgba(59, 130, 246, 0.14);
        color: #93c5fd;
        border: 1px solid rgba(59, 130, 246, 0.3);
        border-radius: 999px;
        padding: 4px 8px;
        font-size: 10px;
        font-weight: 700;
      }
      #${ROOT_ID} .prism-footer { justify-content: space-between; margin-top: 12px; flex-wrap: wrap; }
      #${ROOT_ID} .prism-status { color: #cbd5e1; font-size: 12px; min-height: 18px; }
      #${ROOT_ID} .prism-actions { display: flex; gap: 10px; }
      #${ROOT_ID} button {
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
      }
      #${ROOT_ID} .prism-secondary { background: #1f2937; color: #e5e7eb; }
      #${ROOT_ID} .prism-primary { background: #2563eb; color: white; }
      #${ROOT_ID} .prism-primary[disabled], #${ROOT_ID} .prism-secondary[disabled] {
        opacity: 0.55;
        cursor: not-allowed;
      }
      #${ROOT_ID} .prism-empty { padding: 32px 16px; color: #94a3b8; text-align: center; font-size: 13px; }
      #${ROOT_ID} .prism-inline-note { font-size: 11px; color: #94a3b8; }
      #${ROOT_ID} .prism-inline-note + .prism-inline-note { margin-top: 4px; }
      #${ROOT_ID} .prism-progress {
        margin: 10px 0 0;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid #1f2937;
        background: #111827;
        font-size: 12px;
        color: #cbd5e1;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureLauncher() {
    if (document.getElementById(BUTTON_ID)) return;
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.textContent = 'Sync Gemini to Prism';
    button.addEventListener('click', openModal);
    document.documentElement.appendChild(button);
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="prism-modal" role="dialog" aria-modal="true">
        <div class="prism-header">
          <div>
            <div class="prism-title">Sync Gemini to Prism</div>
            <div class="prism-subtitle">Manual sync for selected Gemini conversations into Prism Library</div>
          </div>
          <button class="prism-secondary" data-action="close">Close</button>
        </div>
        <div class="prism-toolbar">
          <input class="prism-search" data-role="search" type="text" placeholder="Filter conversations by title" />
          <select data-role="project-select"><option value="">(all projects)</option></select>
          <button class="prism-secondary" data-action="capture-more">Capture More</button>
          <button class="prism-secondary" data-action="refresh">Refresh</button>
        </div>
        <div class="prism-toolbar prism-toolbar-secondary">
          <button class="prism-secondary" data-action="select-all">Select All</button>
          <button class="prism-secondary" data-action="deselect-all">Deselect All</button>
        </div>
        <div class="prism-inline-note">Gemini v1 sync target: http://localhost:3001/api/import/gemini-sync</div>
        <div class="prism-inline-note">This sync reads visible Gemini history and scrapes selected conversation pages into a portable format for Prism.</div>
        <div class="prism-inline-note">Capture More scrolls Gemini history containers to find older conversations.</div>
        <div class="prism-inline-note">Delete is intentionally disabled in Gemini v1 because Gemini's web UI appears to require trusted user gestures for destructive actions.</div>
        <div class="prism-inline-note" data-role="last-sync"></div>
        <div class="prism-progress" data-role="progress" style="display:none"></div>
        <div class="prism-list" data-role="list"></div>
        <div class="prism-footer">
          <div class="prism-status" data-role="status"></div>
          <div class="prism-actions">
            <button class="prism-secondary" data-action="close-footer">Cancel</button>
            <button class="prism-primary" data-action="sync">Sync Selected</button>
          </div>
        </div>
      </div>
    `;
    root.addEventListener('click', (event) => {
      const action = event.target instanceof HTMLElement ? event.target.getAttribute('data-action') : null;
      if (!action) {
        if (event.target === root) closeModal();
        return;
      }
      if (action === 'close' || action === 'close-footer') closeModal();
      else if (action === 'refresh') void loadConversations(true);
      else if (action === 'capture-more') void captureMoreConversations();
      else if (action === 'select-all') selectAllVisible();
      else if (action === 'deselect-all') {
        selectedIds.clear();
        renderConversationList();
        updateSyncButton();
      } else if (action === 'sync') {
        void syncSelected();
      }
    });
    root.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches('[data-role="project-select"]')) {
        selectedProject = target.value;
        renderConversationList();
      }
      if (target.matches('input[type="checkbox"][data-conversation-id]')) {
        const id = target.getAttribute('data-conversation-id');
        if (!id) return;
        if (target.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        updateSyncButton();
      }
    });
    root.querySelector('[data-role="search"]')?.addEventListener('input', (event) => {
      filterText = event.target.value || '';
      renderConversationList();
    });
    document.documentElement.appendChild(root);
    return root;
  }

  function getRoot() {
    return ensureRoot();
  }

  function getFilteredConversations() {
    const term = filterText.trim().toLowerCase();
    return conversations.filter((conv) => {
      const matchesProject = !selectedProject || (conv.projectId || '') === selectedProject;
      const title = (conv.title || '').toLowerCase();
      const matchesText = !term || title.includes(term);
      return matchesProject && matchesText;
    });
  }

  function renderProjectOptions() {
    const select = getRoot().querySelector('[data-role="project-select"]');
    if (!select) return;
    const options = ['<option value="">(all projects)</option>'];
    for (const project of projects) {
      const selected = project.id === selectedProject ? ' selected' : '';
      options.push(`<option value="${escapeHtml(project.id)}"${selected}>${escapeHtml(project.name)}</option>`);
    }
    select.innerHTML = options.join('');
  }

  function renderConversationList() {
    const list = getRoot().querySelector('[data-role="list"]');
    if (!list) return;
    if (loadingList) {
      list.innerHTML = '<div class="prism-empty">Loading conversation list...</div>';
      return;
    }
    const filtered = getFilteredConversations();
    if (filtered.length === 0) {
      list.innerHTML = `<div class="prism-empty">${conversations.length === 0 ? 'No conversations found.' : 'No conversations match the current filter.'}</div>`;
      return;
    }
    list.innerHTML = filtered.map((conv, index) => {
      const checked = selectedIds.has(conv.id) ? 'checked' : '';
      const updated = conv.updatedAt ? new Date(conv.updatedAt).toLocaleString() : '';
      const meta = [conv.projectName, updated].filter(Boolean).join(' · ');
      return `
        <label class="prism-row">
          <div class="prism-row-index">${index + 1}</div>
          <input type="checkbox" data-conversation-id="${escapeHtml(conv.id)}" ${checked} />
          <div>
            <div class="prism-row-title">${escapeHtml(conv.title || 'Untitled Gemini Conversation')}</div>
            <div class="prism-row-meta">${escapeHtml(meta || conv.id)}</div>
          </div>
          <span class="prism-badge">${conv.turnEstimate || '?'} turns</span>
        </label>
      `;
    }).join('');
  }

  function renderStatus(message, isError = false) {
    const status = getRoot().querySelector('[data-role="status"]');
    if (!status) return;
    status.textContent = message || '';
    status.style.color = isError ? '#fca5a5' : '#cbd5e1';
  }

  function renderProgress(message) {
    const progress = getRoot().querySelector('[data-role="progress"]');
    if (!progress) return;
    if (!message) {
      progress.style.display = 'none';
      progress.textContent = '';
      return;
    }
    progress.style.display = 'block';
    progress.textContent = message;
  }

  function renderLastSync() {
    const node = getRoot().querySelector('[data-role="last-sync"]');
    if (!node) return;
    if (!lastSyncSummary) {
      node.textContent = 'Last sync: not available yet.';
      return;
    }
    const when = lastSyncSummary.completedAt || lastSyncSummary.updatedAt || lastSyncSummary.createdAt;
    const timeText = when ? new Date(when).toLocaleString() : 'unknown';
    const parts = [
      `Last sync: ${timeText}`,
      `Processed ${lastSyncSummary.processedConversations}`,
      `Updated ${lastSyncSummary.overwrittenConversations ?? 0}`,
    ];
    if (lastSyncSummary.projectName) parts.push(`Project ${lastSyncSummary.projectName}`);
    node.textContent = parts.join(' · ');
  }

  function updateSyncButton() {
    const button = getRoot().querySelector('[data-action="sync"]');
    if (!button) return;
    button.disabled = syncing || loadingList || selectedIds.size === 0;
  }

  function getSelectedProjectName() {
    if (!selectedProject) return '';
    return projects.find((project) => project.id === selectedProject)?.name || selectedProject;
  }

  function openModal() {
    const root = getRoot();
    root.classList.add('open');
    renderProjectOptions();
    renderConversationList();
    renderLastSync();
    updateSyncButton();
    void loadLatestSyncSummary();
    if (conversations.length === 0) {
      void loadConversations(false);
    }
  }

  function closeModal() {
    getRoot().classList.remove('open');
  }

  function uniqueById(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (!item?.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  function parseConversationIdFromHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      const match = url.pathname.match(/\/app\/([^/?#]+)/);
      return match?.[1] || null;
    } catch {
      const match = String(href).match(/\/app\/([^/?#]+)/);
      return match?.[1] || null;
    }
  }

  function inferProjectNameFromElement(el) {
    const section = el.closest('section,[role="navigation"],nav,aside,div');
    if (!section) return '';
    const heading = section.querySelector('h1,h2,h3,h4,[role="heading"]');
    return heading?.textContent?.trim() || '';
  }

  function estimateTurnsFromDocument(doc) {
    return scrapeConversationChunks(doc).length;
  }

  function scanSidebarConversations() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/app/"]'));
    const results = anchors.map((anchor) => {
      const id = parseConversationIdFromHref(anchor.getAttribute('href') || anchor.href);
      const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
      if (!id || !text) return null;
      const projectName = inferProjectNameFromElement(anchor);
      return {
        id,
        title: text,
        projectId: projectName || '',
        projectName: projectName || '',
        updatedAt: new Date().toISOString(),
        turnEstimate: id === getCurrentConversationId() ? estimateTurnsFromDocument(document) : null,
      };
    }).filter(Boolean);
    return uniqueById(results);
  }

  function detectProjects(convs) {
    return uniqueById(
      convs
        .filter((conv) => conv.projectId && conv.projectName)
        .map((conv) => ({ id: conv.projectId, name: conv.projectName }))
    );
  }

  async function loadConversations(forceReload) {
    if (loadingList && !forceReload) return;
    loadingList = true;
    renderStatus('Loading Gemini conversations...');
    renderConversationList();
    try {
      conversations = scanSidebarConversations();
      projects = detectProjects(conversations);
      renderProjectOptions();
      renderConversationList();
      renderStatus(conversations.length > 0
        ? `Loaded ${conversations.length} Gemini conversation(s).`
        : 'No Gemini conversations found. Open the sidebar/history and try Capture More.');
    } catch (error) {
      console.error('[prism-gemini-sync] Failed to load conversations:', error);
      conversations = [];
      projects = [];
      renderProjectOptions();
      renderConversationList();
      renderStatus(error?.message || 'Failed to load Gemini conversations.', true);
    } finally {
      loadingList = false;
      updateSyncButton();
      renderConversationList();
    }
  }

  async function captureMoreConversations() {
    renderStatus('Scanning for more Gemini conversations...');
    for (const node of getScrollableHistoryNodes()) {
      await autoScrollNode(node);
    }
    await loadConversations(true);
  }

  function getScrollableHistoryNodes() {
    const nodes = Array.from(document.querySelectorAll('nav, aside, [role="navigation"], div')).filter((node) => {
      const el = node;
      return el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 120;
    });
    return nodes.slice(0, 6);
  }

  async function autoScrollNode(node) {
    const step = Math.max(240, Math.floor(node.clientHeight * 0.8));
    for (let i = 0; i < 8; i += 1) {
      node.scrollTop += step;
      await delay(250);
    }
  }

  function getCurrentConversationId() {
    const match = location.pathname.match(/\/app\/([^/?#]+)/);
    return match?.[1] || null;
  }

  function getTopLevelCandidates(doc) {
    const selectors = [
      'user-query',
      'model-response',
      '[data-turn-role]',
      '[data-message-author]',
      '[data-author-role]',
      '[data-testid*="user"]',
      '[data-testid*="model"]',
      '[data-testid*="response"]',
      '[data-testid*="query"]',
      'message-content',
    ];
    const all = [];
    for (const selector of selectors) {
      for (const node of doc.querySelectorAll(selector)) {
        all.push(node);
      }
    }
    return uniqueNodes(all);
  }

  function uniqueNodes(nodes) {
    const seen = new Set();
    return nodes.filter((node) => {
      if (!(node instanceof Element)) return false;
      if (seen.has(node)) return false;
      seen.add(node);
      return true;
    });
  }

  function inferRole(node) {
    const combined = [
      node.tagName,
      node.getAttribute('data-turn-role'),
      node.getAttribute('data-message-author'),
      node.getAttribute('data-author-role'),
      node.getAttribute('data-testid'),
      node.getAttribute('aria-label'),
      node.className,
    ].filter(Boolean).join(' ').toLowerCase();
    if (/\b(user|query|prompt)\b/.test(combined)) return 'USER';
    if (/\b(model|assistant|response|gemini)\b/.test(combined)) return 'MODEL';
    return null;
  }

  function normalizeText(text) {
    return (text || '').replace(/\u00a0/g, ' ').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function stripLeadingRoleLabels(text) {
    if (!text) return '';
    const patterns = [
      /^你說了[:：]?\s*/i,
      /^你说了[:：]?\s*/i,
      /^gemini\s*說了[:：]?\s*/i,
      /^gemini\s*说了[:：]?\s*/i,
      /^gemini\s+said[:：]?\s*/i,
      /^you\s+said[:：]?\s*/i,
    ];
    const cleanedLines = text
      .split('\n')
      .map((line) => {
        let current = line;
        for (const pattern of patterns) {
          if (pattern.test(current.trim())) {
            current = current.trim().replace(pattern, '').trim();
          }
        }
        return current;
      })
      .filter((line, index, lines) => {
        if (!line.trim()) return true;
        const lower = line.trim().toLowerCase();
        if (lower === '你說了' || lower === '你说了' || lower === 'gemini說了' || lower === 'gemini说了' || lower === 'gemini said' || lower === 'you said') {
          return false;
        }
        return true;
      });
    return normalizeText(cleanedLines.join('\n'));
  }

  function isBlockTag(tagName) {
    return new Set([
      'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER',
      'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR', 'TD', 'TH',
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    ]).has(tagName);
  }

  function serializeNodeToText(node, context = {}) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || '';
    }
    if (!(node instanceof Element)) return '';

    const tag = node.tagName.toUpperCase();
    if (tag === 'BR') return '\n';
    if (tag === 'HR') return '\n---\n';

    const childText = Array.from(node.childNodes)
      .map((child) => serializeNodeToText(child, { ...context, parentTag: tag }))
      .join('');

    const normalizedChild = childText.replace(/[ \t]+\n/g, '\n');

    if (tag === 'LI') {
      const marker = context.parentTag === 'OL' ? '1. ' : '- ';
      return `${marker}${normalizedChild.trim()}\n`;
    }
    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      return `${'#'.repeat(level)} ${normalizedChild.trim()}\n\n`;
    }
    if (tag === 'BLOCKQUOTE') {
      const lines = normalizedChild
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `> ${line}`);
      return `${lines.join('\n')}\n\n`;
    }
    if (tag === 'PRE') {
      return `\n${normalizedChild.trimEnd()}\n\n`;
    }
    if (tag === 'P' || tag === 'SECTION' || tag === 'ARTICLE') {
      return `${normalizedChild.trim()}\n\n`;
    }
    if (tag === 'UL' || tag === 'OL') {
      return `${normalizedChild.trimEnd()}\n\n`;
    }
    if (tag === 'TABLE') {
      return `${normalizedChild.trim()}\n\n`;
    }
    if (tag === 'TR') {
      return `${normalizedChild.trim()}\n`;
    }
    if (tag === 'TD' || tag === 'TH') {
      return `${normalizedChild.trim()} | `;
    }
    if (tag === 'CODE') {
      return `\`${normalizedChild.trim()}\``;
    }
    if (tag === 'STRONG' || tag === 'B') {
      const value = normalizedChild.trim();
      return value ? `**${value}**` : '';
    }
    if (tag === 'EM' || tag === 'I') {
      const value = normalizedChild.trim();
      return value ? `*${value}*` : '';
    }
    if (tag === 'A') {
      const value = normalizedChild.trim();
      const href = node.getAttribute('href') || '';
      if (value && href) return `[${value}](${href})`;
      return value;
    }
    if (tag === 'SPAN' && !isBlockTag(tag)) {
      return normalizedChild;
    }
    if (tag === 'DIV' && !normalizedChild.includes('\n')) {
      return `${normalizedChild.trim()}\n\n`;
    }
    if (isBlockTag(tag)) {
      return `${normalizedChild.trim()}\n\n`;
    }
    return normalizedChild;
  }

  function extractText(node) {
    const clone = node.cloneNode(true);
    for (const removable of clone.querySelectorAll('button, svg, script, style, [aria-hidden="true"], [role="button"]')) {
      removable.remove();
    }
    const structured = serializeNodeToText(clone).replace(/[ \t]+\n/g, '\n');
    return stripLeadingRoleLabels(normalizeText(structured));
  }

  function isLikelyShellOrScriptText(text) {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) return true;
    const suspiciousSignals = [
      'function(',
      'use strict',
      'webpack',
      '__next',
      'copyright google llc',
      'spdx-license-identifier',
      'sourceurl=',
      'var __',
      'google inc.',
    ];
    const hitCount = suspiciousSignals.reduce((count, signal) => count + (normalized.includes(signal) ? 1 : 0), 0);
    return hitCount >= 2;
  }

  function scrapeConversationChunks(doc) {
    const candidates = getTopLevelCandidates(doc);
    const chunks = [];
    const usedTexts = new Set();
    for (const node of candidates) {
      const role = inferRole(node);
      const content = extractText(node);
      if (!role || !content || content.length < 2) continue;
      if (usedTexts.has(`${role}:${content}`)) continue;
      usedTexts.add(`${role}:${content}`);
      chunks.push({
        type: role,
        content,
        timestamp: null,
      });
    }

    if (chunks.length >= 2) return chunks;

    const fallbackBlocks = Array.from(doc.querySelectorAll('main [dir="auto"], main article, main section, main p'))
      .map((node) => normalizeText(node.innerText || node.textContent || ''))
      .filter((text) => text.length > 20);
    const dedup = [];
    for (const text of fallbackBlocks) {
      if (!dedup.includes(text)) dedup.push(text);
    }
    return dedup.slice(0, 20).map((content, index) => ({
      type: index % 2 === 0 ? 'USER' : 'MODEL',
      content,
      timestamp: null,
    }));
  }

  function cleanFallbackLines(lines, conversationTitle) {
    const banned = new Set([
      'close',
      'refresh',
      'capture more',
      'select all',
      'deselect all',
      'sync selected',
      'cancel',
      'gemini',
      'google',
    ]);
    const title = normalizeText(conversationTitle || '').toLowerCase();
    const results = [];
    for (const line of lines) {
      const normalized = normalizeText(line);
      if (!normalized || normalized.length < 12) continue;
      const lower = normalized.toLowerCase();
      if (banned.has(lower)) continue;
      if (title && lower === title) continue;
      if (results.includes(normalized)) continue;
      results.push(normalized);
    }
    return results;
  }

  function buildCoarseChunksFromDocument(doc, conversationTitle) {
    const root = doc.querySelector('main,[role="main"],body') || doc.body;
    if (!root) return [];
    const rawText = normalizeText(root.innerText || root.textContent || '');
    if (!rawText || rawText.length < 30) return [];
    if (isLikelyShellOrScriptText(rawText)) return [];

    const lines = cleanFallbackLines(rawText.split('\n'), conversationTitle);
    const combined = normalizeText(lines.join('\n\n')).slice(0, 24000);
    if (!combined || combined.length < 30) return [];
    if (isLikelyShellOrScriptText(combined)) return [];

    const chunks = [];
    const title = normalizeText(conversationTitle || '');
    if (title) {
      chunks.push({
        type: 'USER',
        content: title,
        timestamp: null,
      });
    }
    chunks.push({
      type: 'MODEL',
      content: combined,
      timestamp: null,
    });
    return chunks;
  }

  function scrapeCurrentConversationDocument(conversation) {
    const chunks = scrapeConversationChunks(document);
    const fallbackChunks = chunks.length === 0 ? buildCoarseChunksFromDocument(document, conversation.title) : [];
    const finalChunks = chunks.length > 0 ? chunks : fallbackChunks;
    const scrapeMode = chunks.length > 0 ? 'current_document' : 'current_document_coarse_fallback';
    if (finalChunks.length === 0) {
      throw new Error(`Could not extract Gemini messages from current page for ${conversation.title || conversation.id}`);
    }
    return {
      id: conversation.id,
      title: conversation.title,
      createTime: null,
      updatedAt: conversation.updatedAt || new Date().toISOString(),
      projectId: conversation.projectId || null,
      projectName: conversation.projectName || null,
      chunks: finalChunks,
      metadata: {
        sourceUrl: location.href,
        scrapeMode,
      },
    };
  }

  function findConversationAnchor(id) {
    return Array.from(document.querySelectorAll('a[href*="/app/"]')).find((anchor) => {
      return parseConversationIdFromHref(anchor.getAttribute('href') || anchor.href) === id;
    }) || null;
  }

  async function navigateToConversationInPage(conversation) {
    if (getCurrentConversationId() === conversation.id) return;
    const anchor = findConversationAnchor(conversation.id);
    if (!anchor) {
      throw new Error(`Gemini conversation ${conversation.title || conversation.id} is not available in the current sidebar history. Use Capture More and try again.`);
    }

    anchor.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
    }));

    const start = Date.now();
    let lastError = null;
    while (Date.now() - start < 15000) {
      if (getCurrentConversationId() === conversation.id) {
        try {
          const scraped = scrapeCurrentConversationDocument(conversation);
          if (scraped.chunks.length > 0) return;
        } catch (error) {
          lastError = error;
        }
      }
      await delay(500);
    }
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error(`Timed out opening Gemini conversation ${conversation.title || conversation.id} in the current page`);
  }

  async function scrapeConversationById(conversation) {
    if (getCurrentConversationId() !== conversation.id) {
      await navigateToConversationInPage(conversation);
      await delay(600);
    }
    return scrapeCurrentConversationDocument(conversation);
  }

  function estimatePayloadBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }

  function buildBatches(items) {
    const batches = [];
    let current = [];
    let currentBytes = 0;
    for (const item of items) {
      const bytes = estimatePayloadBytes(item);
      const wouldOverflow = current.length >= SYNC_BATCH_MAX_ITEMS || (current.length > 0 && currentBytes + bytes > SYNC_BATCH_MAX_BYTES);
      if (wouldOverflow) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(item);
      currentBytes += bytes;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  async function syncSelected() {
    if (syncing || selectedIds.size === 0) return;
    syncing = true;
    updateSyncButton();
    renderStatus('Preparing selected Gemini conversations...');
    try {
      const selected = conversations.filter((conv) => selectedIds.has(conv.id));
      if (selected.length === 0) throw new Error('No Gemini conversations selected.');

      const scraped = [];
      for (let index = 0; index < selected.length; index += 1) {
        const conversation = selected[index];
        renderProgress(`Scraping Gemini conversation ${index + 1}/${selected.length}: ${conversation.title || conversation.id}`);
        scraped.push(await scrapeConversationById(conversation));
      }

      const batches = buildBatches(scraped);
      let latestResult = null;
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex];
        renderProgress(`Syncing batch ${batchIndex + 1}/${batches.length} to Prism...`);
        const response = await fetch(`${API_BASE}/api/import/gemini-sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectName: getSelectedProjectName() || undefined,
            syncRunId: makeSyncRunId(),
            syncBatchIndex: batchIndex + 1,
            syncBatchCount: batches.length,
            conversations: batch,
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        latestResult = await response.json();
      }

      renderProgress('');
      renderStatus(`Synced ${scraped.length} Gemini conversation(s) to Prism.`);
      if (latestResult?.syncRun) {
        lastSyncSummary = latestResult.syncRun;
        await persistLastSyncSummary(lastSyncSummary);
        renderLastSync();
      } else {
        await loadLatestSyncSummary();
      }
    } catch (error) {
      console.error('[prism-gemini-sync] Sync failed:', error);
      renderProgress('');
      renderStatus(error?.message || 'Failed to sync Gemini conversations.', true);
    } finally {
      syncing = false;
      updateSyncButton();
    }
  }

  async function loadLatestSyncSummary() {
    try {
      const response = await fetch(`${API_BASE}/api/import/gemini-sync/latest`);
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      lastSyncSummary = data.run ?? null;
      if (!lastSyncSummary) {
        lastSyncSummary = await readStoredLastSyncSummary();
      }
      renderLastSync();
    } catch (error) {
      console.warn('[prism-gemini-sync] Failed to load latest sync summary:', error);
      lastSyncSummary = await readStoredLastSyncSummary();
      renderLastSync();
    }
  }

  async function readStoredLastSyncSummary() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_LAST_SYNC);
      return result?.[STORAGE_KEY_LAST_SYNC] || null;
    } catch (error) {
      console.warn('[prism-gemini-sync] Failed to read local sync summary:', error);
      return null;
    }
  }

  async function persistLastSyncSummary(summary) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY_LAST_SYNC]: summary });
    } catch (error) {
      console.warn('[prism-gemini-sync] Failed to persist local sync summary:', error);
    }
  }

  function selectAllVisible() {
    for (const conv of getFilteredConversations()) {
      selectedIds.add(conv.id);
    }
    renderConversationList();
    updateSyncButton();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function makeSyncRunId() {
    return `gemini-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
