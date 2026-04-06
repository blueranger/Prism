(function () {
  function readBootstrapToken() {
    try {
      const token = window.__remixContext?.state?.loaderData?.root?.clientBootstrap?.session?.accessToken;
      if (typeof token === 'string' && token) return token;
    } catch {}
    return null;
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'prism-chatgpt-sync-content') return;
    if (event.data?.type !== 'PRISM_REQUEST_TOKEN') return;

    let token = readBootstrapToken();
    if (!token) {
      try {
        const response = await fetch('/api/auth/session', { credentials: 'include' });
        const data = await response.json();
        token = typeof data?.accessToken === 'string' ? data.accessToken : null;
      } catch {}
    }

    window.postMessage(
      {
        source: 'prism-chatgpt-sync-page',
        type: 'PRISM_TOKEN_RESPONSE',
        token,
      },
      '*'
    );
  });
})();
