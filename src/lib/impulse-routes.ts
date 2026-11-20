import express,{type Request,type Response,type RequestHandler} from 'express';
import {createHmac,createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import {pool} from '../db/index.ts';
import {refreshCourseAttempt} from './course-version.ts';
import {hashPasswordAsync,verifyPasswordAsync,requireAuth,type AuthRequest} from '../middleware/auth.ts';
import {createBoundedRateLimiter,normalizeClientIp,type SharedRateLimitStore} from '../middleware/rate-limit.ts';
import {uploadQuestionImage,imageForClient,imageForStorage,fetchQuestionImage} from './telegram-question-images.ts';
import {validateImpulseQuiz} from './impulse-model.ts';
import {gradePrivateCourse,gradePrivateCourseBatch} from './private-course-grading.ts';
import {guestCourseSlug} from './course-quiz-route.ts';
import {gradingMessages} from './short-answer-service.ts';
import {GradingError,gradingRetrySeconds} from './gemini-short-answer.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const cookie=(req:Request,name:string)=>{const value=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='));return value?.slice(name.length+1)||'';};
const sign=(value:any)=>{const data=Buffer.from(JSON.stringify({...value,exp:Date.now()+180*86400000})).toString('base64url');return data+'.'+createHmac('sha256',process.env.AUTH_SESSION_SECRET!).update('impulse-v1:'+data).digest('base64url');};
function read(value:string){try{const [data,sig]=value.split('.');const expected=createHmac('sha256',process.env.AUTH_SESSION_SECRET!).update('impulse-v1:'+data).digest('base64url');if(!sig||sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;const v=JSON.parse(Buffer.from(data,'base64url').toString());return v.exp>Date.now()?v:null;}catch{return null;}}
function setCookie(req:Request,res:Response,name:string,value:string,maxAge=180*86400000){res.cookie(name,value,{httpOnly:true,sameSite:'strict',secure:req.secure||process.env.NODE_ENV==='production'||process.env.VERCEL==='1',path:'/api/impulse',maxAge});}
function publisher(req:Request){const secret=process.env.IMPULSE_PUBLISHER_PASSWORD_HASH;const value=read(cookie(req,'impulse_publisher'));return !!secret&&value?.role==='publisher'&&value.stamp===hash(secret)&&value.loginAt>Date.now()-86400000;}
function required(value:any,message='Not found.',status=404):asserts value{if(!value)throw Object.assign(Error(message),{status});}
const wrap=(fn:(req:Request,res:Response)=>Promise<any>)=>(req:Request,res:Response)=>{fn(req,res).catch((e:any)=>{if(!e.status&&!e.safe)console.warn('[IMPULSE_REQUEST_FAILED]',{name:e.name,code:typeof e.code==='string'?e.code:undefined});if(!res.headersSent)res.status(e.status||(e.safe?400:503)).json({error:e.status||e.safe?e.message:'The request could not be completed. Your saved work is safe.'});});};
export function impulseRouter(store?:SharedRateLimitStore|null,grader=gradePrivateCourse,authenticate:RequestHandler=requireAuth,degradedModePolicy?:'memory_fallback'|'fail_closed'){
 const r=express.Router();
 r.use((_req,res,next)=>{res.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'});next();});
 r.get('/impulse/upload',(_req,res)=>res.sendFile(path.resolve('public/impulse/index.html')));
 r.use('/api/impulse',(req,res,next)=>{try{if(req.method!=='GET'&&(req.get('X-Impulse-Request')!=='1'||(req.get('origin')&&new URL(req.get('origin')!).host!==req.get('host'))))return res.status(403).json({error:'Open this quiz page to continue.'});next();}catch{res.status(403).json({error:'Open this quiz page to continue.'});}});
 const limit=(scope:string,maxRequests:number,keyGenerator?:(req:Request)=>string)=>createBoundedRateLimiter({
  scope:'impulse-'+scope,maxRequests,windowMs:60000,store:store??undefined,degradedModePolicy,maxKeys:2000,
  keyGenerator:keyGenerator??((req:Request)=>scope==='grade'?((req as AuthRequest).user?.uid||normalizeClientIp(req)):normalizeClientIp(req)),
 });
 const unlockFailLimiter=limit('unlock-fail',10);
 const consumeUnlockFailure=(req:Request,res:Response)=>new Promise<boolean>(resolve=>{
  let allowed=false;
  Promise.resolve(unlockFailLimiter(req,res,()=>{allowed=true;})).then(()=>resolve(allowed)).catch(()=>resolve(true));
 });
 // High IP ceiling accommodates shared campus NATs; per-student limits are enforced post-auth below.
 r.use('/api/impulse',limit('requests-ip',3000));
 r.post('/api/impulse/publisher/login',limit('login',5),express.json({limit:'2kb'}),wrap(async(req,res)=>{
  const stored=process.env.IMPULSE_PUBLISHER_PASSWORD_HASH;required(stored,'Publisher access is not configured yet.',503);
  required(typeof req.body.password==='string'&&req.body.password.length<=128&&await verifyPasswordAsync(req.body.password,stored),'Incorrect publisher password.',401);
  setCookie(req,res,'impulse_publisher',sign({role:'publisher',stamp:hash(stored),loginAt:Date.now()}),86400000);res.json({ok:true});
 }));
 r.post('/api/impulse/publisher/logout',(_req,res)=>{res.clearCookie('impulse_publisher',{path:'/api/impulse'});res.json({ok:true});});
 r.use('/api/impulse/publisher',(req,res,next)=>publisher(req)?next():res.status(401).json({error:'Enter the publisher password.'}));
 r.post('/api/impulse/publisher/image',limit('upload',12),express.raw({type:'application/octet-stream',limit:'2mb'}),wrap(async(req,res)=>{
  required(Buffer.isBuffer(req.body),'Select an image.',400);const image=imageForClient(await uploadQuestionImage('impulse-image.png',req.body));res.json({...image,source:image.source!.replace('/api/question-images/','/api/impulse/media/')});
 }));
 r.get('/api/impulse/media/:token',wrap(async(req,res)=>{
  required(publisher(req),'Publisher access required.',401);const image=imageForStorage({id:'',alt:'',source:'/api/question-images/'+req.params.token});res.type(image.mimeType!).send(await fetchQuestionImage(image));
 }));
 r.use('/api/impulse',express.json({limit:'1mb'}));
 r.get('/api/impulse/publisher/quizzes',wrap(async(_req,res)=>res.json({quizzes:(await pool.query('SELECT id,slug,title,published_version IS NOT NULL AS published,jsonb_array_length(draft) AS question_count,updated_at FROM impulse.quizzes ORDER BY updated_at DESC LIMIT 200')).rows})));
 r.get('/api/impulse/publisher/quizzes/:id',wrap(async(req,res)=>{
  const q=(await pool.query('SELECT id,slug,title,draft,published_version IS NOT NULL AS published FROM impulse.quizzes WHERE id=$1',[req.params.id])).rows[0];required(q);
  q.questions=q.draft.map((item:any)=>({...item,...(item.image?{image:{...imageForClient(item.image),source:imageForClient(item.image).source?.replace('/api/question-images/','/api/impulse/media/')}}:{})}));delete q.draft;res.json(q);
 }));
 r.post('/api/impulse/publisher/quizzes',wrap(async(req,res)=>{
  let valid;try{valid=validateImpulseQuiz(req.body);}catch(e:any){throw Object.assign(e,{safe:true});}
  const {password,id}=req.body;required((!id&&typeof password==='string'&&password.length>=8&&password.length<=128)||(id&&(!password||(typeof password==='string'&&password.length>=8&&password.length<=128))),'Use a quiz password of 8–128 characters.',400);
  const passwordHash=password?await hashPasswordAsync(password):null,client=await pool.connect();
  try{await client.query('BEGIN');let quiz;
   if(id){const previous=(await client.query('SELECT draft FROM impulse.quizzes WHERE id=$1 FOR UPDATE',[id])).rows[0];required(previous);
    for(let i=0;i<valid.questions.length;i++)if(!req.body.questions[i]?.id&&previous.draft[i]?.type===valid.questions[i].type)valid.questions[i].id=previous.draft[i].id;}
   if(id){quiz=(await client.query('UPDATE impulse.quizzes SET title=$2,draft=$3,password_hash=COALESCE($4,password_hash),updated_at=now() WHERE id=$1 RETURNING id,slug',[id,valid.title,JSON.stringify(valid.questions),passwordHash])).rows[0];required(quiz);}
   else quiz=(await client.query('INSERT INTO impulse.quizzes(title,slug,password_hash,draft) VALUES($1,$2,$3,$4) RETURNING id,slug',[valid.title,randomBytes(18).toString('base64url'),passwordHash,JSON.stringify(valid.questions)])).rows[0];
   if(req.body.publish===true){const version=randomUUID();await client.query('INSERT INTO impulse.versions(id,quiz_id) VALUES($1,$2)',[version,quiz.id]);
    for(let i=0;i<valid.questions.length;i++)await client.query('INSERT INTO impulse.questions(id,version_id,position,definition) VALUES($1,$2,$3,$4)',[randomUUID(),version,i,JSON.stringify(valid.questions[i])]);
    await client.query('UPDATE impulse.quizzes SET published_version=$2 WHERE id=$1',[quiz.id,version]);}
   await client.query('COMMIT');res.json({...quiz,published:req.body.publish===true});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }));
 r.use('/api/impulse/quiz/:slug',(req,res,next)=>{
  if(req.params.slug!==guestCourseSlug||/^Bearer\s+\S/i.test(req.get('authorization')||''))return authenticate(req,res,next);
  const guest=read(cookie(req,'impulse_'+req.params.slug));
  const uid=guest?.role==='student'&&typeof guest.uid==='string'&&/^guest:[0-9a-f-]{36}$/.test(guest.uid)?guest.uid:'guest-unauthed:'+normalizeClientIp(req);
  (req as AuthRequest).user={uid,email:'',name:guest?.name};
  next();
 });
 r.use('/api/impulse/quiz/:slug',limit('requests-user',300,(req:Request)=>(req as AuthRequest).user?.uid||normalizeClientIp(req)));
 async function access(req:Request,allowOldStamp=false){
  const uid=(req as AuthRequest).user!.uid;
  const value=read(cookie(req,'impulse_'+req.params.slug));required(value?.role==='student'&&value.uid===uid,'Enter the quiz password to continue.',401);
  const row=(await pool.query('SELECT a.id,a.quiz_id,a.version_id,a.current_position,a.completed,q.grade_on_submit,q.title,q.slug,q.password_hash,q.published_version FROM impulse.attempts a JOIN impulse.quizzes q ON q.id=a.quiz_id WHERE a.id=$1 AND a.student_uid=$2 AND q.slug=$3',[value.attempt,uid,req.params.slug])).rows[0];
  required(row&&row.published_version,'Enter the quiz password to continue.',401);required(allowOldStamp||value.stamp===hash(row.password_hash),'The quiz password has changed. Enter the current password to resume.',401);
  if(req.method==='GET'&&req.path.endsWith('/session')&&row.version_id!==row.published_version){const updated=await refreshCourseAttempt(row.id,uid);return {...row,version_id:updated.version_id,current_position:updated.current_position,completed:updated.completed};}return row;
 }
 r.post('/api/impulse/quiz/:slug/unlock',limit('unlock',120),wrap(async(req,res)=>{
  const quiz=(await pool.query('SELECT id,password_hash,published_version FROM impulse.quizzes WHERE slug=$1',[req.params.slug])).rows[0];required(quiz?.published_version,'Quiz not available.',404);
  const validPassword=typeof req.body.password==='string'&&req.body.password.length<=128&&await verifyPasswordAsync(req.body.password,quiz.password_hash);
  if(!validPassword){
   if(!(await consumeUnlockFailure(req,res)))return;
   required(false,'Incorrect quiz password.',401);
  }
  let uid=(req as AuthRequest).user!.uid;
  const isGuest=req.params.slug===guestCourseSlug&&uid.startsWith('guest');
  const name=isGuest&&typeof req.body.name==='string'?req.body.name.trim().replace(/\s+/g,' '):null;
  required(!isGuest||(name&&name.length>=2&&name.length<=100&&!/[\x00-\x1f\x7f]/.test(name)),'Enter your name (2–100 characters).',400);
  if(uid.startsWith('guest-unauthed:'))uid='guest:'+randomUUID();
  const attempt=(await pool.query('INSERT INTO impulse.attempts(quiz_id,version_id,student_uid,guest_name) VALUES($1,$2,$3,$4) ON CONFLICT(quiz_id,student_uid) DO UPDATE SET guest_name=CASE WHEN impulse.attempts.completed THEN impulse.attempts.guest_name ELSE COALESCE(excluded.guest_name,impulse.attempts.guest_name) END RETURNING id',[quiz.id,quiz.published_version,uid,name])).rows[0];
  setCookie(req,res,'impulse_'+req.params.slug,sign({role:'student',attempt:attempt.id,uid,...(name?{name}:{}),stamp:hash(quiz.password_hash)}));res.json({ok:true});
 }));
 r.get('/api/impulse/quiz/:slug/session',wrap(async(req,res)=>{
  const a=await access(req);
  // Small navigation/score metadata only; question text and answer text remain paged.
  const includeStates=req.query.offset===undefined||req.query.states==='1';
  const states=includeStates?(await pool.query(`SELECT q.id,q.position,q.definition->>'type' AS type,a.answer IS NOT NULL AS answered,
   CASE WHEN q.definition->>'type'='mcq' THEN a.answer END AS choice,a.result->'score' AS score,
   COALESCE((a.result->>'maxScore')::numeric,(SELECT sum((p->>'marks')::int) FROM jsonb_array_elements(q.definition->'rubric') p),1) AS max_marks
   FROM impulse.questions q LEFT JOIN impulse.answers a ON a.question_id=q.id AND a.attempt_id=$2
   WHERE q.version_id=$1 ORDER BY q.position`,[a.version_id,a.id])).rows:[];
  const count=includeStates?states.length:(await pool.query('SELECT count(*)::int AS total FROM impulse.questions WHERE version_id=$1',[a.version_id])).rows[0].total;
  const offset=req.query.offset===undefined?Math.floor(a.current_position/6)*6:Number(req.query.offset);required(Number.isInteger(offset)&&offset>=0&&offset<count,'Invalid question page.',400);
  const rows=(await pool.query(`SELECT q.id,q.position,q.definition-'correct'-'rubric'-'model_answer'-'explanation'-'image' AS question,q.definition ? 'image' AS has_image,COALESCE((a.result->>'maxScore')::numeric,(SELECT sum((p->>'marks')::int) FROM jsonb_array_elements(q.definition->'rubric') p),1) AS max_marks,a.answer,
   CASE WHEN a.result IS NOT NULL AND q.definition->>'type'='mcq' THEN a.result||jsonb_build_object('correctOption',q.definition->'correct') ELSE a.result END AS result,
   CASE WHEN q.definition->>'type'='mcq' THEN jsonb_build_object('correctOption',q.definition->'correct','feedback',q.definition->>'explanation') END AS study_feedback,
   COALESCE(a.result->>'_modelAnswer',q.definition->>'model_answer') AS model_answer,
   (a.result->>'_modelAnswer' IS NOT NULL AND a.result->>'_modelAnswer' IS DISTINCT FROM q.definition->>'model_answer') AS guide_changed,a.status
   FROM impulse.questions q LEFT JOIN impulse.answers a ON a.question_id=q.id AND a.attempt_id=$2 WHERE q.version_id=$1 AND q.position >=$3 AND q.position <$3+6 ORDER BY q.position`,[a.version_id,a.id,offset])).rows;
  if(!a.completed){for(const row of rows)if(!row.result&&!(typeof row.answer==='string'&&row.answer.trim()))row.model_answer=null;}
  if(a.grade_on_submit&&!a.completed){for(const state of states)state.score=null;for(const row of rows){row.result=null;row.study_feedback=null;row.model_answer=null;row.guide_changed=false;}}
  res.json({gradeOnSubmit:a.grade_on_submit,attemptId:a.id,versionId:a.version_id,title:a.title,total:count,current:a.current_position,completed:a.completed,studentUid:(req as AuthRequest).user!.uid,...(includeStates?{states}:{}),questions:rows});
 }));
 r.get('/api/impulse/quiz/:slug/image/:id',wrap(async(req,res)=>{
  const a=await access(req),image=await resolveCourseImage(String(req.params.id),a.version_id,a.quiz_id);required(image);res.type(image.mimeType).send(await fetchQuestionImage(image));
 }));
 r.post('/api/impulse/quiz/:slug/progress',wrap(async(req,res)=>{
  const a=await access(req),position=req.body.position;required(Number.isInteger(position)&&position>=0&&position<100,'Invalid position.',400);
  required((await pool.query('SELECT 1 FROM impulse.questions WHERE version_id=$1 AND position=$2',[a.version_id,position])).rowCount,'Invalid position.',400);
  await pool.query('UPDATE impulse.attempts SET current_position=$2,updated_at=now() WHERE id=$1',[a.id,position]);res.json({ok:true});
 }));
 r.post('/api/impulse/quiz/:slug/answer/:id',wrap(async(req,res)=>{
  const a=await access(req);required(!a.completed,'This quiz is submitted. Your answers are preserved.',409);
  const row=(await pool.query('SELECT definition,position FROM impulse.questions WHERE id=$1 AND version_id=$2',[req.params.id,a.version_id])).rows[0];required(row,'This quiz was updated. Reopen it to load the latest questions. Your saved answers are safe.',409);const q=row.definition,answer=req.body.answer;
  required(q.type==='mcq'?Number.isInteger(answer)&&answer>=0&&answer<q.options.length:typeof answer==='string'&&answer.length<=4000,'Enter a valid answer.',400);
  const client=await pool.connect();try{await client.query('BEGIN');const locked=(await client.query('SELECT completed FROM impulse.attempts WHERE id=$1 FOR UPDATE',[a.id])).rows[0];required(!locked.completed,'This quiz is submitted. Your answers are preserved.',409);
   await client.query(`INSERT INTO impulse.answers(attempt_id,question_id,answer) VALUES($1,$2,$3) ON CONFLICT(attempt_id,question_id) DO UPDATE SET answer=excluded.answer,result=CASE WHEN impulse.answers.answer=excluded.answer THEN impulse.answers.result ELSE NULL END,status=CASE WHEN impulse.answers.answer=excluded.answer THEN impulse.answers.status ELSE 'saved' END,lease=CASE WHEN impulse.answers.answer=excluded.answer THEN impulse.answers.lease ELSE NULL END,updated_at=now()`,[a.id,req.params.id,JSON.stringify(answer)]);
   const result=q.type==='mcq'&&!a.grade_on_submit?{score:answer===q.correct?1:0,maxScore:1,feedback:q.explanation,correctAnswer:q.options[q.correct],correctOption:q.correct}:null;
   const modelAnswer=q.type==='short_answer'&&!a.grade_on_submit&&typeof answer==='string'&&answer.trim()?q.model_answer:undefined;
   if(result)await client.query("UPDATE impulse.answers SET result=$3,status='graded' WHERE attempt_id=$1 AND question_id=$2",[a.id,req.params.id,JSON.stringify(result)]);
   await client.query('UPDATE impulse.attempts SET current_position=$2,updated_at=now() WHERE id=$1',[a.id,row.position]);await client.query('COMMIT');res.json({ok:true,...(result?{result}:{}),...(modelAnswer?{modelAnswer}:{})});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }));
 r.post('/api/impulse/quiz/:slug/grade/:id',limit('grade',60),wrap(async(req,res)=>{
  const a=await access(req);required(!a.grade_on_submit||a.completed,'Submit the exam before grading.',409);const row=(await pool.query('SELECT q.definition,a.answer,a.result,a.status FROM impulse.questions q JOIN impulse.answers a ON a.question_id=q.id AND a.attempt_id=$2 WHERE q.id=$1 AND q.version_id=$3',[req.params.id,a.id,a.version_id])).rows[0];required(row,'Save an answer first.',400);
  const q=row.definition;if(row.result)return res.json({result:row.result,...(q.type==='short_answer'?{modelAnswer:row.result._modelAnswer||q.model_answer}:{})});
  if(q.type==='mcq'){const result={score:row.answer===q.correct?1:0,maxScore:1,feedback:q.explanation,correctAnswer:q.options[q.correct],correctOption:q.correct};const updated=await pool.query("UPDATE impulse.answers SET result=$3,status='graded' WHERE attempt_id=$1 AND question_id=$2 AND answer=$4",[a.id,req.params.id,JSON.stringify(result),JSON.stringify(row.answer)]);required(updated.rowCount,'Your answer changed. Grade the saved answer again.',409);return res.json({result});}
  required(typeof row.answer==='string'&&row.answer.trim(),'Write an answer first.',400);const lease=randomUUID();
  const claim=await pool.query("UPDATE impulse.answers SET lease=$3,lease_until=now()+interval '50 seconds',status='grading' WHERE attempt_id=$1 AND question_id=$2 AND result IS NULL AND answer=$4 AND (lease IS NULL OR lease_until<now()) RETURNING question_id",[a.id,req.params.id,lease,JSON.stringify(row.answer)]);
  if(!claim.rowCount){
   const fresh=(await pool.query('SELECT result FROM impulse.answers WHERE attempt_id=$1 AND question_id=$2',[a.id,req.params.id])).rows[0];
   if(fresh?.result)return res.json({result:fresh.result,modelAnswer:fresh.result._modelAnswer||q.model_answer});
   required(false,'Grading is already in progress. Please wait.',409);
  }
  let grade:any;
  try{({grade}=await grader({question_text:q.text,model_answer:q.model_answer,rubric:q.rubric,tags:[],status:'published'},row.answer,a.quiz_id));}
  catch(e:any){
   await pool.query("UPDATE impulse.answers SET lease=NULL,lease_until=NULL,status='saved' WHERE attempt_id=$1 AND question_id=$2 AND lease=$3",[a.id,req.params.id,lease]).catch(()=>{});
   const retrySeconds=Math.max(1,Math.min(60,Number(e?.delaySeconds)||gradingRetrySeconds));
   const errorCode=e instanceof GradingError?e.code:'UNAVAILABLE';
   res.setHeader('Retry-After',String(retrySeconds));
   return res.status(503).json({error:gradingMessages[errorCode]||'Grading is temporarily unavailable. Your answer is saved.',errorCode,retryAfterSeconds:retrySeconds,retryAt:new Date(Date.now()+retrySeconds*1000).toISOString()});
  }
  const updated=await pool.query("UPDATE impulse.answers SET result=$4,status='graded',lease=NULL,lease_until=NULL WHERE attempt_id=$1 AND question_id=$2 AND lease=$3 AND answer=$5",[a.id,req.params.id,lease,JSON.stringify(grade),JSON.stringify(row.answer)]);
  required(updated.rowCount,'Your answer changed. Grade the saved answer again.',409);
  res.json({result:grade,modelAnswer:q.model_answer});
 }));
 r.post('/api/impulse/quiz/:slug/grade-all',limit('grade',60),wrap(async(req,res)=>{
  const a=await access(req);required(!a.grade_on_submit||a.completed,'Submit the exam before grading.',409);
  const rows=(await pool.query(`SELECT q.id,q.position,q.definition,a.answer FROM impulse.questions q JOIN impulse.answers a ON a.question_id=q.id AND a.attempt_id=$1 WHERE q.version_id=$2 AND q.definition->>'type'='short_answer' AND a.result IS NULL ORDER BY q.position`,[a.id,a.version_id])).rows
   .filter((row:any)=>typeof row.answer==='string'&&row.answer.trim());
  if(!rows.length)return res.json({graded:0,remaining:0});
  const batchSize=6;
  const startedAt=performance.now();
  const timeBudgetMs=65000;
  let totalGraded=0;
  let lastError:any=null;
  for(let start=0;start<rows.length;start+=batchSize){
   if(totalGraded>0&&performance.now()-startedAt>=timeBudgetMs)break;
   const chunk=rows.slice(start,start+batchSize);
   const lease=randomUUID();
   const claimedIds=new Set((await pool.query("UPDATE impulse.answers SET lease=$3,lease_until=now()+interval '50 seconds',status='grading' WHERE attempt_id=$1 AND question_id=ANY($2::uuid[]) AND result IS NULL AND (lease IS NULL OR lease_until<now()) RETURNING question_id",[a.id,chunk.map((r:any)=>r.id),lease])).rows.map((r:any)=>r.question_id));
   const claimed=chunk.filter((r:any)=>claimedIds.has(r.id));
   if(!claimed.length)continue;
   const items=claimed.map((row:any,index:number)=>({
    index,
    question:{question_text:row.definition.text,model_answer:row.definition.model_answer,rubric:row.definition.rubric,tags:[],status:'published' as const},
    answer:row.answer as string,
   }));
   let grades:{index:number;grade:any}[];
   try{
    grades=grader===gradePrivateCourse
     ?(await gradePrivateCourseBatch(items,a.quiz_id)).grade
     :await Promise.all(items.map(async({index,question,answer})=>({index,grade:(await grader(question,answer,a.quiz_id)).grade})));
   }catch(e:any){
    await pool.query("UPDATE impulse.answers SET lease=NULL,lease_until=NULL,status='saved' WHERE attempt_id=$1 AND lease=$2",[a.id,lease]).catch(()=>{});
    lastError=e;
    break;
   }
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    for(const {index,grade} of grades){
     const row=claimed[index];
     if(!row)continue;
     await client.query("UPDATE impulse.answers SET result=$4,status='graded',lease=NULL,lease_until=NULL WHERE attempt_id=$1 AND question_id=$2 AND lease=$3 AND answer=$5",[a.id,row.id,lease,JSON.stringify(grade),JSON.stringify(row.answer)]);
    }
    await client.query('COMMIT');
    totalGraded+=grades.length;
   }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  }
  const remaining=Math.max(0,rows.length-totalGraded);
  if(totalGraded===0&&lastError){
   const retrySeconds=Math.max(1,Math.min(60,Number(lastError?.delaySeconds)||gradingRetrySeconds));
   const errorCode=lastError instanceof GradingError?lastError.code:'UNAVAILABLE';
   res.setHeader('Retry-After',String(retrySeconds));
   return res.status(503).json({error:gradingMessages[errorCode]||'Grading is temporarily unavailable. Your answers are saved.',errorCode,retryAfterSeconds:retrySeconds,retryAt:new Date(Date.now()+retrySeconds*1000).toISOString(),graded:0,remaining});
  }
  res.json({graded:totalGraded,remaining});
 }));
 r.post('/api/impulse/quiz/:slug/submit',wrap(async(req,res)=>{const a=await access(req),client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT id FROM impulse.attempts WHERE id=$1 FOR UPDATE',[a.id]);if(a.grade_on_submit){await client.query(`UPDATE impulse.answers ans SET result=jsonb_build_object('score',CASE WHEN ans.answer=q.definition->'correct' THEN 1 ELSE 0 END,'maxScore',1,'feedback',q.definition->>'explanation','correctAnswer',q.definition->'options'->((q.definition->>'correct')::int),'correctOption',q.definition->'correct'),status='graded' FROM impulse.questions q WHERE ans.attempt_id=$1 AND ans.question_id=q.id AND q.version_id=$2 AND q.definition->>'type'='mcq' AND ans.result IS NULL`,[a.id,a.version_id]);}await client.query('UPDATE impulse.attempts SET completed=true,updated_at=now() WHERE id=$1',[a.id]);await client.query('COMMIT');res.json({ok:true});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}));
 return r;
}

/** Resolve old open-tab URLs only within the student's authorized quiz. */
export async function resolveCourseImage(questionId:string,versionId:string,quizId:string){
 const direct=(await pool.query("SELECT definition->'image' AS image FROM impulse.questions WHERE id=$1 AND version_id=$2",[questionId,versionId])).rows[0];
 if(direct)return direct.image;
 const current=(await pool.query(`SELECT current.definition->'image' AS image FROM impulse.questions old
 JOIN impulse.versions previous ON previous.id=old.version_id
 JOIN impulse.questions current ON current.version_id=$2
 AND (current.definition->>'id'=old.definition->>'id' OR
 (old.definition->>'id'=old.id::text AND current.position=old.position AND current.definition->>'type'=old.definition->>'type'))
 WHERE old.id=$1 AND previous.quiz_id=$3
 ORDER BY (current.definition->>'id'=old.definition->>'id') DESC LIMIT 1`,[questionId,versionId,quizId])).rows[0];
 return current?.image;
}



