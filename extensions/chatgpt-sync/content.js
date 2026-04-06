(function () {
  const API_BASE = 'http://localhost:3001';
  const BACKEND_BASE = `${location.origin}/backend-api`;
  const PROJECTS_API = `${BACKEND_BASE}/gizmos/snorlax/sidebar?conversations_per_gizmo=0`;
  const SYNC_BATCH_MAX_BYTES = 6 * 1024 * 1024;
  const SYNC_BATCH_MAX_ITEMS = 10;
  const MORE_CAPTURE_STABLE_MS = 1800;
  const MORE_CAPTURE_POLL_MS = 350;
  const LAST_SYNC_STORAGE_KEY = 'prism_chatgpt_sync_last_summary_v1';
  const ROOT_ID = 'prism-chatgpt-sync-root';
  const STYLE_ID = 'prism-chatgpt-sync-style';
  const BUTTON_ID = 'prism-chatgpt-sync-button';
  const CAPTURE_ID = 'prism-chatgpt-sync-capture';

  let accessToken = null;
  let conversations = [];
  let globalConversations = [];
  let projects = [];
  let capturedProjects = [];
  let loadingList = false;
  let loadingProjects = false;
  let syncing = false;
  let deleting = false;
  let deleteProgress = null;
  let lastSyncSummary = null;
  let modalReopenAfterAutoCapture = false;
  let projectDebug = {
    apiProjects: [],
    domProjects: [],
    mergedProjects: [],
    popupProjects: [],
  };
  let selectedProject = '';
  let filterText = '';
  const selectedIds = new Set();

  injectBridge();
  ensureStyles();
  ensureLauncher();
  window.addEventListener('message', handleBridgeMessage);

  function injectBridge() {
    if (document.getElementById('prism-chatgpt-sync-bridge')) return;
    const script = document.createElement('script');
    script.id = 'prism-chatgpt-sync-bridge';
    script.src = chrome.runtime.getURL('injected.js');
    (document.head || document.documentElement).appendChild(script);
  }

  function handleBridgeMessage(event) {
    if (event.source !== window) return;
    if (event.data?.source !== 'prism-chatgpt-sync-page') return;
    if (event.data?.type !== 'PRISM_TOKEN_RESPONSE') return;
    accessToken = typeof event.data.token === 'string' && event.data.token ? event.data.token : null;
  }

  function requestToken() {
    window.postMessage(
      {
        source: 'prism-chatgpt-sync-content',
        type: 'PRISM_REQUEST_TOKEN',
      },
      '*'
    );
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
        background: #0f766e;
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
        background: rgba(16, 185, 129, 0.14);
        color: #a7f3d0;
        border: 1px solid rgba(16, 185, 129, 0.3);
        border-radius: 999px;
        padding: 4px 8px;
        font-size: 10px;
        font-weight: 700;
      }
      #${ROOT_ID} .prism-footer {
        justify-content: space-between;
        margin-top: 12px;
        flex-wrap: wrap;
      }
      #${ROOT_ID} .prism-status {
        color: #cbd5e1;
        font-size: 12px;
        min-height: 18px;
      }
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
      #${ROOT_ID} .prism-primary { background: #0f766e; color: white; }
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
      #${ROOT_ID} .prism-debug {
        margin: 10px 0 0;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid #243041;
        background: #0f172a;
        font-size: 11px;
        color: #94a3b8;
        max-height: 180px;
        overflow: auto;
      }
      #${ROOT_ID} .prism-debug summary {
        cursor: pointer;
        color: #cbd5e1;
      }
      #${ROOT_ID} .prism-debug pre {
        margin: 8px 0 0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #${CAPTURE_ID} {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        display: none;
        padding: 12px 16px;
        border-radius: 12px;
        background: #0f172a;
        border: 1px solid #334155;
        color: #e5e7eb;
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
        font: 600 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureLauncher() {
    if (document.getElementById(BUTTON_ID)) return;
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.textContent = 'Sync to Prism';
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
            <div class="prism-title">Sync ChatGPT to Prism</div>
            <div class="prism-subtitle">Manual sync for selected conversations into Prism Library</div>
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
        <div class="prism-inline-note">
          Project selector first loads visible ChatGPT projects from the API, then tries to auto-open Projects > More to capture hidden projects. If anything is still missing, use "Capture More" as a manual fallback.
        </div>
        <div class="prism-inline-note">
          Prism API target: http://localhost:3001/api/import/chatgpt-sync
        </div>
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
    root.querySelector('[data-action="capture-more"]').addEventListener('click', captureMoreProjectsFlow);
    root.querySelector('[data-action="refresh"]').addEventListener('click', async () => {
      try {
        await Promise.all([loadProjects(), loadConversations(true)]);
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
    root.querySelector('[data-role="project-select"]').addEventListener('change', async (event) => {
      selectedProject = event.target.value || '';
      clearHiddenSelections();
      try {
        await loadConversations(true);
        setStatus(`${getVisibleSelectedCount()} conversation(s) selected in current view`, false);
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });

    document.documentElement.appendChild(root);
    return root;
  }

  async function openModal() {
    const root = ensureRoot();
    root.classList.add('open');
    setStatus('Loading projects and conversations...', false);
    loadRememberedSyncSummary();
    renderLastSyncSummary();
    requestToken();
    try {
      await Promise.all([loadProjects(), loadConversations(false), loadLatestSyncSummary()]);
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  }

  function closeModal() {
    const root = document.getElementById(ROOT_ID);
    if (root) root.classList.remove('open');
    hideCaptureBanner();
  }

  async function loadProjects() {
    if (loadingProjects) return;
    loadingProjects = true;
    try {
      const token = await ensureToken();
      if (!token) throw new Error('Could not read ChatGPT session token.');

      let apiProjects = [];
      const response = await fetch(PROJECTS_API, {
        headers: buildHeaders(token),
        credentials: 'include',
      });
      if (response.ok) {
        const data = await response.json();
        apiProjects = normalizeProjects(data);
      } else {
        console.warn('[prism-sync] project API returned', response.status);
      }

      let domProjects = await scrapeProjectsFromDom();
      if (shouldAttemptAutoMoreCapture(apiProjects, domProjects)) {
        const autoCapturedProjects = await autoCaptureMoreProjects();
        if (autoCapturedProjects.length > 0) {
          capturedProjects = mergeProjects(capturedProjects, autoCapturedProjects);
          domProjects = mergeProjects(domProjects, autoCapturedProjects);
        }
      }
      const rememberedProjects = mergeProjects(domProjects, capturedProjects);
      projects = mergeProjects(apiProjects, rememberedProjects);
      projectDebug = {
        apiProjects,
        domProjects: rememberedProjects,
        mergedProjects: projects,
        popupProjects: rememberedProjects.filter((item) => item.source === 'dom-popup'),
      };
      renderProjectDebug();
      if (projects.length === 0) {
        throw new Error('No ChatGPT projects found from API or page.');
      }
      renderProjectOptions();
    } finally {
      loadingProjects = false;
    }
  }

  async function loadConversations(forceReload) {
    if (loadingList) return;
    if (!selectedProject && globalConversations.length > 0 && !forceReload) {
      conversations = globalConversations;
      renderList();
      setStatus(`${conversations.length} conversations loaded`, false);
      return;
    }

    loadingList = true;
    renderList();

    try {
      const token = await ensureToken();
      if (!token) throw new Error('Could not read ChatGPT session token. Refresh the page and try again.');

      const items = selectedProject
        ? await fetchProjectConversationList(token, selectedProject)
        : await fetchGlobalConversationList(token);

      if (!selectedProject) {
        globalConversations = items;
      }
      conversations = items;
      setStatus(`${conversations.length} conversations loaded`, false);
    } catch (error) {
      setStatus(error.message || String(error), true);
      throw error;
    } finally {
      loadingList = false;
      renderList();
    }
  }

  async function ensureToken() {
    if (accessToken) return accessToken;
    requestToken();
    const started = Date.now();
    while (!accessToken && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return accessToken;
  }

  async function fetchGlobalConversationList(token) {
    const all = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const url = `${BACKEND_BASE}/conversations?offset=${offset}&limit=${limit}&order=updated`;
      const response = await fetch(url, {
        headers: buildHeaders(token),
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch conversations (${response.status})`);
      }

      const data = await response.json();
      const items = normalizeConversationList(data);
      all.push(...items);

      if (items.length < limit) break;
      offset += items.length;
    }

    return all;
  }

  async function fetchProjectConversationList(token, projectId) {
    if (projectId.startsWith('name:')) {
      const projectName = projectId.slice('name:'.length);
      const source = globalConversations.length > 0 ? globalConversations : await fetchGlobalConversationList(token);
      return source.filter((item) => item.projectName === projectName);
    }

    const all = [];
    let cursor = 0;
    const limit = 50;

    while (true) {
      const url = `${BACKEND_BASE}/gizmos/${encodeURIComponent(projectId)}/conversations?cursor=${cursor}&limit=${limit}`;
      const response = await fetch(url, {
        headers: buildHeaders(token),
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch project conversations (${response.status})`);
      }

      const data = await response.json();
      const items = normalizeConversationList(data).map((item) => ({
        ...item,
        projectId,
        projectName: projects.find((project) => project.id === projectId)?.name || item.projectName,
      }));
      all.push(...items);

      if (items.length < limit) break;
      cursor += items.length;
    }

    return all;
  }

  function normalizeConversationList(data) {
    const rawItems = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.conversations)
          ? data.conversations
          : [];

    return rawItems
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'Untitled',
        update_time: item.update_time || item.updated_at || null,
        create_time: item.create_time || item.created_at || null,
        is_archived: Boolean(item.is_archived),
        projectName: extractProjectName(item),
        projectId: extractProjectId(item),
      }));
  }

  function normalizeProjects(data) {
    const items = Array.isArray(data?.items) ? data.items : [];
    return items
      .map((item) => {
        const gizmo = item?.gizmo?.gizmo ?? item?.gizmo ?? item;
        const id = normalizeProjectId(gizmo?.id ?? gizmo?.gizmo_id ?? gizmo?.gizmo ?? gizmo?.uuid);
        const name = gizmo?.display?.name ?? gizmo?.display_name ?? gizmo?.name ?? gizmo?.title;
        if (typeof id !== 'string' || !id.trim()) return null;
        if (typeof name !== 'string' || !name.trim()) return null;
        return { id: id.trim(), name: name.trim(), source: 'api' };
      })
      .filter(Boolean);
  }

  function mergeProjects(apiProjects, domProjects) {
    const map = new Map();
    for (const project of [...apiProjects, ...domProjects]) {
      if (!project?.id || !project?.name) continue;
      const canonicalId = normalizeProjectId(project.id);
      const normalizedProject = canonicalId === project.id ? project : { ...project, id: canonicalId };
      if (!map.has(canonicalId)) {
        map.set(canonicalId, normalizedProject);
      }
    }
    return Array.from(map.values());
  }

  function renderProjectDebug() {
    const root = ensureRoot();
    const panel = root.querySelector('[data-role="project-debug"]');
    if (!panel) return;
    const formatItems = (items) => {
      if (!items.length) return '(none)';
      return items.map((item) => `- [${item.source || 'unknown'}] ${item.name} :: ${item.id}`).join('\n');
    };

    panel.textContent =
      `API projects: ${projectDebug.apiProjects.length}\n` +
      `${formatItems(projectDebug.apiProjects)}\n\n` +
      `DOM projects: ${projectDebug.domProjects.length}\n` +
      `${formatItems(projectDebug.domProjects)}\n\n` +
      `Popup-only projects: ${projectDebug.popupProjects.length}\n` +
      `${formatItems(projectDebug.popupProjects)}\n\n` +
      `Merged projects: ${projectDebug.mergedProjects.length}\n` +
      `${formatItems(projectDebug.mergedProjects)}`;
  }

  function renderProjectOptions() {
    const root = ensureRoot();
    const select = root.querySelector('[data-role="project-select"]');
    const previous = selectedProject;
    const options = ['<option value="">(all projects)</option>']
      .concat(
        projects.map((project) => {
          const safeId = escapeHtml(project.id);
          const safeName = escapeHtml(project.name);
          return `<option value="${safeId}">${safeName}</option>`;
        })
      )
      .join('');

    select.innerHTML = options;
    const keep = projects.some((project) => project.id === previous) ? previous : '';
    select.value = keep;
    selectedProject = keep;
  }

  function getFilteredConversations() {
    const keyword = filterText.trim().toLowerCase();
    return conversations.filter((conversation) => {
      const matchesKeyword = !keyword || conversation.title.toLowerCase().includes(keyword);
      return matchesKeyword;
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

    list.innerHTML = filtered
      .map((conversation, index) => {
        const checked = selectedIds.has(conversation.id) ? 'checked' : '';
        const updated = formatTimestamp(conversation.update_time || conversation.create_time);
        const projectMeta = conversation.projectName ? ` · Project: ${escapeHtml(conversation.projectName)}` : '';
        return `
          <label class="prism-row">
            <input type="checkbox" data-id="${conversation.id}" ${checked} />
            <div class="prism-row-index">${index + 1}</div>
            <div>
              <div class="prism-row-title">${escapeHtml(conversation.title)}</div>
              <div class="prism-row-meta">${updated}${projectMeta}</div>
            </div>
            ${conversation.is_archived ? '<span class="prism-badge">Archived</span>' : '<span></span>'}
          </label>
        `;
      })
      .join('');

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
    const filtered = getFilteredConversations();
    clearHiddenSelections();
    filtered.forEach((conversation) => {
      selectedIds.add(conversation.id);
    });
    renderList();
    setStatus(`${getVisibleSelectedCount()} conversation(s) selected in current view`, false);
  }

  function deselectAllVisible() {
    const filtered = getFilteredConversations();
    filtered.forEach((conversation) => {
      selectedIds.delete(conversation.id);
    });
    renderList();
    setStatus(`${getVisibleSelectedCount()} conversation(s) selected in current view`, false);
  }

  function clearHiddenSelections() {
    const visibleIds = new Set(conversations.map((conversation) => conversation.id));
    for (const id of Array.from(selectedIds)) {
      if (!visibleIds.has(id)) selectedIds.delete(id);
    }
  }

  function getVisibleSelectedCount() {
    const visibleIds = new Set(getFilteredConversations().map((conversation) => conversation.id));
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
      const token = await ensureToken();
      if (!token) throw new Error('Missing ChatGPT access token.');

      setStatus('Fetching selected conversation details...', false);
      const ids = Array.from(selectedIds);
      const selectedConversations = await fetchSelectedConversations(token, ids);
      if (selectedConversations.length === 0) {
        throw new Error('No valid ChatGPT conversations were fetched for sync.');
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

        const response = await fetch(`${API_BASE}/api/import/chatgpt-sync`, {
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
          (aggregate.overwrittenConversations > 0 ? `, ${aggregate.overwrittenConversations} overwritten` : '') +
          (batches.length > 1 ? ` across ${batches.length} batches` : ''),
        false
      );
    } catch (error) {
      if (selectedIds.size > 0) {
        lastSyncSummary = {
          ...(lastSyncSummary || {}),
          failedConversations: selectedIds.size,
          completedAt: new Date().toISOString(),
          error: error.message || String(error),
        };
        saveRememberedSyncSummary();
        renderLastSyncSummary();
      }
      setStatus(error.message || String(error), true);
    } finally {
      syncing = false;
      updateSyncButton();
    }
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
      const token = await ensureToken();
      if (!token) throw new Error('Missing ChatGPT access token.');

      const ids = Array.from(selectedIds);
      let deletedCount = 0;
      const failures = [];

      for (const id of ids) {
        const conversation = conversations.find((item) => item.id === id);
        if (deleteProgress) {
          deleteProgress.currentTitle = conversation?.title || id;
          renderDeleteProgress();
        }

        try {
          const response = await fetch(`${BACKEND_BASE}/conversation/${id}`, {
            method: 'PATCH',
            headers: {
              ...buildHeaders(token),
              'Content-Type': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify({ is_visible: false }),
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
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

      if (selectedProject) {
        await loadConversations(true);
      } else {
        globalConversations = globalConversations.filter((conversation) => !ids.includes(conversation.id));
        conversations = globalConversations;
        renderList();
      }

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

  async function fetchSelectedConversations(token, ids) {
    const results = [];
    const failures = [];

    for (const id of ids) {
      try {
        const response = await fetch(`${BACKEND_BASE}/conversation/${id}`, {
          headers: buildHeaders(token),
          credentials: 'include',
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        const normalized = normalizeConversationForSync(payload, id);
        if (!normalized) {
          throw new Error('Missing conversation id or mapping in response');
        }
        results.push(normalized);
      } catch (error) {
        failures.push(`${id}: ${error.message || String(error)}`);
      }
    }

    if (results.length === 0) {
      throw new Error(`Failed to fetch selected conversations. ${failures.join(' | ')}`);
    }
    if (failures.length > 0) {
      setStatus(`Partial fetch failure: ${failures.join(' | ')}`, true);
    }
    return results;
  }

  function chunkConversationsForSync(conversationsToSync, projectName) {
    const validConversations = conversationsToSync.filter((conversation) => (
      conversation &&
      typeof conversation.id === 'string' &&
      conversation.id.trim() &&
      conversation.mapping &&
      typeof conversation.mapping === 'object'
    ));
    const batches = [];
    let currentBatch = [];
    let currentBytes = estimatePayloadBytes(projectName, currentBatch);

    for (const conversation of validConversations) {
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

  function normalizeConversationForSync(payload, expectedId) {
    if (!payload || typeof payload !== 'object') return null;
    const id = typeof payload.id === 'string' && payload.id.trim()
      ? payload.id.trim()
      : typeof expectedId === 'string' && expectedId.trim()
        ? expectedId.trim()
        : '';
    const mapping = payload.mapping;
    if (!id || !mapping || typeof mapping !== 'object') return null;
    return {
      ...payload,
      id,
      metadata: {
        ...((payload.metadata && typeof payload.metadata === 'object') ? payload.metadata : {}),
        sourceUrl: `https://chatgpt.com/c/${id}`,
      },
    };
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
      const response = await fetch(`${API_BASE}/api/import/chatgpt-sync/latest`);
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
      console.warn('[prism-sync] Failed to load latest sync summary:', error);
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
      const raw = localStorage.getItem(LAST_SYNC_STORAGE_KEY);
      if (!raw) return;
      lastSyncSummary = JSON.parse(raw);
    } catch (error) {
      console.warn('[prism-sync] Failed to read local sync summary:', error);
    }
  }

  function saveRememberedSyncSummary() {
    try {
      localStorage.setItem(LAST_SYNC_STORAGE_KEY, JSON.stringify(lastSyncSummary));
    } catch (error) {
      console.warn('[prism-sync] Failed to persist local sync summary:', error);
    }
  }

  function makeSyncRunId() {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
    return `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function formatTimestamp(value) {
    if (!value) return 'Unknown time';
    const timestamp = typeof value === 'number' ? value * 1000 : Date.parse(value);
    if (!Number.isFinite(timestamp)) return 'Unknown time';
    return new Date(timestamp).toLocaleString();
  }

  function extractProjectName(item) {
    const candidates = [
      item.project_name,
      item.projectName,
      item.workspace_name,
      item.workspaceName,
      item.project?.name,
      item.workspace?.name,
    ];
    return candidates.find((value) => typeof value === 'string' && value.trim()) || '';
  }

  function extractProjectId(item) {
    const candidates = [
      item.project_id,
      item.projectId,
      item.workspace_id,
      item.workspaceId,
      item.project?.id,
      item.workspace?.id,
    ];
    return candidates.find((value) => typeof value === 'string' && value.trim()) || '';
  }

  function buildHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Authorization': `Bearer ${token}`,
    };
  }

  async function scrapeProjectsFromDom() {
    const collected = new Map();
    collectProjectsFromLinks(document, collected);
    return Array.from(collected.values());
  }

  async function captureMoreProjectsFlow() {
    closeModal();
    showCaptureBanner('Dialog hidden. Open ChatGPT "Projects > More" now. Waiting up to 12 seconds...');

    const started = Date.now();
    const existingIds = new Set(projects.map((project) => normalizeProjectId(project.id)));

    while (Date.now() - started < 12000) {
      const captured = await scrapeProjectsFromDom();
      const newProjects = captured.filter((item) => !existingIds.has(normalizeProjectId(item.id)));
      if (newProjects.length > 0) {
        showCaptureBanner('Projects detected. Waiting briefly for ChatGPT to finish loading the full More list...');
        const settledProjects = await waitForStableProjectCapture(existingIds);
        const finalProjects = settledProjects.length > 0 ? settledProjects : newProjects;

        capturedProjects = mergeProjects(capturedProjects, finalProjects);
        projects = mergeProjects(projects, finalProjects);
        projectDebug.domProjects = mergeProjects(projectDebug.domProjects, finalProjects);
        projectDebug.popupProjects = mergeProjects(
          projectDebug.popupProjects,
          finalProjects.filter((item) => item.source === 'dom-popup')
        );
        projectDebug.mergedProjects = projects;
        renderProjectDebug();
        renderProjectOptions();
        ensureRoot().classList.add('open');
        hideCaptureBanner();
        setStatus(`Captured ${finalProjects.length} additional project(s) from the open More popup.`, false);
        return;
      }

      showCaptureBanner('Waiting for the More popup... click Projects > More in ChatGPT now.');
      await wait(400);
    }

    ensureRoot().classList.add('open');
    setStatus('Did not detect any additional More popup projects. Click Capture More, then immediately open ChatGPT Projects > More.', true);
    hideCaptureBanner();
  }

  function shouldAttemptAutoMoreCapture(apiProjects, domProjects) {
    const apiCount = Array.isArray(apiProjects) ? apiProjects.length : 0;
    const domCount = Array.isArray(domProjects) ? domProjects.length : 0;
    const moreButton = findMoreProjectsButton();
    return Boolean(moreButton) && apiCount > 0 && domCount <= apiCount;
  }

  async function autoCaptureMoreProjects() {
    const root = ensureRoot();
    const wasOpen = root.classList.contains('open');
    const moreButton = findMoreProjectsButton();
    if (!moreButton) return [];

    const beforeProjects = new Set(Array.from(document.querySelectorAll('a[href*="/project"]')).map((link) => {
      const href = link.getAttribute('href') || '';
      return parseProjectIdFromHref(href);
    }).filter(Boolean));

    const wasExpanded = isExpanded(moreButton);
    const beforeContainers = capturePopupContainerFingerprints();

    if (wasOpen) {
      modalReopenAfterAutoCapture = true;
      closeModal();
      await wait(120);
    }

    try {
      if (!wasExpanded) {
        moreButton.click();
        await wait(280);
      }

      const captured = await waitForStableProjectCapture(beforeProjects, moreButton, beforeContainers);
      return captured;
    } finally {
      if (!wasExpanded && moreButton.isConnected) {
        moreButton.click();
        await wait(100);
      }
      if (wasOpen && modalReopenAfterAutoCapture) {
        modalReopenAfterAutoCapture = false;
        root.classList.add('open');
      }
    }
  }

  async function scrapeCurrentlyOpenMorePopup() {
    const collected = new Map();
    const moreButton = findMoreProjectsButton();
    if (!moreButton) return [];
    collectProjectsFromPopup(moreButton, new Set(), collected);
    return Array.from(collected.values());
  }

  async function waitForStableProjectCapture(existingIds, moreButton, beforeContainers) {
    let bestProjects = [];
    let stableSince = 0;
    const started = Date.now();

    while (Date.now() - started < MORE_CAPTURE_STABLE_MS + 3000) {
      const collected = new Map();
      collectProjectsFromLinks(document, collected);
      if (moreButton) {
        collectProjectsFromPopup(moreButton, beforeContainers || new Set(), collected);
      }

      const currentProjects = Array.from(collected.values()).filter((item) => {
        const canonicalId = normalizeProjectId(item.id);
        return canonicalId && !existingIds.has(canonicalId);
      });

      if (currentProjects.length > bestProjects.length) {
        bestProjects = currentProjects;
        stableSince = Date.now();
      } else if (currentProjects.length > 0) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= MORE_CAPTURE_STABLE_MS) {
          return bestProjects.length >= currentProjects.length ? bestProjects : currentProjects;
        }
      }

      await wait(MORE_CAPTURE_POLL_MS);
    }

    return bestProjects;
  }

  function collectProjectsFromLinks(root, collected) {
    const links = root.querySelectorAll('a[href*="/project"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const id = parseProjectIdFromHref(href);
      const name = link.textContent?.trim() || '';
      if (!id || !name) continue;
      if (name === 'New project' || name === 'Projects' || name === 'More') continue;
      collected.set(id, { id, name, source: 'dom-link' });
    }
  }

  function parseProjectIdFromHref(href) {
    const match = href.match(/\/g\/([^/]+)\/project(?:\/|$)/);
    return normalizeProjectId(match?.[1] || '');
  }

  function findMoreProjectsButton() {
    const buttons = Array.from(document.querySelectorAll('button, a'));
    return buttons.find((el) => (el.textContent || '').trim() === 'More') || null;
  }

  function isExpanded(element) {
    return element.getAttribute('aria-expanded') === 'true';
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function showCaptureBanner(message) {
    let banner = document.getElementById(CAPTURE_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = CAPTURE_ID;
      document.documentElement.appendChild(banner);
    }
    banner.textContent = message;
    banner.style.display = 'block';
  }

  function hideCaptureBanner() {
    const banner = document.getElementById(CAPTURE_ID);
    if (banner) banner.style.display = 'none';
  }

  function collectedHasName(collected, name) {
    for (const value of collected.values()) {
      if (value.name === name) return true;
    }
    return false;
  }

  function looksLikeProjectName(text) {
    if (!text) return false;
    if (text.length > 80) return false;

    const blocked = new Set([
      'Projects',
      'New project',
      'More',
      'New chat',
      'Search chats',
      'Library',
      'Images',
      'Apps',
      'Deep research',
      'Codex',
      'Close',
      'Refresh',
      'Select All',
      'Delete Selected',
      'Cancel',
      'Sync Selected',
      'Export',
      'Your chats',
      'Personal account',
      'Chats',
      'Sources',
    ]);
    if (blocked.has(text)) return false;

    if (/^\d+$/.test(text)) return false;
    if (text.includes('\n')) return false;
    if (text.startsWith('Prism API target')) return false;
    if (text.startsWith('Project selector')) return false;
    if (text.startsWith('Manual sync')) return false;
    if (text.startsWith('Loading ')) return false;
    if (text.includes('Password menu is available')) return false;
    if (text === 'Share') return false;
    if (text === 'Thinking') return false;
    if (text === 'ChatGPT') return false;
    if (text === 'ChatsSources') return false;
    if (text === 'Brian Huang') return false;
    if (text === 'Brian HuangPersonal account') return false;
    if (text === 'AppsDeep researchCodex') return false;
    if (text.includes('Search chats')) return false;
    if (text.includes('New chat')) return false;
    if (text.includes('Pulse')) return false;
    if (text.includes('Images')) return false;
    if (text.includes('Library')) return false;
    if (text.includes('Sync ChatGPT to Prism')) return false;
    if (text.includes('Sync to Prism')) return false;
    if (text.includes('Delete Selected')) return false;
    if (text.includes('Select All')) return false;
    if (text.includes('Close')) return false;

    return true;
  }

  function capturePopupContainerFingerprints() {
    const fingerprints = new Set();
    const elements = document.querySelectorAll('div, [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]');
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 80) continue;
      fingerprints.add(fingerprintRect(rect));
    }
    return fingerprints;
  }

  function collectProjectsFromPopup(moreButton, beforeContainers, collected) {
    const popup = findProjectPopup(moreButton, beforeContainers);
    if (!popup) return;

    const names = extractProjectNamesFromPopup(popup);
    for (const name of names) {
      if (!looksLikeProjectName(name)) continue;
      if (collectedHasName(collected, name)) continue;
      collected.set(`name:${name}`, { id: `name:${name}`, name, source: 'dom-popup' });
    }
  }

  function findProjectPopup(moreButton, beforeContainers) {
    const btnRect = moreButton.getBoundingClientRect();
    const candidates = new Set(
      Array.from(document.querySelectorAll('div, [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]'))
    );
    for (const candidate of collectPopupCandidatesFromPoints(btnRect)) {
      candidates.add(candidate);
    }
    let best = null;
    let bestScore = -1;

    for (const el of candidates) {
      if (el.closest(`#${ROOT_ID}`)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 160 || rect.height < 140) continue;
      if (rect.width > 420 || rect.height > 760) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      if (!['fixed', 'absolute', 'sticky'].includes(style.position)) continue;
      if (beforeContainers.has(fingerprintRect(rect))) continue;

      const texts = extractProjectNamesFromPopup(el);
      if (texts.length < 3) continue;

      let score = texts.length * 10;
      if (rect.left >= btnRect.right - 80) score += 20;
      if (rect.left <= btnRect.right + 260) score += 10;
      if (Math.abs(rect.top - btnRect.top) < 160) score += 15;
      if (rect.top >= btnRect.top - 40) score += 5;
      if (rect.left < window.innerWidth && rect.top < window.innerHeight) score += 5;
      if (rect.left > btnRect.left) score += 8;
      if (rect.top > btnRect.top - 20) score += 4;

      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }

    return best;
  }

  function extractProjectNamesFromPopup(root) {
    const names = [];
    const nodes = root.querySelectorAll('button, a, [role="menuitem"], [role="option"], [role="listitem"], li, div, span');
    for (const node of nodes) {
      if ((node.children?.length ?? 0) > 4) continue;
      const text = normalizePopupText(node.textContent || '');
      if (!looksLikeProjectName(text)) continue;
      if (!names.includes(text)) names.push(text);
    }
    return names;
  }

  function collectPopupCandidatesFromPoints(btnRect) {
    const candidates = new Set();
    const sampleXs = [btnRect.right + 24, btnRect.right + 80, btnRect.right + 160, btnRect.right + 240];
    const sampleYs = [btnRect.top + 16, btnRect.top + 72, btnRect.top + 144, btnRect.top + 216, btnRect.top + 288];

    for (const x of sampleXs) {
      for (const y of sampleYs) {
        if (x < 0 || y < 0 || x > window.innerWidth - 1 || y > window.innerHeight - 1) continue;
        for (const el of document.elementsFromPoint(x, y)) {
          const popupRoot = findPopupRootFromNode(el);
          if (popupRoot) candidates.add(popupRoot);
        }
      }
    }

    return Array.from(candidates);
  }

  function findPopupRootFromNode(node) {
    let cursor = node instanceof Element ? node : null;
    while (cursor && cursor !== document.body && cursor !== document.documentElement) {
      if (cursor.id === ROOT_ID || cursor.id === CAPTURE_ID) return null;
      const rect = cursor.getBoundingClientRect();
      const style = window.getComputedStyle(cursor);
      if (
        rect.width >= 160 &&
        rect.width <= 420 &&
        rect.height >= 140 &&
        rect.height <= 760 &&
        ['fixed', 'absolute', 'sticky'].includes(style.position) &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0
      ) {
        return cursor;
      }
      cursor = cursor.parentElement;
    }
    return null;
  }

  function normalizePopupText(text) {
    return String(text).replace(/\s+/g, ' ').trim();
  }

  function normalizeProjectId(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const match = text.match(/^(g-p-[a-z0-9]+)(?:-.+)?$/i);
    return match ? match[1] : text;
  }

  function fingerprintRect(rect) {
    return `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
  }

  function escapeHtml(input) {
    return String(input)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }
})();
