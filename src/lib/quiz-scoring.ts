import {scoreExamSession,type OptionKey,type ScoreResult} from './mcq-engine.ts';
export interface QuizShortAnswerState {shortAnswerId?:number|null;shortAnswerAttemptId?:number|null;shortAnswerStatus?:string;shortAnswerScore?:number|null;maxMarks?:number;}
export function quizScore(items:Array<QuizShortAnswerState&{questionId:number;correctAnswer?:string;selectedCanonical?:string|null}>) {
 const ordinary=items.filter(item=>!item.shortAnswerId);
 const base=scoreExamSession(ordinary.map(item=>({id:item.questionId,correctAnswer:item.correctAnswer as OptionKey})),Object.fromEntries(ordinary.map(item=>[item.questionId,item.selectedCanonical as OptionKey|null])));
 let earnedMarks=base.correctCount,maxMarks=ordinary.length,pendingGradingCount=0,partiallyCorrectCount=0;
 for(const item of items.filter(item=>item.shortAnswerId)){
  const maximum=Math.max(1,item.maxMarks||1),answered=!!item.shortAnswerAttemptId,graded=answered&&item.shortAnswerStatus==='graded',score=graded?Math.max(0,Math.min(maximum,item.shortAnswerScore||0)):0;
  maxMarks+=maximum;earnedMarks+=score;
  const correct=graded&&score===maximum;
  if(!answered)base.unansweredCount++;else if(!graded)pendingGradingCount++;else if(correct)base.correctCount++;else {base.incorrectCount++;if(score>0)partiallyCorrectCount++;}
  base.questionResults.push({questionId:item.questionId,correctCanonical:'A',selectedCanonical:!answered?null:!graded?'C':correct?'A':'B',isCorrect:correct,isUnanswered:!answered});
 }
 return {...base,totalQuestions:items.length,exactRatio:maxMarks?earnedMarks/maxMarks:0,scorePercentage:maxMarks?Math.round(100*earnedMarks/maxMarks):0,
  quizScore:{earnedMarks,maxMarks,pendingGradingCount,partiallyCorrectCount,shortAnswerCount:items.filter(item=>item.shortAnswerId).length}};
}

/** Constant SQL, evaluated where session JSON already lives. No full quiz transfer per answer. */
export const QUIZ_TOTALS_SQL=`SELECT
 count(*) FILTER(WHERE CASE WHEN value->>'shortAnswerId' IS NOT NULL THEN value->>'shortAnswerAttemptId' IS NULL ELSE value->>'selectedCanonical' IS NULL END)::int AS unanswered,
 count(*) FILTER(WHERE CASE WHEN value->>'shortAnswerId' IS NOT NULL THEN value->>'shortAnswerStatus'='graded' AND (value->>'shortAnswerScore')::int=COALESCE((value->>'maxMarks')::int,1) ELSE value->>'selectedCanonical'=value->>'correctAnswer' END)::int AS correct,
 count(*) FILTER(WHERE CASE WHEN value->>'shortAnswerId' IS NOT NULL THEN value->>'shortAnswerStatus'='graded' AND (value->>'shortAnswerScore')::int<COALESCE((value->>'maxMarks')::int,1) ELSE value->>'selectedCanonical' IS NOT NULL AND value->>'selectedCanonical' IS DISTINCT FROM value->>'correctAnswer' END)::int AS incorrect,
 count(*)::int AS total,
 COALESCE(sum(CASE WHEN value->>'shortAnswerId' IS NOT NULL THEN CASE WHEN value->>'shortAnswerStatus'='graded' THEN COALESCE((value->>'shortAnswerScore')::int,0) ELSE 0 END WHEN value->>'selectedCanonical'=value->>'correctAnswer' THEN 1 ELSE 0 END),0)::int AS earned_marks,
 COALESCE(sum(CASE WHEN value->>'shortAnswerId' IS NOT NULL THEN COALESCE((value->>'maxMarks')::int,1) ELSE 1 END),0)::int AS max_marks,
 count(*) FILTER(WHERE value->>'shortAnswerId' IS NOT NULL AND value->>'shortAnswerAttemptId' IS NOT NULL AND value->>'shortAnswerStatus' IS DISTINCT FROM 'graded')::int AS pending_grading,
 count(*) FILTER(WHERE value->>'shortAnswerId' IS NOT NULL)::int AS short_answers,
 count(*) FILTER(WHERE value->>'shortAnswerId' IS NOT NULL AND value->>'shortAnswerStatus'='graded' AND (value->>'shortAnswerScore')::int>0 AND (value->>'shortAnswerScore')::int<COALESCE((value->>'maxMarks')::int,1))::int AS partial`;
export function sqlQuizSummary(row:any){return {earnedMarks:row.earned_marks,maxMarks:row.max_marks,pendingGradingCount:row.pending_grading,shortAnswerCount:row.short_answers,partiallyCorrectCount:row.partial};}
