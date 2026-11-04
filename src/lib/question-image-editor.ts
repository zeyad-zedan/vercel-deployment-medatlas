import {createHash} from 'node:crypto';
import {pool} from '../db/index.ts';
import {imageForStorage,protectQuestionImageFields} from './telegram-question-images.ts';
import type {QuestionImage} from './question-images.ts';

export class ImageEditError extends Error {constructor(message:string,public status=400){super(message);}}
type Kind='mcq'|'short_answer';
const id=(value:unknown)=>{if(!Number.isSafeInteger(value)||Number(value)<1)throw new ImageEditError('Choose a valid lecture and question.');return Number(value);};
function kind(value:unknown):Kind {if(value!=='mcq'&&value!=='short_answer')throw new ImageEditError('Choose MCQs or short answers.');return value;}
const revision=(rows:any[])=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');

/** Portal-only reads are scoped and paginated; student page loads never call this service. */
export async function listImageEditableQuestions(input:any){
 const lectureId=id(input.lectureId),type=kind(input.type),after=input.after==null?0:Number(input.after);
 if(!Number.isSafeInteger(after)||after<0||typeof(input.search??'')!=='string'||(input.search?.length??0)>200)throw new ImageEditError('Use a valid search and page.');
 const search=String(input.search??'').trim().replace(/[\\%_]/g,'\\$&');
 const query=type==='mcq'
  ? `SELECT id,left(question_text,500) AS question,status,CASE WHEN matching IS NULL THEN 'MCQ' ELSE 'Matching · label '||(matching->>'number') END AS type,jsonb_array_length(images)::int AS "imageCount",jsonb_array_length(explanation_images)::int AS "explanationImageCount" FROM public.questions WHERE lecture_id=$1 AND id>$2 AND ($3='' OR question_text ILIKE '%'||$3||'%') ORDER BY id LIMIT 31`
  : `SELECT id,left(definition->>'question_text',500) AS question,status,'Short answer' AS type,jsonb_array_length(COALESCE(definition->'images','[]'::jsonb))::int AS "imageCount",0 AS "explanationImageCount" FROM public.short_answer_questions WHERE lecture_id=$1 AND id>$2 AND ($3='' OR definition->>'question_text' ILIKE '%'||$3||'%') ORDER BY id LIMIT 31`;
 const rows=(await pool.query(query,[lectureId,after,search])).rows;
 return {questions:rows.slice(0,30),nextCursor:rows.length>30?rows[29].id:null};
}

async function editRows(runner:any,type:Kind,lectureId:number,questionId:number,lock=false){
 if(type==='short_answer')return (await runner.query(`SELECT id,definition,status FROM public.short_answer_questions WHERE lecture_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[lectureId,questionId])).rows;
 // A numbered image is shared by its labels. Lock in ID order and update the group together.
 return (await runner.query(`SELECT id,question_text,images,explanation_images,matching,version,status FROM public.questions WHERE lecture_id=$1 AND (id=$2 OR matching->>'groupId'=(SELECT matching->>'groupId' FROM public.questions WHERE id=$2 AND lecture_id=$1)) ORDER BY id${lock?' FOR UPDATE':''}`,[lectureId,questionId])).rows;
}
function detail(rows:any[],type:Kind,questionId:number){
 const row=rows.find(r=>r.id===questionId);if(!row)throw new ImageEditError('Question not found in this lecture or section.',404);
 return protectQuestionImageFields({id:row.id,type,question:row.question_text??row.definition.question_text,status:row.status,images:row.images??row.definition.images??[],explanationImages:row.explanation_images??[],matching:!!row.matching,groupSize:rows.length,revision:revision(rows)});
}
export async function getImageEditableQuestion(input:any){
 const type=kind(input.type),lectureId=id(input.lectureId),questionId=id(input.id);
 return detail(await editRows(pool,type,lectureId,questionId),type,questionId);
}
function storedImages(value:unknown):QuestionImage[]{
 if(!Array.isArray(value)||value.length>4)throw new ImageEditError('Use up to four images in each image field.');
 const seen=new Set<string>();
 return value.map(value=>{let image:QuestionImage;try{image=imageForStorage(value);}catch{throw new ImageEditError('Upload each image to Telegram using this portal before saving.');}if(seen.has(image.id))throw new ImageEditError('Remove duplicate images before saving.');seen.add(image.id);return image;});
}
export async function saveQuestionImages(admin:{uid:string;email:string},input:any){
 const type=kind(input.type),lectureId=id(input.lectureId),questionId=id(input.id);
 if(typeof input.revision!=='string'||!/^[a-f0-9]{64}$/.test(input.revision))throw new ImageEditError('Reopen the question before saving.');
 const images=storedImages(input.images),explanationImages=storedImages(input.explanationImages??[]);
 if(type==='short_answer'&&explanationImages.length)throw new ImageEditError('Short answers support question images only.');
 const client=await pool.connect();let count=0;
 try{
  await client.query('BEGIN');
  const actor=(await client.query("SELECT email FROM public.users WHERE uid=$1 AND role='admin' AND account_status='active'",[admin.uid])).rows[0];
  if(!actor)throw new ImageEditError('The portal owner must be an active administrator.',403);
  const rows=await editRows(client,type,lectureId,questionId,true),row=rows.find((r:any)=>r.id===questionId);
  if(!row)throw new ImageEditError('Question not found in this lecture or section.',404);
  if(revision(rows)!==input.revision)throw new ImageEditError('This question changed since you opened it. Close the editor and reopen it to keep the latest changes.',409);
  if(row.matching&&images.length!==1)throw new ImageEditError('Matching labels need exactly one numbered image. It is shared by all labels in this group.');
  if(type==='short_answer'){
   // Keep the original import identity, marking guide and immutable historical answers.
   await client.query("UPDATE public.short_answer_questions SET definition=jsonb_set(definition,'{images}',$1::jsonb) WHERE id=$2 AND lecture_id=$3",[JSON.stringify(images),questionId,lectureId]);count=1;
  }else{
   const ids=rows.map((r:any)=>r.id);
   await client.query('UPDATE public.questions SET images=$1::jsonb,version=version+1,updated_at=now(),explanation_images=CASE WHEN id=$2 THEN $3::jsonb ELSE explanation_images END WHERE lecture_id=$4 AND id=ANY($5::integer[])',[JSON.stringify(images),questionId,JSON.stringify(explanationImages),lectureId,ids]);count=ids.length;
  }
  await client.query('INSERT INTO public.admin_audit_logs(admin_uid,admin_email,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6)',[admin.uid,actor.email,'UPDATE_QUESTION_IMAGES',type,String(questionId),JSON.stringify({lectureId,questionIds:rows.map((r:any)=>r.id),images:images.length,explanationImages:explanationImages.length})]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 return {saved:true,updated:count};
}
