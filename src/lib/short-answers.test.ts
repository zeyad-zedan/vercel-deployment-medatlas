import 'dotenv/config';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {eq,inArray} from 'drizzle-orm';
import {parseShortAnswerBatch,validateShortAnswerGrade,shortAnswerTemplate} from './short-answer-model.ts';
process.env.NODE_ENV='test';process.env.STUDENT_API_KEY_ENCRYPTION_KEY=randomBytes(32).toString('hex');
const enabled=/^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL||'');
const {db,pool,users,subjects,lectures}=await import('../db/index.ts');
after(()=>pool.end());
test('enabling the pool suppresses historical personal-key setup prompts and preserves the fallback',async()=>{
 const {publicShortAnswerAttempt}=await import('./short-answer-service.ts');
 const previous=process.env.GEMINI_GRADING_POOL;
 const row={id:1,question_id:1,status:'failed',snapshot:{question_text:'Question',rubric:[]},error_code:'KEY_MISSING'};
 try{
  process.env.GEMINI_GRADING_POOL='configured-on-server';
  const shared=publicShortAnswerAttempt(row);
  assert.equal(shared.errorCode,'POOL_RETRY');assert.doesNotMatch(shared.error||'',/Add your Gemini|Profile & Settings/);
  for(const code of ['KEY_OR_ACCESS','QUOTA','MODEL_UNAVAILABLE'])assert.match(publicShortAnswerAttempt({...row,error_code:code}).errorCode||'',/^POOL_/);
  delete process.env.GEMINI_GRADING_POOL;
  const personal=publicShortAnswerAttempt(row);assert.equal(personal.errorCode,'KEY_MISSING');assert.match(personal.error||'',/Add your Gemini/);
 }finally{if(previous===undefined)delete process.env.GEMINI_GRADING_POOL;else process.env.GEMINI_GRADING_POOL=previous;}
});
test('marking guides validate and grades reject missing, duplicated, inflated and fractional points',()=>{
 const [q]=parseShortAnswerBatch(shortAnswerTemplate);assert.equal(q.rubric.length,3);
 const result={feedback:'Two correct functions.',points:q.rubric.map((p,i)=>({id:p.id,awarded:i<2?1:0,feedback:i<2?'Correct.':'Missing.'}))};
 assert.equal(validateShortAnswerGrade({...result,score:999},q.rubric).score,2);
 for(const points of [result.points.slice(1),[result.points[0],result.points[0],result.points[2]],result.points.map(p=>({...p,awarded:999})),result.points.map(p=>({...p,awarded:0.5}))])assert.throws(()=>validateShortAnswerGrade({...result,points},q.rubric));
 assert.throws(()=>parseShortAnswerBatch(JSON.stringify({questions:[{...q,rubric:[]}]})));
 assert.throws(()=>parseShortAnswerBatch(JSON.stringify({questions:[{...q,rubric:[{description:'x',marks:-1}]}]})));
 for(const images of [['https://example.invalid/diagram.png'],Array(5).fill('diagram.png')])assert.throws(()=>parseShortAnswerBatch(JSON.stringify({questions:[{...JSON.parse(shortAnswerTemplate).questions[0],images}]})));
});
test('short-answer HTTP flow saves before grading, isolates users, deduplicates calls, handles quota and restores backups', {skip:!enabled},async()=>{
 const service=await import('./short-answer-service.ts'),keys=await import('./student-gemini-keys.ts');
 const {createServerSessionToken}=await import('../middleware/auth.ts');const {app}=await import('../../server.ts');
 const uid='sa-test-'+randomUUID(),other=uid+'-other',server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`,tokens=Object.fromEntries([uid,other].map(id=>[id,createServerSessionToken({uid:id,email:id+'@example.invalid',emailVerified:true})]));
 const api=async(path:string,body?:any,owner=uid)=>{const response=await fetch(origin+'/api/short-answers'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${tokens[owner]}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
 const actualFetch=globalThis.fetch;let providerCalls=0,telegramRequests=0,mode='success',release:(()=>void)|undefined,started:(()=>void)|undefined;let subjectId:number|undefined;
 const fakeKey='AIza'+randomBytes(26).toString('base64url').slice(0,35);
 globalThis.fetch=(async(input:any,options?:any)=>{
  if(String(input).startsWith('https://api.telegram.org/')){telegramRequests++;throw new Error('Grading must never download question images.');}
  if(String(input).startsWith('https://generativelanguage.googleapis.com/')){
   providerCalls++;assert.equal(options.headers['x-goog-api-key'],fakeKey);assert.ok(!String(input).includes(fakeKey));
   const body=JSON.parse(options.body),content=JSON.parse(body.contents[0].parts[0].text);assert.equal(content.student_answer,'Support and protection');assert.ok(!JSON.stringify(body).includes('@example.invalid'));
   assert.equal(body.contents[0].parts.length,1);assert.deepEqual(Object.keys(content).sort(),['model_answer','question','rubric','student_answer']);assert.ok(!JSON.stringify(body).includes('image-only-for-student'));
   assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,'minimal');
   if(mode==='quota')return Response.json({error:{message:fakeKey+' must never leak'}},{status:429});
   if(mode==='invalid')return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"points":[],"feedback":"bad"}'}]}}]});
   if(mode==='timeout')throw new Error(fakeKey+' network issue');
   started?.();if(mode==='wait')await new Promise<void>(r=>{release=r;});
   return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({score:999,feedback:'Two correct functions.',points:content.rubric.map((p:any,i:number)=>({id:p.id,awarded:i<2?1:0,feedback:i<2?'Correct.':'Movement is missing.'}))})}]}}]});
  }
  return actualFetch(input,options);
 }) as typeof fetch;
 try{
  await db.insert(users).values([uid,other].map(id=>({uid:id,email:id+'@example.invalid',displayName:'Disposable SA test'})));
  const [subject]=await db.insert(subjects).values({slug:uid,title:'SA test',description:'Disposable'}).returning();subjectId=subject.id;
  const [lecture]=await db.insert(lectures).values({subjectId:subject.id,title:'Bone functions',description:'Disposable'}).returning();
  const source=JSON.stringify({questions:[{...JSON.parse(shortAnswerTemplate).questions[0],status:'published'}]});
  assert.equal((await service.importShortAnswers(lecture.id,source,true,true) as any).imported,1);assert.equal((await service.importShortAnswers(lecture.id,source,true,true) as any).duplicates,1);
  const extra=JSON.stringify({questions:Array.from({length:6},(_,i)=>({...JSON.parse(source).questions[0],question_text:`Additional practice question ${i+1}`}))});
  await service.importShortAnswers(lecture.id,extra,true,true);
  const listed=await api('/questions?lectureId='+lecture.id);assert.equal(listed.status,200);assert.equal(listed.data.questions.length,6);assert.doesNotMatch(JSON.stringify(listed.data),/model_answer|rubric/);
  assert.equal((await api(`/questions?lectureId=${lecture.id}&after=${listed.data.nextCursor}`)).data.questions.length,1);
  const questionId=listed.data.questions[0].id;
  let saved=await api('/answers',{questionId,answer:'Support and protection',userUid:other});const id=saved.data.attempt.id;
  assert.equal(providerCalls,0);assert.equal(saved.data.attempt.status,'saved');assert.equal((await api('/answers/'+id,undefined,other)).status,404);
  assert.equal((await api(`/answers/${id}/grade`,{})).status,400);
  const missing=await api(`/answers/${id}/grade`,{consent:true});assert.match(missing.data.attempt.error,/Add your Gemini/);assert.equal(missing.data.attempt.errorCode,'KEY_MISSING');assert.equal(providerCalls,0);
  await keys.saveStudentGeminiKey(uid,fakeKey);await pool.query('UPDATE public.short_answer_attempts SET retry_at=null WHERE id=$1',[id]);
  mode='wait';const signal=new Promise<void>(r=>{started=r;});const first=api(`/answers/${id}/grade`,{consent:true});await signal;
  const second=await api(`/answers/${id}/grade`,{consent:true});assert.equal(second.data.attempt.status,'grading');assert.equal(providerCalls,1);release!();const graded=await first;
  assert.equal(graded.data.attempt.result.score,2);assert.equal(graded.data.attempt.result.maxScore,3);assert.match(graded.data.attempt.modelAnswer,/Support/);
  await service.manageShortAnswers(lecture.id,[questionId],'draft');assert.equal((await api('/answers',{questionId,answer:'A new answer'})).status,404);assert.equal((await api('/answers/'+id)).data.attempt.result.score,2,'unpublishing must preserve historical answers');await service.manageShortAnswers(lecture.id,[questionId],'published');
  const repeated=await api('/answers',{questionId,answer:'Support and protection'});assert.equal(repeated.data.attempt.id,id);
  await api(`/answers/${id}/grade`,{consent:true});await api('/answers/'+id);assert.equal(providerCalls,1,'reopening/repeating a grade must consume no Gemini quota');
  assert.equal((await api('/history')).data.attempts.length,1);assert.equal((await api('/history',undefined,other)).data.attempts.length,0);
  // Reuse a saved attempt fixture to exercise retry failures without new provider prompts.
  for(const [failure,expected] of [['quota','QUOTA'],['invalid','INVALID_RESPONSE'],['timeout','TIMEOUT']]){
   mode=failure;await pool.query("UPDATE public.short_answer_attempts SET status='saved',result=null,retry_at=null,grade_started_at=null WHERE id=$1",[id]);
   const failed=await api(`/answers/${id}/grade`,{consent:true});assert.equal(failed.data.attempt.status,'failed');assert.equal(failed.data.attempt.answer,'Support and protection');assert.ok(!JSON.stringify(failed.data).includes(fakeKey));
   const [row]=(await pool.query('SELECT error_code FROM public.short_answer_attempts WHERE id=$1',[id])).rows;assert.equal(row.error_code,expected);
   const before:number=providerCalls;await api(`/answers/${id}/grade`,{consent:true});assert.equal(providerCalls,before,'cooldown must avoid another provider request');
  }
  const imageHash='d'.repeat(64),imageSource=JSON.stringify({questions:[{...JSON.parse(source).questions[0],images:[{file:'diagram.png',alt:'Figure for students'}]}]});
  await assert.rejects(()=>service.importShortAnswers(lecture.id,imageSource,true,false),/missing image/);
  const manifest={imageFiles:[{name:'diagram.png',id:imageHash}]};
  const preview:any=await service.importShortAnswers(lecture.id,imageSource,true,false,manifest);assert.equal(preview.questions[0].imageFiles[0].file,'diagram.png');
  await assert.rejects(()=>service.importShortAnswers(lecture.id,imageSource,true,true,manifest),/Upload the image to Telegram/);
  const {imageForClient}=await import('./telegram-question-images.ts');
  const reference=imageForClient({id:imageHash,telegramFileId:'image-only-for-student',mimeType:'image/png',fileSize:123,alt:''});
  await service.importShortAnswers(lecture.id,imageSource,true,true,{...manifest,uploadedImages:{'diagram.png':reference}});
  const [storedImageQuestion]=(await pool.query('SELECT id,definition FROM public.short_answer_questions WHERE lecture_id=$1 ORDER BY id DESC LIMIT 1',[lecture.id])).rows;
  assert.equal(storedImageQuestion.definition.images[0].telegramFileId,'image-only-for-student');assert.deepEqual(Object.keys(storedImageQuestion.definition.images[0]).sort(),['alt','fileSize','id','mimeType','telegramFileId']);
  const imageAttempt=(await api('/answers',{questionId:storedImageQuestion.id,answer:'Support and protection'})).data.attempt;
  assert.ok(imageAttempt.images[0].source.startsWith('/api/question-images/'));assert.ok(!JSON.stringify(imageAttempt).includes('image-only-for-student'));
  mode='success';const imageGraded=await api(`/answers/${imageAttempt.id}/grade`,{consent:true});assert.equal(imageGraded.data.attempt.status,'graded');assert.equal(imageGraded.data.attempt.result.score,2);assert.equal(telegramRequests,0,'Gemini grading sends no image links and fetches no image bytes');
  assert.equal((await api('/answers/'+imageAttempt.id)).data.attempt.images[0].id,imageHash);
  const {createEncryptedBackup,testRestoreBackup}=await import('./backup-service.ts');const {envelope}=await createEncryptedBackup();assert.equal((await testRestoreBackup(envelope)).status,'verified');
 }finally{release?.();globalThis.fetch=actualFetch;await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await db.delete(users).where(inArray(users.uid,[uid,other]));if(subjectId)await db.delete(subjects).where(eq(subjects.id,subjectId));}
});
