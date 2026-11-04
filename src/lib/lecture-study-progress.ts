import { createOptionPermutation, OPTION_KEYS, resolveCanonicalOption, resolveDisplayedOption,prioritizeTaggedQuestions, type OptionKey, type OptionPermutation } from './mcq-engine.ts';

interface StudyItem {
  shortAnswerId?:number|null;
  shortAnswerAttemptId?:number|null;
  shortAnswerStatus?:string;
  shortAnswerScore?:number|null;
  maxMarks?:number;
  questionId: number;
  permutation: OptionPermutation;
  selectedCanonical: OptionKey | null;
  selectedDisplayed: OptionKey | null;
  submitted: boolean;
  correctAnswer?: OptionKey;
  isMatching?: boolean;
  matchingChoiceId?: string | null;
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
export function reconcileLectureStudyItems(existing: StudyItem[], published: { id: number; correctAnswer: string; matchingGroupId?: string | null;shortAnswerId?:number|null;shortAnswerMaxMarks?:number;tags?:string;specialTags?:string;hasTags?:boolean }[],
  latestAnswers: { questionId: number | null; selectedOption: string | null; matchingChoiceId?: string | null;shortAnswerState?:any }[], shuffleOptions: boolean): StudyItem[] {
  const publishedMap = new Map(published.map(question => [question.id, question]));
  const latest = new Map(latestAnswers.map(answer => [answer.questionId, answer]));
  const seen = new Set<number>();
  const items: StudyItem[] = [];
  for (const item of existing) {
    if (!publishedMap.has(item.questionId) || seen.has(item.questionId)) continue;
    seen.add(item.questionId);
    items.push(item);
  }
  for (const question of prioritizeTaggedQuestions(published)) {
    if (!seen.has(question.id)) items.push({ questionId: question.id,
      ...(question.matchingGroupId ? { isMatching: true } : {}),
      ...(question.shortAnswerId?{shortAnswerId:question.shortAnswerId,maxMarks:question.shortAnswerMaxMarks}:{}),
      permutation: createOptionPermutation(!question.matchingGroupId && shuffleOptions, question.id), selectedCanonical: null, selectedDisplayed: null, submitted: false });
  }
  return items.map(item => {
    const latestRecord = latest.get(item.questionId);
    if(item.shortAnswerId){const saved=latestRecord?.shortAnswerState,attempt=saved?(saved.shortAnswerAttemptId??null):(item.shortAnswerAttemptId??null),status=saved?.shortAnswerStatus??item.shortAnswerStatus,score=saved?.shortAnswerScore??item.shortAnswerScore,maximum=saved?.maxMarks??item.maxMarks??1;return {...item,...(saved||{}),correctAnswer:'A' as const,submitted:!!attempt,selectedCanonical:attempt?(status==='graded'?(score===maximum?'A':'B'):'C') as OptionKey:null,selectedDisplayed:null};}
    const latestAnswer = latestRecord?.selectedOption;
    const answer = OPTION_KEYS.includes(latestAnswer as OptionKey) ? latestAnswer :
      OPTION_KEYS.includes(item.selectedCanonical as OptionKey) ? item.selectedCanonical :
      OPTION_KEYS.includes(item.selectedDisplayed as OptionKey) ? resolveCanonicalOption(item.selectedDisplayed!, item.permutation) : null;
    return { ...item, ...(item.isMatching ? { matchingChoiceId: latestRecord?.matchingChoiceId ?? item.matchingChoiceId ?? null } : {}), correctAnswer: publishedMap.get(item.questionId)!.correctAnswer as OptionKey,
      selectedCanonical: answer as OptionKey | null,
      selectedDisplayed: answer ? resolveDisplayedOption(answer as OptionKey, item.permutation) : null,
      submitted: answer != null };
  });
}
