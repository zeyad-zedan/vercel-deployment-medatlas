import { OPTION_KEYS, type OptionKey } from './mcq-engine.ts';

export function clearResetSessionStorage(sessionIds: number[]) {
  const ids = sessionIds.filter(id => Number.isSafeInteger(id) && id > 0);
  try {
    for (const id of ids) {
      for (const prefix of ['medatlas_session_curr_idx_', 'medatlas_session_question_', 'medatlas_session_draft_answers_']) {
        localStorage.removeItem(prefix + id);
      }
    }
    const active = localStorage.getItem('medatlas_active_session_id');
    if (active !== null && ids.includes(Number(active))) localStorage.removeItem('medatlas_active_session_id');
  } catch { /* A failed local cleanup must never affect other sessions. */ }
}

export function readSessionDrafts(session: any): Record<number, OptionKey> {
  if (session?.status === 'completed') return {};
  try {
    const stored = JSON.parse(localStorage.getItem(`medatlas_session_draft_answers_${session.id}`) || '{}');
    const answers = stored.version === 1 ? stored.answers : stored;
    const result: Record<number, OptionKey> = {};
    for (const question of session.questions || []) {
      const answer = answers?.[question.id];
      if (!OPTION_KEYS.includes(answer)) continue;
      if (session.mode !== 'exam' && question.submitted) continue;
      // Older clients stored acknowledged answers too. Do not replay these over newer server data.
      if (stored.version !== 1 && question.selectedDisplayed) continue;
      if (question.selectedDisplayed === answer && (session.mode === 'exam' || question.submitted)) continue;
      result[question.id] = answer;
    }
    return result;
  } catch { return {}; }
}

export function getResumeQuestionIndex(session: any): number {
  const questions = session?.questions || [];
  if (!questions.length) return 0;
  const continuingStudy = session.mode === 'study' && session.status === 'in_progress';
  if (continuingStudy && session.resumeQuestionId != null) {
    const resume = questions.findIndex((question: any) => question.id === session.resumeQuestionId && !question.submitted && !question.selectedDisplayed);
    if (resume >= 0) return resume;
  }
  const canResume = (index: number) => index >= 0 && (!continuingStudy || (!questions[index].submitted && !questions[index].selectedDisplayed));
  try {
    const savedId = Number(localStorage.getItem(`medatlas_session_question_${session.id}`));
    const index = questions.findIndex((question: any) => question.id === savedId);
    if (canResume(index)) return index;
    const legacy = localStorage.getItem(`medatlas_session_curr_idx_${session.id}`);
    const legacyIndex = Number(legacy);
    if (legacy !== null && Number.isInteger(legacyIndex) && legacyIndex >= 0 && legacyIndex < questions.length && canResume(legacyIndex)) return legacyIndex;
  } catch { /* Storage may be disabled. Use the server's question state. */ }
  if (session.status === 'completed') return 0;
  const unanswered = questions.findIndex((question: any) => !question.submitted && !question.selectedDisplayed);
  return unanswered >= 0 ? unanswered : questions.length - 1;
}

export function rememberSessionQuestion(sessionId: number, questionId: number, index: number) {
  try {
    localStorage.setItem(`medatlas_session_question_${sessionId}`, String(questionId));
    localStorage.setItem(`medatlas_session_curr_idx_${sessionId}`, String(index));
  } catch { /* Browsing still works when local storage is unavailable. */ }
}
