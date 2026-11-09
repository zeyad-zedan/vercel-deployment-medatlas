import 'dotenv/config';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {eq,inArray,or,like} from 'drizzle-orm';
import {catalogByContentType,destinationLabel} from './lecture-kinds.ts';
import PracticalView from '../components/PracticalView.tsx';
process.env.NODE_ENV='test';
const enabled=/^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL||'');
const {db,pool,users,subjects,lectures,examSessions,questionAttempts,bookmarks,importBatches,adminAuditLogs}=await import('../db/index.ts');
after(()=>pool.end());
test('lecture and section browsing stay separate and Practical uses section labels and existing progress',()=>{
 const theory={id:1,title:'Theory',questionCount:8},section={id:2,title:'Arm bones',contentType:'practical',lectureNumber:1,questionCount:2,shortAnswerCount:3};
 const catalog={subjects:[{id:1,title:'Anatomy',lectures:[theory,section]}],lectures:[theory,section]};
 assert.deepEqual(catalogByContentType(catalog,'lecture').lectures,[theory]);assert.deepEqual(catalogByContentType(catalog,'practical').lectures,[section]);
 assert.equal(destinationLabel({...section,subjectTitle:'Anatomy'}),'Anatomy → Section 1: Arm bones');
 const html=renderToStaticMarkup(<PracticalView catalog={catalog} dashboardData={{subjectProgress:[{subjectId:1,lectures:[{lectureId:2,uniqueQuestionsAttempted:1}]}]}} onStartSession={()=>{}} onResetProgress={async()=>{}}/>);
 assert.match(html,/Section 1/);assert.match(html,/1 of 2 questions completed/);assert.doesNotMatch(html,/Difficulty for/);assert.match(html,/More actions/);assert.ok(!html.includes('Theory'));
});
test('portal section creation, matching/short-answer uploads, publication and reclassification preserve answers/bookmarks', {skip:!enabled},async()=>{
 const repo=await import('../db/repository.ts');await repo.ensureSeededDatabase();
 const {server:portal}=await import('../../tools/local-pdf-tool.ts'),{app}=await import('../../server.ts');
 const {createServerSessionToken}=await import('../middleware/auth.ts'),{imageForClient}=await import('./telegram-question-images.ts');
 const {shortAnswerTemplate}=await import('./short-answer-model.ts'),sa=await import('./short-answer-service.ts');
 const marker=randomUUID(),student='section-student-'+marker,admin='section-admin-'+marker,owner='section-owner-'+marker;
 let subjectId:number|undefined,createdOwner=false;
 const http=app.listen(0,'127.0.0.1');portal.listen(0,'127.0.0.1');await Promise.all([new Promise<void>(r=>http.once('listening',r)),new Promise<void>(r=>portal.once('listening',r))]);
 const origin=`http://127.0.0.1:${(http.address() as any).port}`,portalOrigin=`http://127.0.0.1:${(portal.address() as any).port}`;
 const request=async(path:string,body:any,uid=student)=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${createServerSessionToken({uid,email:uid+'@example.invalid',emailVerified:true})}`},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
 try{
  await db.insert(users).values([{uid:student,email:student+'@example.invalid',displayName:'Section student'},{uid:admin,email:admin+'@example.invalid',displayName:'Section administrator',role:'admin'}]);
  if(!(await db.select().from(users).where(eq(users.email,repo.OWNER_ADMIN_EMAIL))).length){await db.insert(users).values({uid:owner,email:repo.OWNER_ADMIN_EMAIL,displayName:'Portal fixture owner',role:'admin'});createdOwner=true;}
  const [subject]=await db.insert(subjects).values({slug:marker,title:'Practical '+marker,description:'Disposable test'}).returning();subjectId=subject.id;
  const theory=(await request('/api/admin/lectures',{subjectId:subject.id,title:'Theory '+marker,description:'Theory',lectureNumber:1,status:'published'},admin)).data.lecture;assert.equal(theory.contentType,'lecture');
  const body={subjectId:subject.id,title:'Arm bones '+marker,description:'Practical section',lectureNumber:1,contentType:'practical',status:'draft'};
  assert.equal((await fetch(portalOrigin+'/api/mcq/destinations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,403);
  const response=await fetch(portalOrigin+'/api/mcq/destinations',{method:'POST',headers:{'Content-Type':'application/json','X-MedAtlas-Portal':'1'},body:JSON.stringify(body)});assert.equal(response.status,200);const section=(await response.json()).lecture;assert.equal(section.contentType,'practical');assert.equal(section.status,'draft');
  const options=await(await fetch(portalOrigin+'/api/mcq/lectures')).json();assert.ok(options.subjects.some((row:any)=>row.id===subject.id));assert.equal(options.lectures.find((row:any)=>row.id===section.id).contentType,'practical');
  const hash='c'.repeat(64),image=imageForClient({id:hash,telegramFileId:'section-test-image',mimeType:'image/png',fileSize:123,alt:'Numbered arm bone'});
  const source=JSON.stringify({questions:[{question_type:'matching',question_text:'Match the numbered structures.',images:['arm.png'],matches:[{number:'1',answer:'Head'},{number:'2',answer:'Shaft'}],status:'published'}]});
  const imported=await repo.executeCsvImportAdmin({uid:admin,email:admin+'@example.invalid'},marker+'.json',source,section.id,undefined,{format:'json',imageFiles:[{name:'arm.png',id:hash}],uploadedImages:{'arm.png':image}});assert.equal(imported.batch.importedCount,2);
  const shortRoot=JSON.parse(shortAnswerTemplate);shortRoot.questions[0].status='published';await sa.importShortAnswers(section.id,JSON.stringify(shortRoot),true,true);
  assert.ok(!(await repo.getPublishedCatalog()).lectures.some((row:any)=>row.id===section.id));
  const published=await request('/api/admin/lectures',{...section,status:'published'},admin);assert.equal(published.status,200);
  // Older clients may omit the type while editing; the stored classification must remain intact.
  const {contentType,...withoutType}=published.data.lecture;
  assert.equal((await request('/api/admin/lectures',withoutType,admin)).data.lecture.contentType,'practical');
  assert.equal((await request('/api/admin/lectures',{...withoutType,contentType:'unknown'},admin)).status,400);
  const catalog=await repo.getPublishedCatalog();assert.equal(catalog.lectures.find((row:any)=>row.id===section.id).shortAnswerCount,1,JSON.stringify((await pool.query('SELECT lecture_id,status FROM public.short_answer_questions WHERE lecture_id=$1',[section.id])).rows));
  assert.ok(!catalogByContentType(catalog,'lecture').lectures.some((row:any)=>row.id===section.id));assert.ok(catalogByContentType(catalog,'practical').lectures.some((row:any)=>row.id===section.id));
  const started=await request('/api/sessions',{mode:'study',lectureIds:[section.id],batchSize:6});assert.equal(started.status,201);const session=started.data.session,q=session.questions.find((question:any)=>question.questionType==='matching');assert.ok(q);
  assert.equal((await request(`/api/sessions/${session.id}/answer`,{questionId:q.id,selectedOption:'A',matchingChoiceId:q.matching.correctChoiceId,lockAnswer:true,slim:true})).status,200);
  await request('/api/bookmarks/toggle',{questionId:q.id,bookmarked:true});
  const saved=await sa.saveShortAnswer(student,(await sa.shortAnswerQuestions(student,section.id,undefined)).questions[0].id,'Support.');
  await request('/api/admin/lectures',{...published.data.lecture,contentType:'lecture'},admin);
  assert.equal((await repo.getExamSessionForStudent(student,session.id,undefined,{batched:true})).questions.find((question:any)=>question.id===q.id).submitted,true);
  assert.equal((await db.select().from(bookmarks).where(eq(bookmarks.userUid,student))).length,1);
  assert.equal((await sa.getShortAnswerAttempt(student,saved.id)).answer,'Support.');
  const {createEncryptedBackup,testRestoreBackup}=await import('./backup-service.ts');const {envelope}=await createEncryptedBackup();assert.equal((await testRestoreBackup(envelope)).status,'verified');
 }finally{
  await Promise.all([new Promise<void>((resolve,reject)=>http.close(e=>e?reject(e):resolve())),new Promise<void>((resolve,reject)=>portal.close(e=>e?reject(e):resolve()))]);
  await db.delete(bookmarks).where(eq(bookmarks.userUid,student));await db.delete(examSessions).where(eq(examSessions.userUid,student));await db.delete(importBatches).where(eq(importBatches.adminUid,admin));
  await db.delete(adminAuditLogs).where(or(eq(adminAuditLogs.adminUid,admin),like(adminAuditLogs.details,'%'+marker+'%')));
  if(subjectId)await db.delete(subjects).where(eq(subjects.id,subjectId));await db.delete(users).where(inArray(users.uid,[student,admin,...createdOwner?[owner]:[]]));repo.invalidateCatalogCache();
 }
});
