import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { AnswerSaveQueue, type AnswerToSave } from './answer-saves.ts';
import { readSessionDrafts, readSessionMatchingDrafts } from './session-progress.ts';
import type { OptionKey } from './mcq-engine.ts';

export function useAnswerSaving(session: any, onSaved: (result: any, answer: AnswerToSave) => void) {
  const callback = useRef(onSaved);
  callback.current = onSaved;
  const initial = useRef(session);
  const mounted = useRef(false);
  const [drafts] = useState(() => readSessionDrafts(session));
  const [matchingDrafts] = useState(() => readSessionMatchingDrafts(session));
  const [storageOwner] = useState(() => `${Date.now()}-${Math.random()}`);
  const [queue] = useState(() => new AnswerSaveQueue(
    answer => api.submitQuestionAnswer(session.id, answer.questionId, answer.selectedOption, answer.lockAnswer, answer.elapsedSeconds, true, answer.matchingChoiceId),
    (result, answer) => { if (mounted.current) callback.current(result, answer); },
    (answers, claim) => {
      try {
        const key = `medatlas_session_draft_answers_${session.id}`;
        const stored = JSON.parse(localStorage.getItem(key) || '{}');
        if (!claim && stored.owner !== storageOwner) return;
        if (!answers.length) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify({ version: 1, owner: storageOwner, answers: Object.fromEntries(answers.map(answer => [answer.questionId, answer.selectedOption])), matchingChoices: Object.fromEntries(answers.filter(answer=>answer.matchingChoiceId).map(answer=>[answer.questionId,answer.matchingChoiceId])) }));
      } catch { /* Server saving continues when local storage is unavailable. */ }
    },
  ));
  const [, render] = useState(0);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = queue.subscribe(() => render(version => version + 1));
    if (initial.current.status !== 'completed') {
      for (const [questionId, selectedOption] of Object.entries(drafts)) {
        queue.save({ questionId: Number(questionId), selectedOption, lockAnswer: initial.current.mode !== 'exam', elapsedSeconds: initial.current.elapsedSeconds, matchingChoiceId: matchingDrafts[Number(questionId)] });
      }
    }
    return () => { mounted.current = false; unsubscribe(); };
  }, [queue, drafts]);

  useEffect(() => {
    if (session.status === 'completed') queue.finish();
  }, [queue, session.status]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!queue.unsavedCount) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [queue]);

  return {
    drafts,
    matchingDrafts,
    saveMatch: (questionId: number, matchingChoiceId: string, elapsedSeconds?: number) => queue.save({ questionId, selectedOption: 'A', matchingChoiceId, elapsedSeconds, lockAnswer: session.mode !== 'exam' }),
    status: queue.status,
    unsavedCount: queue.unsavedCount,
    save: (questionId: number, selectedOption: OptionKey, elapsedSeconds?: number) => queue.save({ questionId, selectedOption, elapsedSeconds, lockAnswer: session.mode !== 'exam' }),
    retry: () => queue.retry(),
    flush: () => queue.flush(),
    finish: () => queue.finish(),
  };
}
