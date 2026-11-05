import {createHash,randomUUID} from 'node:crypto';
import {pool} from '../db/index.ts';
import {readStudentGeminiKeyForGrading} from './student-gemini-keys.ts';
import {gradeWithGemini,GradingError} from './gemini-short-answer.ts';
import {parseShortAnswerBatch,type ShortAnswerDefinition} from './short-answer-model.ts';
import {validImageFileName,type ImportImageFile,type QuestionImage} from './question-images.ts';
import {imageForStorage} from './telegram-question-images.ts';
import {syncShortAnswerQuizEntries} from './short-answer-quiz-links.ts';
export class ShortAnswerError extends Error {constructor(message:string,public status=400){super(message);}}
export const gradingMessages:Record<string,string>={KEY_MISSING:'Add your Gemini API key in Profile & Settings, then retry.',KEY_OR_ACCESS:'Google rejected the key or model access. Check your key and Google project settings.',QUOTA:'Your Google quota is currently exhausted. Your answer is saved. Wait for your quota to reset, then retry.',TIMEOUT:'Google took too long to respond. Your answer is saved; you can retry.',MODEL_UNAVAILABLE:'This grading model is unavailable to your Google project. Contact the site administrator.',UNAVAILABLE:'Grading is temporarily unavailable. Your answer is saved.',INVALID_RESPONSE:'Google returned an incomplete or invalid grade. Your answer is saved; retry shortly.'};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const numericId=(value:unknown)=>{const id=Number(value);if(!Number.isSafeInteger(id)||id<1)throw new ShortAnswerError('Invalid question or attempt.');return id;};
export function publicShortAnswerAttempt(row:any){return {id:row.id,questionId:row.question_id,question:row.snapshot.question_text,maxScore:row.result?.maxScore??row.snapshot.rubric?.reduce((sum:number,point:any)=>sum+point.marks,0),images:row.snapshot.images||[],answer:row.answer,status:row.status,result:row.result,model:row.model,createdAt:row.created_at,retryAt:row.retry_at,errorCode:row.error_code??null,error:row.error_code?gradingMessages[row.error_code]||gradingMessages.UNAVAILABLE:null,...(row.status==='graded'?{modelAnswer:row.snapshot.model_answer}: {})};}
const clientAttempt=publicShortAnswerAttempt;
export async function shortAnswerCatalog(){return (await pool.query(`SELECT l.id,l.title,l.content_type AS "contentType",l.lecture_number AS "lectureNumber",s.title AS subject,count(q.id)::int AS count FROM public.short_answer_questions q JOIN public.lectures l ON l.id=q.lecture_id JOIN public.subjects s ON s.id=l.subject_id WHERE q.status='published' AND l.status='published' AND s.status='published' GROUP BY l.id,l.title,s.title ORDER BY s.title,l.id`)).rows;}
export async function shortAnswerQuestions(uid:string,lectureId:unknown,after:unknown){
 const id=numericId(lectureId),cursor=after==null?0:Number(after);if(!Number.isSafeInteger(cursor)||cursor<0)throw new ShortAnswerError('Invalid page.');
 const rows=(await pool.query(`SELECT q.id,q.definition->>'question_text' AS question,q.definition->'tags' AS tags,q.definition->'images' AS images,q.max_score,a.id AS attempt_id,a.status,a.result->>'score' AS score
 FROM public.short_answer_questions q JOIN public.lectures l ON l.id=q.lecture_id JOIN public.subjects s ON s.id=l.subject_id
 LEFT JOIN LATERAL (SELECT id,status,result FROM public.short_answer_attempts WHERE user_uid=$1 AND question_id=q.id ORDER BY id DESC LIMIT 1) a ON true
 WHERE q.lecture_id=$2 AND q.id>$3 AND q.status='published' AND l.status='published' AND s.status='published' ORDER BY q.id LIMIT 7`,[uid,id,cursor])).rows;
 return {questions:rows.slice(0,6),nextCursor:rows.length>6?rows[5].id:null};
}
export async function shortAnswerHistory(uid:string,after:unknown){const cursor=after==null?2147483647:numericId(after);const rows=(await pool.query(`SELECT id,question_id,snapshot->>'question_text' AS question,status,result->>'score' AS score,result->>'maxScore' AS max_score,created_at FROM public.short_answer_attempts WHERE user_uid=$1 AND id<$2 ORDER BY id DESC LIMIT 21`,[uid,cursor])).rows;return {attempts:rows.slice(0,20),nextCursor:rows.length>20?rows[19].id:null};}
export async function getShortAnswerAttempt(uid:string,id:unknown){const [row]=(await pool.query('SELECT * FROM public.short_answer_attempts WHERE id=$1 AND user_uid=$2',[numericId(id),uid])).rows;if(!row)throw new ShortAnswerError('Answer not found.',404);return clientAttempt(row);}
export async function saveShortAnswer(uid:string,id:unknown,answer:unknown,runner:Pick<typeof pool,'query'>=pool){
 if(typeof answer!=='string'||!answer.trim()||answer.length>4000)throw new ShortAnswerError('Write an answer of 1–4,000 characters.');
 const normalized=answer.trim().normalize('NFC');
 const [question]=(await runner.query(`SELECT q.id,q.definition FROM public.short_answer_questions q JOIN public.lectures l ON l.id=q.lecture_id JOIN public.subjects s ON s.id=l.subject_id WHERE q.id=$1 AND q.status='published' AND l.status='published' AND s.status='published'`,[numericId(id)])).rows;
 if(!question)throw new ShortAnswerError('Question is not available.',404);
 const [row]=(await runner.query(`INSERT INTO public.short_answer_attempts(user_uid,question_id,answer,answer_hash,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(user_uid,question_id,answer_hash) DO UPDATE SET answer_hash=excluded.answer_hash,excluded_from_quiz_progress=false RETURNING *`,[uid,question.id,normalized,hash(normalized),JSON.stringify(question.definition)])).rows;
 return clientAttempt(row);
}
export async function gradeShortAnswer(uid:string,id:unknown){
 const attemptId=numericId(id),client=await pool.connect(),lease=randomUUID();let row:any;
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))',[uid]);
  [row]=(await client.query('SELECT * FROM public.short_answer_attempts WHERE id=$1 AND user_uid=$2 FOR UPDATE',[attemptId,uid])).rows;
  if(!row)throw new ShortAnswerError('Answer not found.',404);
  const activeExam=await client.query("SELECT 1 FROM public.exam_sessions WHERE user_uid=$1 AND mode='exam' AND status='in_progress' AND question_order_json::jsonb @> $2::jsonb LIMIT 1",[uid,JSON.stringify([{shortAnswerAttemptId:attemptId}])]);
  if(activeExam.rowCount)throw new ShortAnswerError('Submit the exam before requesting grading.',409);
  if(row.status==='graded'||(row.status==='grading'&&Date.now()-new Date(row.grade_started_at).getTime()<45000)||new Date(row.retry_at||0).getTime()>Date.now()){await client.query('COMMIT');return clientAttempt(row);}
  const [usage]=(await client.query(`SELECT count(*)::int AS recent,count(*) FILTER(WHERE status='grading' AND grade_started_at>now()-interval '45 seconds')::int AS active FROM public.short_answer_attempts WHERE user_uid=$1 AND grade_started_at>now()-interval '1 minute'`,[uid])).rows;
  if(usage.recent>=6||usage.active>=2)throw new ShortAnswerError('Your answer is saved. Please wait a minute before requesting another grade.',429);
  await client.query(`UPDATE public.short_answer_attempts SET status='grading',lease_id=$1,grade_started_at=now(),retry_at=null,error_code=null,updated_at=now() WHERE id=$2`,[lease,attemptId]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 try{
  const key=await readStudentGeminiKeyForGrading(uid);if(!key)throw new GradingError('KEY_MISSING');
  const {grade,model}=await gradeWithGemini(key,row.snapshot as ShortAnswerDefinition,row.answer);
  await pool.query(`UPDATE public.short_answer_attempts SET status='graded',result=$1::jsonb,model=$2,lease_id=null,error_code=null,retry_at=null,updated_at=now() WHERE id=$3 AND user_uid=$4 AND lease_id=$5`,[JSON.stringify(grade),model,attemptId,uid,lease]);
 }catch(error){const failure=error instanceof GradingError?error:new GradingError('UNAVAILABLE',15);
  await pool.query(`UPDATE public.short_answer_attempts SET status='failed',error_code=$1,retry_at=now()+($2*interval '1 second'),lease_id=null,updated_at=now() WHERE id=$3 AND user_uid=$4 AND lease_id=$5`,[failure.code,failure.delaySeconds,attemptId,uid,lease]);
 }
 return getShortAnswerAttempt(uid,attemptId);
}
export async function importShortAnswers(lectureId:unknown,source:string,publish=false,execute=false,assets:{imageFiles?:ImportImageFile[];uploadedImages?:Record<string,QuestionImage>}={}){
 const id=numericId(lectureId),definitions=parseShortAnswerBatch(source);
 const manifest=new Map<string,string>();
 if(!Array.isArray(assets.imageFiles??[])||(assets.imageFiles?.length??0)>100)throw new ShortAnswerError('Select up to 100 image files per batch.');
 for(const file of assets.imageFiles??[]){if(!file||typeof file.name!=='string'||!validImageFileName(file.name)||typeof file.id!=='string'||!/^[a-f0-9]{64}$/.test(file.id)||manifest.has(file.name))throw new ShortAnswerError('Image filenames and content identifiers must be valid and unique.');manifest.set(file.name,file.id);}
 if(!(await pool.query('SELECT 1 FROM public.lectures WHERE id=$1',[id])).rowCount)throw new ShortAnswerError('Choose an existing target lecture.');
 const rows=definitions.map(({imageFiles,...definition})=>{
  const images=(imageFiles??[]).map(file=>{
   if(!manifest.has(file.file))throw new ShortAnswerError(`Select the missing image: ${file.file}`);
   if(!execute)return {id:manifest.get(file.file)!,alt:file.alt};
   let stored:QuestionImage;try{stored=imageForStorage(assets.uploadedImages?.[file.file]!);}catch{throw new ShortAnswerError(`Upload the image to Telegram before importing: ${file.file}`);}
   if(stored.id!==manifest.get(file.file))throw new ShortAnswerError(`Image verification failed: ${file.file}`);
   return {...stored,alt:file.alt};
  });
  const identity=images.length?{...definition,images:images.map(image=>({id:image.id,alt:image.alt}))}:definition;
  return {...definition,...(images.length?{images}:{}),...(!execute&&imageFiles?.length?{imageFiles}:{}),status:publish?definition.status:'draft',maxScore:definition.rubric.reduce((sum,p)=>sum+p.marks,0),hash:hash(JSON.stringify({...identity,status:undefined}))};
 });
 if(!execute)return {questions:rows.map(({hash,...row})=>row)};
 const client=await pool.connect();let count=0;
 try{await client.query('BEGIN');for(const row of rows){const {hash,maxScore,...definition}=row;count+=(await client.query('INSERT INTO public.short_answer_questions(lecture_id,definition,content_hash,max_score,status) VALUES($1,$2::jsonb,$3,$4,$5) ON CONFLICT(lecture_id,content_hash) DO NOTHING',[id,JSON.stringify(definition),hash,maxScore,row.status])).rowCount||0;}await syncShortAnswerQuizEntries(client,id);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 if(count){const {invalidateCatalogCache}=await import('../db/repository.ts');invalidateCatalogCache();}
 return {imported:count,duplicates:rows.length-count};
}
export async function manageShortAnswers(lectureId:unknown,ids?:unknown,status?:unknown) {
 const lecture=numericId(lectureId);
 if(ids!==undefined){
  if(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(id=>!Number.isSafeInteger(id)||id<1)||!['draft','published'].includes(String(status)))throw new ShortAnswerError('Choose questions and a valid publication status.');
  const client=await pool.connect();try{await client.query('BEGIN');await client.query("UPDATE public.short_answer_questions SET status=$1,definition=jsonb_set(definition,'{status}',to_jsonb($1::text)) WHERE lecture_id=$2 AND id=ANY($3::integer[])",[status,lecture,ids]);await syncShortAnswerQuizEntries(client,lecture);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const {invalidateCatalogCache}=await import('../db/repository.ts');invalidateCatalogCache();
 }
 return {questions:(await pool.query("SELECT id,definition->>'question_text' AS question,max_score,status FROM public.short_answer_questions WHERE lecture_id=$1 ORDER BY id DESC LIMIT 200",[lecture])).rows};
}
