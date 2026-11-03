import { Router, type RequestHandler } from 'express';
import type { AuthRequest } from './auth.ts';
import { resolveDocumentReference } from '../lib/protected-document-reference.ts';
import { cachedDocumentSource, renderDocument, DocumentViewError } from '../lib/document-renderer.ts';

export function createProtectedDocumentRouter(deps: {
  authenticate: RequestHandler;
  limiter: RequestHandler;
  getMetadata: (url: string, uid: string) => Promise<{ telegramFileId: string | null; watermarksEnabled?: boolean } | null>;
  fetchSource: (id: string) => Promise<Buffer>;
}) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store, max-age=0', 'CDN-Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': 'no-store', Pragma: 'no-cache',
      Vary: 'Authorization, Cookie', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' });
    next();
  });
  router.use(deps.authenticate, deps.limiter);
  const serve: RequestHandler = async (req: AuthRequest, res) => {
    try {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
      // Cross-site embeds and token-in-URL requests are never accepted.
      if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Document access denied.' });
      let sourceUrl: string;
      try { sourceUrl = resolveDocumentReference(String(req.params.reference)); }
      catch { return res.status(404).json({ error: 'Document not found.' }); }
      const meta = await deps.getMetadata(sourceUrl, req.user!.uid);
      if (!meta?.telegramFileId) return res.status(404).json({ error: 'Document not available.' });
      const page = req.params.page;
      if (page !== undefined && !/^[1-9]\d{0,4}$/.test(String(page))) return res.status(400).json({ error: 'Invalid page.' });
      const source = await cachedDocumentSource(meta.telegramFileId, () => deps.fetchSource(meta.telegramFileId!));
      const result = await renderDocument(source, page ? Number(page) : undefined, req.user!.uid, meta.watermarksEnabled === true);
      if (!page) return res.json({ totalPages: result.totalPages });
      res.set({ 'Content-Type': 'image/webp', 'Content-Disposition': 'inline; filename="study-page.webp"',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
      return res.send(result.image);
    } catch (error) {
      if (error instanceof DocumentViewError) return res.status(error.status).json({ error: error.message });
      console.warn('[DOCUMENT_VIEW_FAILED]', { name: error instanceof Error ? error.name : 'unknown' });
      return res.status(503).json({ error: 'The protected viewer is temporarily unavailable. Please retry.' });
    }
  };
  router.get('/:reference', serve);
  router.get('/:reference/pages/:page', serve);
  router.use((_req, res) => res.status(404).json({ error: 'Document not found.' }));
  return router;
}
