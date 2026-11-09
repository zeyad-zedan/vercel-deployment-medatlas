export const SESSION_BATCH_SIZE = 6;

export function questionBatchOffset(index: number) {
  return Math.floor(Math.max(0, index) / SESSION_BATCH_SIZE) * SESSION_BATCH_SIZE;
}

/** Study content already includes explanations; retain it when submission returns a paged review. */
export function mergeCompletedStudy(previous: any, completed: any) {
  if (previous.id !== completed.id || previous.mode === 'exam' || !completed.questionBatch) return completed;
  const loaded = new Map(previous.questions.filter((q: any) => q.contentLoaded !== false&&q.questionType!=='short_answer').map((q: any) => [q.id, q]));
  return { ...completed, questions: completed.questions.map((q: any) => q.contentLoaded === false && loaded.has(q.id)
    ? { ...(loaded.get(q.id) as any), ...q, contentLoaded: true } : q) };
}

/** Merge content only: an older fetch must not undo an answer/bookmark saved meanwhile. */
export function mergeQuestionBatch(previous: any, incoming: any) {
  if (previous.id !== incoming.id) return previous;
  if (previous.status !== incoming.status) return {...incoming,...(previous.reviewOnly?{reviewOnly:true}:{})};
  const byId = new Map((incoming.questions || []).filter((q: any) => q.contentLoaded !== false).map((q: any) => [q.id, q]));
  return { ...previous, questions: previous.questions.map((q: any) => {
    const loaded: any = byId.get(q.id);
    if (!loaded || q.contentLoaded !== false) return q;
    return { ...loaded, ...(q.selectedDisplayed || q.submitted ? { selectedDisplayed: q.selectedDisplayed, submitted: q.submitted, matchingChoiceId: q.matchingChoiceId ?? loaded.matchingChoiceId } : {}),
      ...(q.isBookmarked !== undefined ? { isBookmarked: q.isBookmarked } : {}) };
  }) };
}
