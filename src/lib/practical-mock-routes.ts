import { json, Router, type RequestHandler, type Response } from 'express';
import type { AuthRequest } from '../middleware/auth.ts';
import { gradePracticalMock, listPracticalMocks, PracticalMockError, publishPracticalMock,
  readPracticalMock, savePracticalMockAnswer, startPracticalMock } from '../db/practical-mock.ts';

export function practicalMockRouter(requireAdmin: RequestHandler) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

  const handle = (action: (req: AuthRequest, res: Response) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { await action(req, res); }
    catch (error) {
      if (error instanceof PracticalMockError) { res.status(error.status).json({ error: error.message }); return; }
      console.error('Practical mock exam request failed:', (error as { code?: string }).code);
      res.status(500).json({ error: 'Practical mock exams are temporarily unavailable. Please try again.' });
    }
  };

  router.get('/', handle(async (req, res) => res.json(await listPracticalMocks(req.user!.uid))));
  router.post('/', requireAdmin, json({ limit: '192kb' }),
    handle(async (req, res) => res.status(201).json({ id: await publishPracticalMock(req.body) })));
  router.get('/:id', handle(async (req, res) => res.json(await readPracticalMock(req.user!.uid, req.params.id))));
  router.post('/:id/start', handle(async (req, res) => res.json(await startPracticalMock(req.user!.uid, req.params.id))));
  router.put('/:id/answer', handle(async (req, res) => res.json(await savePracticalMockAnswer(req.user!.uid, req.params.id, req.body))));
  router.post('/:id/grade', handle(async (req, res) => res.json(await gradePracticalMock(req.user!.uid, req.params.id))));
  return router;
}
