import {pool} from '../db/index.ts';
import {saveShortAnswer,gradeShortAnswer,ShortAnswerError,publicShortAnswerAttempt} from './short-answer-service.ts';
import {QUIZ_TOTALS_SQL,sqlQuizSummary} from './quiz-scoring.ts';
const validId=(value:unknown)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new ShortAnswerError('Choose a valid quiz and question.');return n;};

export async function quizShortAnswerAttempts(uid:string,items:any[],examActive:boolean){
 const ids=items.map(item=>item.shortAnswerAttemptId).filter(Boolean);if(!ids.length)return new Map<number,any>();
 const rows=(await pool.query(`SELECT id,question_id,answer,status,result,model,created_at,retry_at,error_code,
 jsonb_build_object('question_text',snapshot->>'question_text','images',COALESCE(snapshot->'images','[]'::jsonb),'model_answer',CASE WHEN status='graded' AND NOT $3 THEN snapshot->>'model_answer' ELSE NULL END) AS snapshot
 FROM public.short_answer_attempts WHERE user_uid=$1 AND id=ANY($2::integer[])`,[uid,ids,examActive])).rows;
 return new Map(rows.map(row=>{const value=publicShortAnswerAttempt(row);return [row.id,examActive?{...value,status:'saved',result:null,model:null,error:null,modelAnswer:undefined}:value];}));
}

async function lockQuestion(client:any,uid:string,sessionId:number,questionId:number){
 const row=(await client.query(`SELECT id,mode,status,started_at,time_limit_seconds,
 (SELECT value FROM jsonb_array_elements(question_order_json::jsonb) WHERE (value->>'questionId')::int=$3) AS item
 FROM public.exam_sessions WHERE id=$1 AND user_uid=$2 FOR UPDATE`,[sessionId,uid,questionId])).rows[0];
 if(!row)throw new ShortAnswerError('This quiz does not belong to your account.',403);
 if(!row.item?.shortAnswerId)throw new ShortAnswerError('Choose a short-answer question in this quiz.');
 return row;
}
async function writeState(client:any,uid:string,row:any,item:any){
 const totals=(await client.query(`WITH changed AS (
 SELECT jsonb_agg(CASE WHEN (value->>'questionId')::int=$3 THEN $4::jsonb ELSE value END ORDER BY ordinality) AS items
 FROM public.exam_sessions s,jsonb_array_elements(s.question_order_json::jsonb) WITH ORDINALITY e(value,ordinality) WHERE s.id=$1 AND s.user_uid=$2
 ),totals AS (${QUIZ_TOTALS_SQL} FROM changed,jsonb_array_elements(items))
 UPDATE public.exam_sessions SET question_order_json=changed.items::text,correct_count=totals.correct,incorrect_count=totals.incorrect,unanswered_count=totals.unanswered,
 score_percentage=CASE WHEN totals.max_marks>0 THEN round(100.0*totals.earned_marks/totals.max_marks)::int ELSE 0 END
 FROM changed,totals WHERE exam_sessions.id=$1 AND exam_sessions.user_uid=$2
 RETURNING exam_sessions.id,exam_sessions.status,correct_count,incorrect_count,unanswered_count,score_percentage,totals.*`,[row.id,uid,item.questionId,JSON.stringify(item)])).rows[0];
 // Mock-exam drafts are saved in their answer table but do not enter progress before submission.
 if(row.mode!=='exam'||row.status==='completed'){
  const q=(await client.query('SELECT * FROM public.questions WHERE id=$1',[item.questionId])).rows[0];
  const snapshot={id:q.id,questionText:q.question_text,shortAnswerId:q.short_answer_id,shortAnswerMaxMarks:q.short_answer_max_marks,images:q.images,shortAnswerState:{shortAnswerId:item.shortAnswerId,shortAnswerAttemptId:item.shortAnswerAttemptId,shortAnswerStatus:item.shortAnswerStatus,shortAnswerScore:item.shortAnswerScore,maxMarks:item.maxMarks}};
  await client.query(`INSERT INTO public.question_attempts(session_id,user_uid,question_id,subject_id,lecture_id,selected_option,correct_option_snapshot,is_correct,question_snapshot_json,grading_status)
   VALUES($1,$2,$3,$4,$5,$6,'A',$7,$8,$9) ON CONFLICT(session_id,question_id) DO UPDATE SET selected_option=excluded.selected_option,is_correct=excluded.is_correct,question_snapshot_json=excluded.question_snapshot_json,grading_status=excluded.grading_status,answered_at=now()`,[row.id,uid,q.id,q.subject_id,q.lecture_id,item.selectedCanonical,item.shortAnswerStatus==='graded'&&item.shortAnswerScore===item.maxMarks,JSON.stringify(snapshot),item.shortAnswerStatus]);
 }
 const hidden=row.mode==='exam'&&row.status!=='completed';
 return {id:row.id,status:row.status,correctCount:hidden?0:totals.correct_count,incorrectCount:hidden?0:totals.incorrect_count,unansweredCount:totals.unanswered_count,scorePercentage:hidden?0:totals.score_percentage,...(!hidden?{quizScore:sqlQuizSummary(totals)}:{})};
}

