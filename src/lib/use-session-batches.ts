import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeQuestionBatch, questionBatchOffset, SESSION_BATCH_SIZE } from './session-batches.ts';

/** Requests at most six contents. Never writes answers, snapshots or bookmarks. */
export function useSessionBatches(session: any, setSession: (update: any) => void, currentIndex: number,
  api: { getSessionQuestionBatch: (id: number, offset: number) => Promise<{session: any}> }, automatic = true) {
  const latest = useRef(session);
  latest.current = session;
  const mounted = useRef(true);
  const requests = useRef(new Map<string, Promise<any>>());
  const failed = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [failedIndex, setFailedIndex] = useState<number | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const ensure = useCallback(async (index: number, retry = false): Promise<any> => {
    const state = latest.current;
    if (!state.questionBatch || !state.questions[index] || state.questions[index].contentLoaded !== false) return state.questions[index];
    const offset = questionBatchOffset(index);
    const key = `${state.id}:${state.status}:${offset}`;
    if (requests.current.has(key)) return requests.current.get(key);
    if (failed.current.has(key) && !retry) {
      setError('Could not load these questions. Your saved progress is safe.'); setFailedIndex(index); return;
    }
    if (retry) failed.current.delete(key);
    const request = (async () => {
      try {
        const response = await api.getSessionQuestionBatch(state.id, offset);
        if (!mounted.current || latest.current.id !== state.id || latest.current.status !== state.status) return;
        const question = response.session.questions.find((q: any) => q.index === index);
        if (!question || question.contentLoaded === false) throw new Error('This question is unavailable. Please retry or choose another question.');
        setSession((previous: any) => previous.status === state.status ? mergeQuestionBatch(previous, response.session) : previous);
        setError(null); setFailedIndex(null);
        return question;
      } catch (err: any) {
        failed.current.add(key);
        if (mounted.current) {
          setError(err.name === 'TimeoutError' || err.name === 'AbortError'
            ? 'Loading took too long. Your saved progress is safe. Please retry.'
            : err.message || 'Could not load the next questions. Your saved progress is safe.');
          setFailedIndex(index);
        }
      } finally { requests.current.delete(key); }
    })();
    requests.current.set(key, request);
    return request;
  }, [api, setSession]);

  useEffect(() => {
    if (!automatic || !session.questionBatch) return;
    if (session.questions[currentIndex]?.contentLoaded === false) { void ensure(currentIndex); return; }
    // Fetch once on reaching the last question of this batch, not on every answer.
    if ((currentIndex + 1) % SESSION_BATCH_SIZE === 0 && currentIndex + 1 < session.questions.length) void ensure(currentIndex + 1);
  }, [session.questions, session.status, session.questionBatch, currentIndex, ensure, automatic]);

  return { ensure, error, retry: () => ensure(failedIndex ?? currentIndex, true) };
}
