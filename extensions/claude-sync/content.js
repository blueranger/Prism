(function () {
  const API_BASE = 'http://localhost:3001';
  const CLAUDE_API_BASE = `${location.origin}/api`;
  const ROOT_ID = 'prism-claude-sync-root';
  const STYLE_ID = 'prism-claude-sync-style';
  const BUTTON_ID = 'prism-claude-sync-button';
  const STORAGE_KEY_LAST_SYNC = 'prism_claude_sync_last_summary_v1';
  const STORAGE_KEY_ORG_ID = 'prism_claude_sync_org_id_v1';
  const SYNC_BATCH_MAX_BYTES = 6 * 1024 * 1024;
  const SYNC_BATCH_MAX_ITEMS = 8;

  let detectedOrgId = null;
  let configuredOrgId = null;
  let discoveredOrganizations = [];
  let activeOrgId = null;
  let conversations = [];
  let projects = [];
  let filterText = '';
  let selectedProject = '';
  let loadingList = false;
  let syncing = false;
  let deleting = false;
  let deleteProgress = null;
  let lastSyncSummary = null;
  const selectedIds = new Set();

  injectBridge();
  ensureStyles();
  ensureLauncher();
  window.addEventListener('message', handleBridgeMessage);

  async function getStoredOrgId() {
    const result = await chrome.storage.local.get(STORAGE_KEY_ORG_ID);
    configuredOrgId = typeof result?.[STORAGE_KEY_ORG_ID] === 'string' && result[STORAGE_KEY_ORG_ID].trim()
      ? result[STORAGE_KEY_ORG_ID].trim()
      : null;
    return configuredOrgId;
  }

  async function setStoredOrgId(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    configuredOrgId = trimmed || null;
    await chrome.storage.local.set({ [STORAGE_KEY_ORG_ID]: configuredOrgId });
  }

  function injectBridge() {
    if (document.getElementById('prism-claude-sync-bridge')) return;
    const script = document.createElement('script');
    script.id = 'prism-claude-sync-bridge';
    script.src = chrome.runtime.getURL('injected.js');
    (document.head || document.documentElement).appendChild(script);
  }

  function requestClaudeContext() {
    window.postMessage(
      {
        source: 'prism-claude-sync-content',
        type: 'PRISM_REQUEST_CLAUDE_CONTEXT',
      },
      '*'
    );
  }

  function handleBridgeMessage(event) {
    if (event.source !== window) return;
    if (event.data?.source !== 'prism-claude-sync-page') return;
    if (event.data?.type !== 'PRISM_CLAUDE_CONTEXT_RESPONSE') return;
    detectedOrgId = typeof event.data.orgId === 'string' && event.data.orgId.trim() ? event.data.orgId.trim() : null;
    renderOrgStatus();
  }

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
        background: #c2410c;
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
        background: rgba(249, 115, 22, 0.14);
        color: #fdba74;
        border: 1px solid rgba(249, 115, 22, 0.3);
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
      #${ROOT_ID} .prism-primary { background: #c2410c; color: white; }
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
      #${ROOT_ID} .prism-org-row {
        display: flex;
        gap: 10px;
        align-items: center;
        margin-bottom: 12px;
      }
      #${ROOT_ID} .prism-org-row input {
        flex: 1;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureLauncher() {
    if (document.getElementById(BUTTON_ID)) return;
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.textContent = 'Sync Claude to Prism';
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
            <div class="prism-title">Sync Claude to Prism</div>
            <div class="prism-subtitle">Manual sync for selected Claude conversations into Prism Library</div>
          </div>
          <button class="prism-secondary" data-action="close">Close</button>
        </div>
        <div class="prism-org-row">
          <input data-role="org-id" type="text" placeholder="Claude organization ID (auto-detect if possible)" />
          <button class="prism-secondary" data-action="save-org">Save</button>
        </div>
        <div class="prism-inline-note" data-role="org-status"></div>
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
        <div class="prism-inline-note">Claude v1 sync target: http://localhost:3001/api/import/claude-sync</div>
        <div class="prism-inline-note">If org auto-detect fails, open Claude account settings and paste your organization ID here once.</div>
        <div class="prism-inline-note">Capture More tries to infer missing projects from the current page. Delete/archive is intentionally disabled in Claude v1.</div>
        <div class="prism-inline-note" data-role="last-sync"></div>
        <div class="prism-progress" data-role="progress" style="display:none"></div>
        <div class="prism-list" data-role="list"></div>
        <div class="prism-footer">
          <div class="prism-status" data-role="status"></div>
          <div class="prism-actions">
            <button class="prism-secondary" data-action="delete">Delete Selected</button>
            <button class="prism-secondary" data-action="close-footer">Cancel</button>
            <button class="prism-primary" data-action="sync">Sync Selected</button>
          </div>
        </div>
      </div>
    `;

    root.addEventListener('click', (event) => {
      if (event.target === root) closeModal();
    });
    root.querySelector('[data-action="close"]').addEventListener('click', closeModal);
    root.querySelector('[data-action="close-footer"]').addEventListener('click', closeModal);
    root.querySelector('[data-action="save-org"]').addEventListener('click', async () => {
      const value = root.querySelector('[data-role="org-id"]').value || '';
      await setStoredOrgId(value);
      renderOrgStatus();
      setStatus(configuredOrgId ? 'Saved Claude organization ID.' : 'Cleared Claude organization ID.', false);
    });
    root.querySelector('[data-action="capture-more"]').addEventListener('click', async () => {
      const discovered = await scrapeProjectsFromDom();
      projects = mergeProjects(projects, discovered);
      renderProjectOptions();
      setStatus(discovered.length > 0 ? `Captured ${discovered.length} project candidate(s) from the page.` : 'No additional project metadata found on this page.', false);
    });
    root.querySelector('[data-action="refresh"]').addEventListener('click', async () => {
      try {
        await loadConversations(true);
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });
    root.querySelector('[data-action="select-all"]').addEventListener('click', selectAllVisible);
    root.querySelector('[data-action="deselect-all"]').addEventListener('click', deselectAllVisible);
    root.querySelector('[data-action="delete"]').addEventListener('click', deleteSelected);
    root.querySelector('[data-action="sync"]').addEventListener('click', syncSelected);
    root.querySelector('[data-role="search"]').addEventListener('input', (event) => {
      filterText = event.target.value || '';
      renderList();
      setStatus(`${getVisibleSelectedCount()} conversation(s) selected in current view`, false);
    });
    root.querySelector('[data-role="project-select"]').addEventListener('change', (event) => {
      selectedProject = event.target.value || '';
      clearHiddenSelections();
      renderList();
      setStatus(`${getVisibleSelectedCount()} conversation(s) selected in current view`, false);
    });

    document.documentElement.appendChild(root);
    return root;
  }

  async function openModal() {
    const root = ensureRoot();
    root.classList.add('open');
    await getStoredOrgId();
    requestClaudeContext();
    loadRememberedSyncSummary();
    renderLastSyncSummary();
    renderOrgStatus();
    try {
      await Promise.all([loadOrganizations(), loadConversations(false), loadLatestSyncSummary()]);
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  }

  function closeModal() {
    const root = document.getElementById(ROOT_ID);
    if (root) root.classList.remove('open');
  }

  function renderOrgStatus() {
    const root = ensureRoot();
    const input = root.querySelector('[data-role="org-id"]');
    const status = root.querySelector('[data-role="org-status"]');
    const effectiveOrgId = activeOrgId || configuredOrgId || detectedOrgId || '';
    input.value = effectiveOrgId;
    if (activeOrgId && activeOrgId !== configuredOrgId) {
      status.textContent = `Using active organization ID from successful Claude API access: ${activeOrgId}`;
    } else if (configuredOrgId) {
      status.textContent = `Using saved organization ID: ${configuredOrgId}`;
    } else if (detectedOrgId) {
      status.textContent = `Auto-detected organization ID from the page: ${detectedOrgId}`;
    } else if (discoveredOrganizations.length > 0) {
      const [first] = discoveredOrganizations;
      status.textContent = `Detected Claude organization from API: ${first.name ? `${first.name} (${first.uuid})` : first.uuid}`;
    } else {
      status.textContent = 'Organization ID not detected yet. You can paste it manually if list loading fails.';
    }
  }

  async function ensureOrgId() {
    if (activeOrgId) return activeOrgId;
    if (configuredOrgId) return configuredOrgId;
    if (detectedOrgId) return detectedOrgId;
    if (discoveredOrganizations.length > 0) return discoveredOrganizations[0].uuid;
    requestClaudeContext();
    const started = Date.now();
    while (!configuredOrgId && !detectedOrgId && discoveredOrganizations.length === 0 && Date.now() - started < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (activeOrgId) return activeOrgId;
    if (configuredOrgId) return configuredOrgId;
    if (detectedOrgId) return detectedOrgId;
    if (discoveredOrganizations.length > 0) return discoveredOrganizations[0].uuid;
    try {
      await loadOrganizations();
    } catch {}
    return configuredOrgId || detectedOrgId || discoveredOrganizations[0]?.uuid || null;
  }

  async function loadOrganizations() {
    try {
      const response = await fetch(`${CLAUDE_API_BASE}/organizations`, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      if (!response.ok) return;
      const data = await response.json();
      discoveredOrganizations = normalizeOrganizations(data);
      if (!detectedOrgId && discoveredOrganizations.length > 0) {
        detectedOrgId = discoveredOrganizations[0].uuid;
      }
      renderOrgStatus();
    } catch (error) {
      console.warn('[prism-claude-sync] Failed to fetch organizations:', error);
    }
  }

  function normalizeOrganizations(data) {
    const rawItems = Array.isArray(data)
      ? data
      : Array.isArray(data?.organizations)
        ? data.organizations
        : Array.isArray(data?.data)
          ? data.data
          : [];

    const seen = new Map();
    for (const item of rawItems) {
      const uuid = typeof (item?.uuid || item?.id) === 'string' ? (item.uuid || item.id).trim() : '';
      if (!uuid) continue;
      if (seen.has(uuid)) continue;
      seen.set(uuid, {
        uuid,
        name: typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : '',
      });
    }
    return Array.from(seen.values());
  }

  async function loadConversations(forceReload) {
    if (loadingList) return;
    if (conversations.length > 0 && !forceReload) {
      renderList();
      return;
    }
    loadingList = true;
    renderList();
    try {
      const orgId = await ensureOrgId();
      if (!orgId) {
        throw new Error('Could not determine Claude organization ID. Paste it into the modal and retry.');
      }
      const { orgId: resolvedOrgId, items } = await fetchConversationListWithFallback(orgId);
      if (resolvedOrgId) {
        activeOrgId = resolvedOrgId;
        if (detectedOrgId !== resolvedOrgId) {
          detectedOrgId = resolvedOrgId;
        }
        renderOrgStatus();
      }
      conversations = items;
      projects = mergeProjects(extractProjectsFromConversations(items), await scrapeProjectsFromDom());
      renderProjectOptions();
      setStatus(`${conversations.length} conversations loaded`, false);
    } finally {
      loadingList = false;
      renderList();
    }
  }

  async function fetchConversationList(orgId) {
    const response = await fetch(`${CLAUDE_API_BASE}/organizations/${encodeURIComponent(orgId)}/chat_conversations`, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch Claude conversations (${response.status})`);
    }
    const data = await response.json();
    return normalizeConversationList(data);
  }

  async function fetchConversationListWithFallback(initialOrgId) {
    try {
      const items = await fetchConversationList(initialOrgId);
      return { orgId: initialOrgId, items };
    } catch (error) {
      const isForbidden = /403/.test(String(error?.message || error));
      if (!isForbidden) throw error;
    }

    await loadOrganizations();
    const alternatives = discoveredOrganizations
      .map((org) => org.uuid)
      .filter((uuid) => uuid && uuid !== initialOrgId);

    const failures = [`${initialOrgId}: 403`];
    for (const candidateOrgId of alternatives) {
      try {
        const items = await fetchConversationList(candidateOrgId);
        return { orgId: candidateOrgId, items };
      } catch (error) {
        failures.push(`${candidateOrgId}: ${error?.message || String(error)}`);
      }
    }

    throw new Error(`Failed to fetch Claude conversations (403). Tried orgs: ${failures.join(' | ')}`);
  }

  function normalizeConversationList(data) {
    const rawItems = Array.isArray(data)
      ? data
      : Array.isArray(data?.chat_conversations)
        ? data.chat_conversations
        : Array.isArray(data?.data)
          ? data.data
          : [];

    return rawItems
      .filter((item) => item && typeof (item.uuid || item.id) === 'string')
      .map((item) => ({
        uuid: item.uuid || item.id,
        name: typeof (item.name || item.title) === 'string' && (item.name || item.title).trim()
          ? (item.name || item.title).trim()
          : 'Untitled',
        created_at: item.created_at || null,
        updated_at: item.updated_at || item.last_message_at || null,
        model: item.model || null,
        project_uuid: item.project_uuid || item.project?.uuid || null,
        project_name: item.project_name || item.project?.name || '',
      }));
  }

  function extractProjectsFromConversations(items) {
    const seen = new Map();
    for (const item of items) {
      const name = typeof item.project_name === 'string' ? item.project_name.trim() : '';
      if (!name) continue;
      const id = typeof item.project_uuid === 'string' && item.project_uuid.trim()
        ? item.project_uuid.trim()
        : `name:${name}`;
      if (!seen.has(id)) {
        seen.set(id, { id, name, source: 'conversation' });
      }
    }
    return Array.from(seen.values());
  }

  async function scrapeProjectsFromDom() {
    const projectsFromDom = [];
    const candidates = Array.from(document.querySelectorAll('a, button, [data-testid], [role="link"]'));
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (!text || text.length < 2 || text.length > 80) continue;
      const href = typeof el.getAttribute === 'function' ? (el.getAttribute('href') || '') : '';
      if (!/project|folder/i.test(href) && !/project/i.test(text)) continue;
      const uuidMatch = href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
      projectsFromDom.push({
        id: uuidMatch?.[0] || `name:${text}`,
        name: text,
        source: 'dom',
      });
    }
    return mergeProjects([], projectsFromDom);
  }

  function mergeProjects(primary, secondary) {
    const map = new Map();
    for (const project of [...primary, ...secondary]) {
      if (!project?.id || !project?.name) continue;
      if (!map.has(project.id)) map.set(project.id, project);
    }
    return Array.from(map.values());
  }

  function renderProjectOptions() {
    const root = ensureRoot();
    const select = root.querySelector('[data-role="project-select"]');
    const previous = selectedProject;
    const options = ['<option value="">(all projects)</option>']
      .concat(projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`))
      .join('');
    select.innerHTML = options;
    selectedProject = projects.some((project) => project.id === previous) ? previous : '';
    select.value = selectedProject;
  }

  function getFilteredConversations() {
    const keyword = filterText.trim().toLowerCase();
    return conversations.filter((conversation) => {
      const matchesKeyword = !keyword || conversation.name.toLowerCase().includes(keyword);
      const matchesProject = !selectedProject ||
        conversation.project_uuid === selectedProject ||
        `name:${conversation.project_name}` === selectedProject;
      return matchesKeyword && matchesProject;
    });
  }

  function renderList() {
    const root = ensureRoot();
    const list = root.querySelector('[data-role="list"]');
    if (loadingList) {
      list.innerHTML = '<div class="prism-empty">Loading conversation list...</div>';
      return;
    }
    const filtered = getFilteredConversations();
    if (filtered.length === 0) {
      list.innerHTML = '<div class="prism-empty">No conversations found.</div>';
      return;
    }
    list.innerHTML = filtered.map((conversation, index) => {
      const checked = selectedIds.has(conversation.uuid) ? 'checked' : '';
      const updated = formatTimestamp(conversation.updated_at || conversation.created_at);
      const projectMeta = conversation.project_name ? ` · Project: ${escapeHtml(conversation.project_name)}` : '';
      const modelMeta = conversation.model ? ` · ${escapeHtml(conversation.model)}` : '';
      return `
        <label class="prism-row">
          <input type="checkbox" data-id="${conversation.uuid}" ${checked} />
          <div class="prism-row-index">${index + 1}</div>
          <div>
            <div class="prism-row-title">${escapeHtml(conversation.name)}</div>
            <div class="prism-row-meta">${updated}${projectMeta}${modelMeta}</div>
          </div>
          ${conversation.project_name ? `<span class="prism-badge">${escapeHtml(conversation.project_name)}</span>` : '<span></span>'}
        </label>
      `;
    }).join('');

    list.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.addEventListener('change', (event) => {
        const id = event.target.getAttribute('data-id');
        if (!id) return;
        if (event.target.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        setStatus(`${getVisibleSelectedCount()} conversation(s) selected in current view`, false);
      });
    });
  }

  function selectAllVisible() {
    clearHiddenSelections();
    for (const conversation of getFilteredConversations()) {
      selectedIds.add(conversation.uuid);
    }
    renderList();
    setStatus(`${getVisibleSelectedCount()} conversation(s) selected in current view`, false);
  }

  function deselectAllVisible() {
    for (const conversation of getFilteredConversations()) {
      selectedIds.delete(conversation.uuid);
    }
    renderList();
    setStatus(`${getVisibleSelectedCount()} conversation(s) selected in current view`, false);
  }

  function clearHiddenSelections() {
    const visibleIds = new Set(conversations.map((conversation) => conversation.uuid));
    for (const id of Array.from(selectedIds)) {
      if (!visibleIds.has(id)) selectedIds.delete(id);
    }
  }

  function getVisibleSelectedCount() {
    const visibleIds = new Set(getFilteredConversations().map((conversation) => conversation.uuid));
    let count = 0;
    for (const id of selectedIds) {
      if (visibleIds.has(id)) count += 1;
    }
    return count;
  }

  async function syncSelected() {
    if (syncing) return;
    if (selectedIds.size === 0) {
      setStatus('Select at least one conversation to sync.', true);
      return;
    }

    syncing = true;
    updateSyncButton();

    try {
      const orgId = await ensureOrgId();
      if (!orgId) throw new Error('Missing Claude organization ID.');

      const ids = Array.from(selectedIds);
      setStatus('Fetching selected Claude conversation details...', false);
      const selectedConversations = await fetchSelectedConversations(orgId, ids);
      if (selectedConversations.length === 0) {
        throw new Error('No valid Claude conversations were fetched for sync.');
      }

      const projectName = projects.find((project) => project.id === selectedProject)?.name || undefined;
      const batches = chunkConversationsForSync(selectedConversations, projectName);
      const syncRunId = makeSyncRunId();
      const aggregate = {
        requestedConversations: selectedConversations.length,
        processedConversations: 0,
        totalMessages: 0,
        overwrittenConversations: 0,
        importedConversations: 0,
        skippedConversations: 0,
        failedConversations: 0,
      };

      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        setStatus(
          `Sending batch ${index + 1} of ${batches.length} to Prism... (${batch.conversations.length} conversation(s))`,
          false
        );

        const response = await fetch(`${API_BASE}/api/import/claude-sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...batch,
            syncRunId,
            syncBatchIndex: index + 1,
            syncBatchCount: batches.length,
          }),
        });
        if (!response.ok) {
          const details = await response.text();
          throw new Error(`Batch ${index + 1}/${batches.length} failed: ${details}`);
        }

        const result = await response.json();
        aggregate.processedConversations += Number(result.processedConversations ?? 0);
        aggregate.totalMessages += Number(result.totalMessages ?? 0);
        aggregate.overwrittenConversations += Number(result.overwrittenConversations ?? 0);
        aggregate.importedConversations += Number(result.importedConversations ?? 0);
        aggregate.skippedConversations += Number(result.skippedConversations ?? 0);
      }

      lastSyncSummary = {
        syncRunId,
        projectName: projectName || null,
        requestedConversations: aggregate.requestedConversations,
        processedConversations: aggregate.processedConversations,
        importedConversations: aggregate.importedConversations,
        overwrittenConversations: aggregate.overwrittenConversations,
        skippedConversations: aggregate.skippedConversations,
        failedConversations: aggregate.failedConversations,
        totalMessages: aggregate.totalMessages,
        completedAt: new Date().toISOString(),
        batchCount: batches.length,
      };
      saveRememberedSyncSummary();
      renderLastSyncSummary();
      setStatus(
        `Synced ${aggregate.processedConversations} conversation(s), ${aggregate.totalMessages} messages` +
          (aggregate.overwrittenConversations > 0 ? `, ${aggregate.overwrittenConversations} updated` : '') +
          (batches.length > 1 ? ` across ${batches.length} batches` : ''),
        false
      );
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      syncing = false;
      updateSyncButton();
    }
  }

  async function fetchSelectedConversations(orgId, ids) {
    const results = [];
    const failures = [];
    const metadataById = new Map(conversations.map((conversation) => [conversation.uuid, conversation]));

    for (const id of ids) {
      try {
        const response = await fetch(
          `${CLAUDE_API_BASE}/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(id)}?tree=True&rendering_mode=messages&render_all_tools=true`,
          {
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
          }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const normalized = normalizeConversationForSync(payload, metadataById.get(id));
        if (!normalized) throw new Error('Missing conversation uuid or chat_messages in response');
        results.push(normalized);
      } catch (error) {
        failures.push(`${id}: ${error.message || String(error)}`);
      }
    }

    if (results.length === 0) {
      throw new Error(`Failed to fetch selected Claude conversations. ${failures.join(' | ')}`);
    }
    if (failures.length > 0) {
      setStatus(`Partial fetch failure: ${failures.join(' | ')}`, true);
    }
    return results;
  }

  function normalizeConversationForSync(payload, listItem) {
    if (!payload || typeof payload !== 'object') return null;
    const uuid = typeof (payload.uuid || payload.id) === 'string'
      ? (payload.uuid || payload.id).trim()
      : '';
    if (!uuid || !Array.isArray(payload.chat_messages)) return null;
    return {
      ...payload,
      uuid,
      name: payload.name || listItem?.name || 'Untitled',
      project_uuid: payload.project_uuid || listItem?.project_uuid || null,
      project_name: payload.project_name || listItem?.project_name || null,
      model: payload.model || listItem?.model || null,
    };
  }

  function chunkConversationsForSync(conversationsToSync, projectName) {
    const batches = [];
    let currentBatch = [];
    let currentBytes = estimatePayloadBytes(projectName, currentBatch);

    for (const conversation of conversationsToSync) {
      const nextBatch = currentBatch.concat(conversation);
      const nextBytes = estimatePayloadBytes(projectName, nextBatch);
      const shouldFlush =
        currentBatch.length > 0 &&
        (nextBatch.length > SYNC_BATCH_MAX_ITEMS || nextBytes > SYNC_BATCH_MAX_BYTES);

      if (shouldFlush) {
        batches.push({ projectName, conversations: currentBatch });
        currentBatch = [conversation];
        currentBytes = estimatePayloadBytes(projectName, currentBatch);
        continue;
      }

      currentBatch = nextBatch;
      currentBytes = nextBytes;

      if (currentBytes >= SYNC_BATCH_MAX_BYTES && currentBatch.length > 0) {
        batches.push({ projectName, conversations: currentBatch });
        currentBatch = [];
        currentBytes = estimatePayloadBytes(projectName, currentBatch);
      }
    }

    if (currentBatch.length > 0) {
      batches.push({ projectName, conversations: currentBatch });
    }

    return batches;
  }

  function estimatePayloadBytes(projectName, conversationsToSync) {
    return new Blob([
      JSON.stringify({
        projectName,
        conversations: conversationsToSync,
      }),
    ]).size;
  }

  function updateSyncButton() {
    const root = ensureRoot();
    const button = root.querySelector('[data-action="sync"]');
    button.disabled = syncing;
    button.textContent = syncing ? 'Syncing...' : 'Sync Selected';
  }

  function updateDeleteButton() {
    const root = ensureRoot();
    const button = root.querySelector('[data-action="delete"]');
    button.disabled = deleting;
    button.textContent = deleting ? 'Deleting...' : 'Delete Selected';
  }

  function renderDeleteProgress(done) {
    const root = ensureRoot();
    const panel = root.querySelector('[data-role="progress"]');
    if (!deleteProgress) {
      panel.style.display = 'none';
      panel.textContent = '';
      return;
    }

    panel.style.display = 'block';
    const remaining = Math.max(deleteProgress.total - deleteProgress.completed - deleteProgress.failed, 0);
    const currentLine = deleteProgress.currentTitle
      ? `Current: ${deleteProgress.currentTitle}`
      : done
        ? 'Delete run completed.'
        : 'Preparing delete requests...';

    panel.textContent =
      `Deleting ${deleteProgress.total} conversation(s). ` +
      `Completed: ${deleteProgress.completed}. ` +
      `Failed: ${deleteProgress.failed}. ` +
      `Remaining: ${remaining}. ${currentLine}`;

    if (done) {
      window.setTimeout(() => {
        deleteProgress = null;
        renderDeleteProgress(false);
      }, 4000);
    }
  }

  function setStatus(message, isError) {
    const root = ensureRoot();
    const status = root.querySelector('[data-role="status"]');
    status.textContent = message || '';
    status.style.color = isError ? '#fca5a5' : '#cbd5e1';
  }

  async function loadLatestSyncSummary() {
    try {
      const response = await fetch(`${API_BASE}/api/import/claude-sync/latest`);
      if (!response.ok) return;
      const data = await response.json();
      if (data?.run) {
        lastSyncSummary = {
          syncRunId: data.run.id,
          projectName: data.run.projectName || null,
          requestedConversations: data.run.requestedConversations ?? 0,
          processedConversations: data.run.processedConversations ?? 0,
          importedConversations: data.run.importedConversations ?? 0,
          overwrittenConversations: data.run.overwrittenConversations ?? 0,
          skippedConversations: data.run.skippedConversations ?? 0,
          failedConversations: data.run.failedConversations ?? 0,
          totalMessages: data.run.totalMessages ?? 0,
          completedAt: data.run.completedAt || data.run.updatedAt || data.run.startedAt,
          batchCount: data.run.batchCount ?? 1,
          status: data.run.status,
        };
        saveRememberedSyncSummary();
        renderLastSyncSummary();
      }
    } catch (error) {
      console.warn('[prism-claude-sync] Failed to load latest sync summary:', error);
    }
  }

  function renderLastSyncSummary() {
    const root = ensureRoot();
    const el = root.querySelector('[data-role="last-sync"]');
    if (!el) return;
    if (!lastSyncSummary?.completedAt) {
      el.textContent = 'Last sync: not available yet.';
      return;
    }
    const segments = [
      `Last sync: ${formatTimestamp(lastSyncSummary.completedAt)}`,
      `Processed ${lastSyncSummary.processedConversations || 0}`,
    ];
    if (lastSyncSummary.importedConversations) segments.push(`Imported ${lastSyncSummary.importedConversations}`);
    if (lastSyncSummary.overwrittenConversations) segments.push(`Updated ${lastSyncSummary.overwrittenConversations}`);
    if (lastSyncSummary.failedConversations) segments.push(`Failed ${lastSyncSummary.failedConversations}`);
    if (lastSyncSummary.projectName) segments.push(`Project ${lastSyncSummary.projectName}`);
    el.textContent = segments.join(' · ');
  }

  function loadRememberedSyncSummary() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_LAST_SYNC);
      if (!raw) return;
      lastSyncSummary = JSON.parse(raw);
    } catch (error) {
      console.warn('[prism-claude-sync] Failed to read local sync summary:', error);
    }
  }

  function saveRememberedSyncSummary() {
    try {
      localStorage.setItem(STORAGE_KEY_LAST_SYNC, JSON.stringify(lastSyncSummary));
    } catch (error) {
      console.warn('[prism-claude-sync] Failed to persist local sync summary:', error);
    }
  }

  function makeSyncRunId() {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
    return `claude-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function formatTimestamp(value) {
    if (!value) return 'Unknown time';
    const timestamp = typeof value === 'number' ? value * 1000 : Date.parse(value);
    if (!Number.isFinite(timestamp)) return 'Unknown time';
    return new Date(timestamp).toLocaleString();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function deleteSelected() {
    if (deleting) return;
    if (selectedIds.size === 0) {
      setStatus('Select at least one conversation to delete.', true);
      return;
    }

    const totalToDelete = selectedIds.size;
    deleting = true;
    deleteProgress = {
      total: totalToDelete,
      completed: 0,
      failed: 0,
      currentTitle: '',
    };
    updateDeleteButton();
    renderDeleteProgress();

    try {
      const orgId = await ensureOrgId();
      if (!orgId) throw new Error('Missing Claude organization ID.');

      const ids = Array.from(selectedIds);
      let deletedCount = 0;
      const failures = [];

      for (const id of ids) {
        const conversation = conversations.find((item) => item.uuid === id);
        if (deleteProgress) {
          deleteProgress.currentTitle = conversation?.name || id;
          renderDeleteProgress();
        }

        try {
          const response = await fetch(
            `${CLAUDE_API_BASE}/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(id)}`,
            {
              method: 'DELETE',
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
              },
            }
          );

          if (!response.ok) {
            let details = '';
            try {
              details = await response.text();
            } catch {}
            throw new Error(`HTTP ${response.status}${details ? ` ${details.slice(0, 160)}` : ''}`);
          }

          deletedCount++;
          selectedIds.delete(id);
          if (deleteProgress) {
            deleteProgress.completed += 1;
            renderDeleteProgress();
          }
        } catch (error) {
          failures.push(`${id}: ${error.message || String(error)}`);
          if (deleteProgress) {
            deleteProgress.failed += 1;
            renderDeleteProgress();
          }
        }
      }

      conversations = conversations.filter((conversation) => !ids.includes(conversation.uuid));
      renderList();

      if (failures.length > 0) {
        setStatus(`Deleted ${deletedCount}. Failures: ${failures.join(' | ')}`, true);
      } else {
        setStatus(`Deleted ${deletedCount} conversation(s). List refreshed.`, false);
      }
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      deleting = false;
      if (deleteProgress) {
        deleteProgress.currentTitle = '';
        renderDeleteProgress(true);
      }
      updateDeleteButton();
    }
  }
})();
