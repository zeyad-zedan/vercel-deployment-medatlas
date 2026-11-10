import {pool} from '../db/index.ts';
import {saveShortAnswer,gradeShortAnswer,getShortAnswerAttempt,ShortAnswerError,publicShortAnswerAttempt} from './short-answer-service.ts';
import {QUIZ_TOTALS_SQL,sqlQuizSummary} from './quiz-scoring.ts';
import {tournamentsEnabled} from './study-rewards.ts';
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
async function writeState(client:any,uid:string,row:any,item:any,action:'save'|'grade'){
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
  const savedAnswer = action === 'save' && item.selectedCanonical !== null
    && item.shortAnswerAttemptId !== row.item.shortAnswerAttemptId;
  const newFullGrade = tournamentsEnabled && action === 'grade' && row.item.shortAnswerStatus !== 'graded'
    && item.shortAnswerStatus === 'graded' && item.shortAnswerScore === item.maxMarks;
  if (savedAnswer || newFullGrade) {
    await client.query('SELECT gamification.record_answers($1, $2, ARRAY[$3]::int[], $4, $5)', [uid,row.id,q.id,savedAnswer,tournamentsEnabled]);
  }
 }
 const hidden=row.mode==='exam'&&row.status!=='completed';
 return {id:row.id,status:row.status,correctCount:hidden?0:totals.correct_count,incorrectCount:hidden?0:totals.incorrect_count,unansweredCount:totals.unanswered_count,scorePercentage:hidden?0:totals.score_percentage,...(!hidden?{quizScore:sqlQuizSummary(totals)}:{})};
}

export async function saveQuizShortAnswer(uid:string,sessionValue:unknown,questionValue:unknown,answer:unknown,forGrading=false){
 const sessionId=validId(sessionValue),questionId=validId(questionValue),client=await pool.connect();
 try{
  await client.query('BEGIN');const row=await lockQuestion(client,uid,sessionId,questionId);
  if(forGrading&&row.mode==='exam')throw new ShortAnswerError('Submit the exam before requesting grading.',409);
  if(row.status!=='in_progress')throw new ShortAnswerError('This quiz is already submitted. Your saved answer is preserved.',409);
  if(row.mode==='exam'&&row.time_limit_seconds!=null&&Date.now()>new Date(row.started_at).getTime()+row.time_limit_seconds*1000)throw new ShortAnswerError('The exam time has ended. Your previously saved answers are safe.',409);
  if(typeof answer==='string'&&!answer.trim()){
   const item={...row.item,shortAnswerAttemptId:null,shortAnswerStatus:'cleared',shortAnswerScore:null,selectedCanonical:null,selectedDisplayed:null,submitted:false};
   const session=await writeState(client,uid,row,item,'save');await client.query('COMMIT');return {attempt:null,session};
  }
  const attempt=await saveShortAnswer(uid,row.item.shortAnswerId,answer,client);
  const item={...row.item,maxMarks:attempt.maxScore||row.item.maxMarks,shortAnswerAttemptId:attempt.id,shortAnswerStatus:attempt.status,shortAnswerScore:attempt.result?.score??null,submitted:row.mode!=='exam',selectedCanonical:attempt.status==='graded'?(attempt.result.score===(attempt.maxScore||row.item.maxMarks)?'A':'B'):'C',selectedDisplayed:null};
  const session=await writeState(client,uid,row,item,'save');await client.query('COMMIT');
  return {attempt:row.mode==='exam'?{...attempt,status:'saved',result:null,model:null,modelAnswer:undefined,error:null}:attempt,session};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function gradeQuizShortAnswer(uid:string,sessionValue:unknown,questionValue:unknown,expectedAttemptId?:number){
 const sessionId=validId(sessionValue),questionId=validId(questionValue);let attemptId:number;
 const client=await pool.connect();try{await client.query('BEGIN');const row=await lockQuestion(client,uid,sessionId,questionId);if(row.mode==='exam'&&row.status!=='completed')throw new ShortAnswerError('Submit the exam before requesting grading.',409);attemptId=row.item.shortAnswerAttemptId;if(!attemptId)throw new ShortAnswerError('Save your answer first.');if(expectedAttemptId!==undefined&&attemptId!==expectedAttemptId)throw new ShortAnswerError('A newer answer is saved. Reopen the question to view it.',409);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 const result=await gradeShortAnswer(uid,attemptId);
 const update=await pool.connect();
 try{
  await update.query('BEGIN');
  const row=await lockQuestion(update,uid,sessionId,questionId);
  if(row.item.shortAnswerAttemptId!==attemptId)throw new ShortAnswerError('A newer answer is saved. Reopen the question to view it.',409);
  // A duplicate request can observe an in-flight grade before the first request commits it to the quiz.
  const attempt=result.status!=='graded'&&row.item.shortAnswerStatus==='graded'
   ?await getShortAnswerAttempt(uid,attemptId,update)
   :result;
  const item={...row.item,shortAnswerStatus:attempt.status,shortAnswerScore:attempt.result?.score??null,selectedCanonical:attempt.status==='graded'?(attempt.result.score===row.item.maxMarks?'A':'B'):'C',selectedDisplayed:null};
  const session=await writeState(update,uid,row,item,'grade');
  await update.query('COMMIT');
  return {attempt,session};
 }catch(error){await update.query('ROLLBACK');throw error;}finally{update.release();}
}

export async function saveAndGradeQuizShortAnswer(uid:string,sessionId:unknown,questionId:unknown,answer:unknown){
 if(typeof answer!=='string'||!answer.trim()||answer.length>4000)throw new ShortAnswerError('Write an answer of 1–4,000 characters.');
 const saved=await saveQuizShortAnswer(uid,sessionId,questionId,answer,true);
 if(!saved.attempt)throw new ShortAnswerError('Save your answer first.');
 try{
  return await gradeQuizShortAnswer(uid,sessionId,questionId,saved.attempt.id);
 }catch(error){
  if(error instanceof ShortAnswerError&&error.status===429)return {...saved,gradingError:error.message};
  throw error;
 }
}