export async function saveQuizShortAnswer(uid:string,sessionValue:unknown,questionValue:unknown,answer:unknown){
 const sessionId=validId(sessionValue),questionId=validId(questionValue),client=await pool.connect();
 try{
  await client.query('BEGIN');const row=await lockQuestion(client,uid,sessionId,questionId);
  if(row.status!=='in_progress')throw new ShortAnswerError('This quiz is already submitted. Your saved answer is preserved.',409);
  if(row.mode==='exam'&&row.time_limit_seconds!=null&&Date.now()>new Date(row.started_at).getTime()+row.time_limit_seconds*1000)throw new ShortAnswerError('The exam time has ended. Your previously saved answers are safe.',409);
  if(typeof answer==='string'&&!answer.trim()){
   const item={...row.item,shortAnswerAttemptId:null,shortAnswerStatus:'cleared',shortAnswerScore:null,selectedCanonical:null,selectedDisplayed:null,submitted:false};
   const session=await writeState(client,uid,row,item);await client.query('COMMIT');return {attempt:null,session};
  }
  const attempt=await saveShortAnswer(uid,row.item.shortAnswerId,answer,client);
  const item={...row.item,maxMarks:attempt.maxScore||row.item.maxMarks,shortAnswerAttemptId:attempt.id,shortAnswerStatus:attempt.status,shortAnswerScore:attempt.result?.score??null,submitted:row.mode!=='exam',selectedCanonical:attempt.status==='graded'?(attempt.result.score===(attempt.maxScore||row.item.maxMarks)?'A':'B'):'C',selectedDisplayed:null};
  const session=await writeState(client,uid,row,item);await client.query('COMMIT');
  return {attempt:row.mode==='exam'?{...attempt,status:'saved',result:null,model:null,modelAnswer:undefined,error:null}:attempt,session};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function gradeQuizShortAnswer(uid:string,sessionValue:unknown,questionValue:unknown){
 const sessionId=validId(sessionValue),questionId=validId(questionValue);let attemptId:number;
 const client=await pool.connect();try{await client.query('BEGIN');const row=await lockQuestion(client,uid,sessionId,questionId);if(row.mode==='exam'&&row.status!=='completed')throw new ShortAnswerError('Submit the exam before requesting grading.',409);attemptId=row.item.shortAnswerAttemptId;if(!attemptId)throw new ShortAnswerError('Save your answer first.');await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 const attempt=await gradeShortAnswer(uid,attemptId);
 const update=await pool.connect();try{await update.query('BEGIN');const row=await lockQuestion(update,uid,sessionId,questionId);if(row.item.shortAnswerAttemptId!==attemptId)throw new ShortAnswerError('A newer answer is saved. Reopen the question to view it.',409);const item={...row.item,shortAnswerStatus:attempt.status,shortAnswerScore:attempt.result?.score??null,selectedCanonical:attempt.status==='graded'?(attempt.result.score===row.item.maxMarks?'A':'B'):'C',selectedDisplayed:null};const session=await writeState(update,uid,row,item);await update.query('COMMIT');return {attempt,session};}catch(error){await update.query('ROLLBACK');throw error;}finally{update.release();}
}
