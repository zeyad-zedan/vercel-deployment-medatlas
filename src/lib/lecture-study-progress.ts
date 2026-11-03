import { createOptionPermutation, OPTION_KEYS, resolveCanonicalOption, resolveDisplayedOption, type OptionKey, type OptionPermutation } from './mcq-engine.ts';

interface StudyItem {
  questionId: number;
  permutation: OptionPermutation;
  selectedCanonical: OptionKey | null;
  selectedDisplayed: OptionKey | null;
  submitted: boolean;
  correctAnswer?: OptionKey;
}

export function isWholeLectureStudy(params: {
  mode: string; lectureIds?: number[]; onlyMistakes?: boolean; requestedCount?: number;
  difficulties?: string[]; tagFilter?: string; specialTags?: string[]; avoidRecent?: boolean;
}) {
  return params.mode === 'study' && params.lectureIds?.length === 1 && !params.onlyMistakes &&
    params.requestedCount == null && !params.difficulties?.length && !params.tagFilter &&
    !params.specialTags?.length && !params.avoidRecent;
}

// Only small answer references are needed; never copy question snapshots or attempts.
export function reconcileLectureStudyItems(existing: StudyItem[], published: { id: number; correctAnswer: string }[],
  latestAnswers: { questionId: number | null; selectedOption: string | null }[], shuffleOptions: boolean): StudyItem[] {
  const publishedMap = new Map(published.map(question => [question.id, question]));
  const latest = new Map(latestAnswers.map(answer => [answer.questionId, answer.selectedOption]));
  const seen = new Set<number>();
  const items: StudyItem[] = [];
  for (const item of existing) {
    if (!publishedMap.has(item.questionId) || seen.has(item.questionId)) continue;
    seen.add(item.questionId);
    items.push(item);
  }
  for (const question of published) {
    if (!seen.has(question.id)) items.push({ questionId: question.id,
      permutation: createOptionPermutation(shuffleOptions, question.id), selectedCanonical: null, selectedDisplayed: null, submitted: false });
  }
  return items.map(item => {
    const latestAnswer = latest.get(item.questionId);
    const answer = OPTION_KEYS.includes(latestAnswer as OptionKey) ? latestAnswer :
      OPTION_KEYS.includes(item.selectedCanonical as OptionKey) ? item.selectedCanonical :
      OPTION_KEYS.includes(item.selectedDisplayed as OptionKey) ? resolveCanonicalOption(item.selectedDisplayed!, item.permutation) : null;
    return { ...item, correctAnswer: publishedMap.get(item.questionId)!.correctAnswer as OptionKey,
      selectedCanonical: answer as OptionKey | null,
      selectedDisplayed: answer ? resolveDisplayedOption(answer as OptionKey, item.permutation) : null,
      submitted: answer != null };
  });
}
