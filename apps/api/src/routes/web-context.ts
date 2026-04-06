import { Router } from 'express';
import { resolveUrl, resolveUrlPreview, normalizeUrl } from '../services/url-reader';
import { getSession } from '../memory/session';
import { getWebPage, getWebPageByNormalizedUrl, listWebPagesForSession, removeWebPageAttachment, upsertWebPageAttachment } from '../memory/web-page-store';

const router = Router();

router.post('/preview', async (req, res) => {
  const url = String(req.body.url ?? '').trim();
  if (!url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  const preview = await resolveUrlPreview(url);
  if (!preview) {
    res.status(400).json({ error: 'Failed to preview URL' });
    return;
  }

  res.json(preview);
});

router.post('/attach', async (req, res) => {
  const sessionId = String(req.body.sessionId ?? '').trim();
  const rootUrl = String(req.body.rootUrl ?? '').trim();
  const selectedUrls = Array.isArray(req.body.selectedUrls)
    ? req.body.selectedUrls.map((item: unknown) => String(item)).filter(Boolean)
    : [];

  if (!sessionId || !rootUrl) {
    res.status(400).json({ error: 'sessionId and rootUrl are required' });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const rootResolved = await resolveUrl(rootUrl);
  if (!rootResolved) {
    res.status(400).json({ error: 'Failed to resolve root URL' });
    return;
  }

  const rootNormalized = normalizeUrl(rootResolved.url);
  const rootPage = upsertWebPageAttachment({
    sessionId,
    rootUrl: rootResolved.url,
    url: rootResolved.url,
    normalizedUrl: rootNormalized,
    title: rootResolved.title,
    host: new URL(rootResolved.url).host,
    depth: 0,
    contentText: rootResolved.content,
    metadata: {
      sameDomainOnly: true,
      snippet: rootResolved.content.slice(0, 220),
    },
  });

  const attached = [rootPage];
  const limitedSelected = selectedUrls.slice(0, 5);

  for (const selectedUrl of limitedSelected) {
    const resolved = await resolveUrl(selectedUrl);
    if (!resolved) continue;
    const normalized = normalizeUrl(resolved.url);
    const existing = getWebPageByNormalizedUrl(sessionId, normalized);
    if (existing) {
      attached.push(existing);
      continue;
    }

    const page = upsertWebPageAttachment({
      sessionId,
      rootUrl: rootResolved.url,
      url: resolved.url,
      normalizedUrl: normalized,
      title: resolved.title,
      host: new URL(resolved.url).host,
      depth: 1,
      parentWebPageId: rootPage.id,
      contentText: resolved.content,
      metadata: {
        sameDomainOnly: true,
        snippet: resolved.content.slice(0, 220),
      },
    });
    attached.push(page);
  }

  res.json({ pages: attached });
});

router.get('/session/:sessionId', (req, res) => {
  const pages = listWebPagesForSession(req.params.sessionId);
  res.json({ pages });
});

router.delete('/:id', (req, res) => {
  const page = getWebPage(req.params.id);
  if (!page) {
    res.status(404).json({ error: 'Web page attachment not found' });
    return;
  }
  removeWebPageAttachment(req.params.id);
  res.json({ ok: true });
});

export default router;
