(function () {
  function findUuidCandidates(text) {
    if (typeof text !== 'string' || !text) return [];
    const matches = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi);
    return Array.from(new Set(matches || []));
  }

  function detectFromPath() {
    return findUuidCandidates(window.location.pathname)[0] || null;
  }

  function detectFromScripts() {
    const scripts = Array.from(document.scripts || []);
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text) continue;
      const tagged = text.match(/organization(?:_uuid|Id|ID|Uuid)?["':\s=]+([0-9a-f-]{36})/i);
      if (tagged?.[1]) return tagged[1];
      const apiMatch = text.match(/\/api\/organizations\/([0-9a-f-]{36})\//i);
      if (apiMatch?.[1]) return apiMatch[1];
    }
    return null;
  }

  function detectFromStorage(storage) {
    try {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (!key) continue;
        const value = storage.getItem(key);
        const tagged = typeof value === 'string'
          ? value.match(/organization(?:_uuid|Id|ID|Uuid)?["':\s=]+([0-9a-f-]{36})/i)
          : null;
        if (tagged?.[1]) return tagged[1];
        const apiMatch = typeof value === 'string'
          ? value.match(/\/api\/organizations\/([0-9a-f-]{36})\//i)
          : null;
        if (apiMatch?.[1]) return apiMatch[1];
      }
    } catch {}
    return null;
  }

  function detectOrgId() {
    return (
      detectFromPath() ||
      detectFromScripts() ||
      detectFromStorage(window.localStorage) ||
      detectFromStorage(window.sessionStorage) ||
      null
    );
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'prism-claude-sync-content') return;
    if (event.data?.type !== 'PRISM_REQUEST_CLAUDE_CONTEXT') return;

    const orgId = detectOrgId();
    window.postMessage(
      {
        source: 'prism-claude-sync-page',
        type: 'PRISM_CLAUDE_CONTEXT_RESPONSE',
        orgId,
      },
      '*'
    );
  });
})();
