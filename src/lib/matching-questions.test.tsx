import 'dotenv/config';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {eq,inArray} from 'drizzle-orm';
import {getMatchingJsonTemplate,expandMatchingQuestion,matchingGrade} from './matching-questions.ts';
import {parseAndValidateJsonQuestions} from './json-import.ts';
import {formatQuestionForClient} from './mcq-engine.ts';
import {readSessionDrafts,readSessionMatchingDrafts} from './session-progress.ts';
import {MatchingQuestion} from '../components/MatchingQuestion.tsx';

process.env.NODE_ENV='test';
const enabled=/^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL||'');
const {db,pool,users,subjects,lectures,questions,examSessions,questionAttempts,bookmarks,importBatches,adminAuditLogs}=await import('../db/index.ts');
const repo=await import('../db/repository.ts');
after(async()=>{await pool.end();});
const identity={A:'A',B:'B',C:'C',D:'D'} as const;
const imageHash='b'.repeat(64),filename='numbered-bone.png';
const json=()=>JSON.stringify({questions:[{...getMatchingJsonTemplate(),status:'published'}]});

test('one numbered image expands to individually scored labels without four-choice restrictions or key leakage',()=>{
 const report=parseAndValidateJsonQuestions(json(),new Set(),{defaultSubject:'Anatomy',defaultLecture:'Bones'},[{name:filename,id:imageHash}]);
 assert.deepEqual(report.headerErrors,[]);assert.equal(report.validCount,3);assert.equal(report.totalRows,3);
 assert.ok(report.rows.every(row=>row.matching?.groupId===report.rows[0].matching?.groupId));
 assert.equal(new Set(report.rows.map(row=>row.contentHash)).size,3);assert.deepEqual(report.referencedImages,[filename]);
 for(const row of report.rows){
  const definition=row.matching!;assert.equal(matchingGrade(definition,definition.correctChoiceId),'A');
  assert.equal(matchingGrade(definition,definition.choices.find(choice=>choice.id!==definition.correctChoiceId)!.id),'B');
  assert.throws(()=>matchingGrade(definition,'not-a-choice'));
  const question={...row,id:1,subjectId:1,lectureId:1,matching:definition};
  const active=formatQuestionForClient(question,identity,true);
  assert.doesNotMatch(JSON.stringify(active),/correctChoiceId|correctDisplayedOption|explanation/);
  const markup=renderToStaticMarkup(<MatchingQuestion question={{...active,submitted:false}} exam onSelect={()=>{}}/>);
  assert.match(markup,/<select/);assert.doesNotMatch(markup,/Correct answer:/);
 }
 const duplicate=parseAndValidateJsonQuestions(json(),new Set(report.rows.map(row=>row.contentHash)),{defaultSubject:'Anatomy',defaultLecture:'Bones'},[{name:filename,id:imageHash}]);
 assert.equal(duplicate.duplicateCount,3);
 const bigger={...getMatchingJsonTemplate(),matches:Array.from({length:8},(_,index)=>({number:String(index+1),answer:`Structure ${index+1}`}))};
 assert.equal(expandMatchingQuestion(bigger,'group')[0].matching.choices.length,9);
 assert.throws(()=>expandMatchingQuestion({...bigger,matches:[{number:'3a',answer:'First'},{number:'3A',answer:'Second'}]},'group'));
});

test('matching draft restoration keeps actual choices alongside legacy MCQ drafts and rejects unrelated IDs',()=>{
 const original=globalThis.localStorage;
 globalThis.localStorage={getItem:()=>JSON.stringify({version:1,answers:{1:'B',2:'A',9:'A'},matchingChoices:{2:'c3',9:'c2'}})} as unknown as Storage;
 try{
  const session={id:1,mode:'study',status:'in_progress',questions:[{id:1,submitted:false},{id:2,submitted:false}]};
  assert.deepEqual(readSessionDrafts(session),{1:'B',2:'A'});assert.deepEqual(readSessionMatchingDrafts(session),{2:'c3'});
  assert.deepEqual(readSessionMatchingDrafts({...session,status:'completed'}),{});
 }finally{globalThis.localStorage=original;}
});

test('matching import, immediate per-label saves, bookmarks, cumulative resume, grading and historical review stay consistent', {skip:!enabled},async()=>{
 await repo.ensureSeededDatabase();
 const marker=randomUUID(),studentUid=`match-student-${marker}`,adminUid=`match-admin-${marker}`;
 const {createServerSessionToken}=await import('../middleware/auth.ts');
 const {imageForClient}=await import('./telegram-question-images.ts');
 const {app}=await import('../../server.ts');
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const token=createServerSessionToken({uid:studentUid,email:studentUid+'@example.invalid',emailVerified:true});
 const api=async(path:string,body?:any)=>{
  const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();assert.ok(response.ok,`${response.status}: ${data.error}`);return data;
 };
 let subjectId:number|undefined;
 try{
  await db.insert(users).values([{uid:studentUid,email:studentUid+'@example.invalid',displayName:'Matching test student'}, {uid:adminUid,email:adminUid+'@example.invalid',displayName:'Matching test admin',role:'admin'}]);
  const [subject]=await db.insert(subjects).values({slug:marker,title:'Matching anatomy',description:'Disposable matching test'}).returning();subjectId=subject.id;
  const [lecture]=await db.insert(lectures).values({subjectId:subject.id,title:'Numbered bones',description:'Disposable matching test'}).returning();
  repo.invalidateCatalogCache();
  const reference=imageForClient({id:imageHash,telegramFileId:'matching-test-image',mimeType:'image/png',fileSize:123,alt:'Numbered bone'});
  const imported=await repo.executeCsvImportAdmin({uid:adminUid,email:adminUid+'@example.invalid'},'matching.json',json(),lecture.id,undefined,
   {format:'json',imageFiles:[{name:filename,id:imageHash}],uploadedImages:{[filename]:reference}});
  assert.equal(imported.batch.importedCount,3);
  const stored=await db.select().from(questions).where(eq(questions.lectureId,lecture.id));assert.ok(stored.every(q=>q.matching&&q.images.length===1));
  const study=(await api('/api/sessions',{mode:'study',lectureIds:[lecture.id],shuffleOptions:true,batchSize:6})).session;
  const [first,second]=study.questions;
  assert.equal(first.questionType,'matching');assert.equal(study.totalQuestions,3);
  await api('/api/bookmarks/toggle',{questionId:first.id,bookmarked:true});
  const save=(q:any,choice:string)=>api(`/api/sessions/${study.id}/answer`,{questionId:q.id,selectedOption:'A',matchingChoiceId:choice,lockAnswer:true,slim:true});
  await save(first,first.matching.correctChoiceId);
  const wrong=second.matching.choices.find((choice:any)=>choice.id!==second.matching.correctChoiceId).id;
  await save(second,wrong);
  // Already locked study answers cannot be changed, including matching choices.
  await save(second,second.matching.correctChoiceId);
  const resumed=(await api('/api/sessions',{mode:'study',lectureIds:[lecture.id],batchSize:6})).session;
  assert.equal(resumed.correctCount,1);assert.equal(resumed.incorrectCount,1);assert.equal(resumed.unansweredCount,1);
  assert.equal(resumed.questions[0].matchingChoiceId,first.matching.correctChoiceId);assert.equal(resumed.questions[1].matchingChoiceId,wrong);
  assert.equal((await api('/api/bookmarks?view=saved')).bookmarks[0].matchingChoiceId,first.matching.correctChoiceId);
  const completed=(await api(`/api/sessions/${study.id}/complete`,{answers:{[second.id]:'A'},batchSize:6})).session;
  assert.equal(completed.correctCount,1,'a fabricated MCQ marker must not overwrite a wrong matching choice');
  assert.equal(completed.incorrectCount,1);assert.equal(completed.unansweredCount,1);
  const saved=await db.select().from(questionAttempts).where(eq(questionAttempts.sessionId,study.id));
  assert.equal(saved.length,2);assert.equal(saved.find(a=>a.questionId===second.id)?.matchingChoiceId,wrong);
  const matchingSnapshot=JSON.parse(saved[0].questionSnapshotJson).matching;assert.ok(matchingSnapshot.correctChoiceId);
  const exam=(await api('/api/sessions',{mode:'exam',lectureIds:[lecture.id],requestedCount:3,batchSize:6,shuffleQuestions:false,shuffleOptions:true})).session;
  assert.doesNotMatch(JSON.stringify(exam),/correctChoiceId|correctDisplayedOption|explanation/);
  const examQuestion=exam.questions[0];
  const key=stored.find(q=>q.id===examQuestion.id)!.matching!;
  const wrongChoice=key.choices.find(choice=>choice.id!==key.correctChoiceId)!.id;
  const draft=(await api(`/api/sessions/${exam.id}/answer`,{questionId:examQuestion.id,selectedOption:'A',matchingChoiceId:wrongChoice,lockAnswer:false,slim:true})).session;
  assert.equal(draft.correctCount,0);assert.equal(draft.incorrectCount,0);assert.equal(draft.selectedDisplayed,'A');
  const submitted=(await api(`/api/sessions/${exam.id}/complete`,{answers:{[examQuestion.id]:'A'},batchSize:6})).session;
  assert.equal(submitted.correctCount,0);assert.equal(submitted.incorrectCount,1);assert.equal(submitted.questions[0].matchingChoiceId,wrongChoice);
  const forged=await fetch(origin+`/api/sessions/${resumed.id}/answer`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({questionId:resumed.questions[2].id,selectedOption:'A',matchingChoiceId:'bad',lockAnswer:true,slim:true})});
  assert.equal(forged.status,409,'completed sessions must remain immutable');
  const adminToken=createServerSessionToken({uid:adminUid,email:adminUid+'@example.invalid',emailVerified:true});
  const edit=async(choiceId:string)=>fetch(origin+'/api/admin/questions',{method:'POST',headers:{Authorization:`Bearer ${adminToken}`,'Content-Type':'application/json'},body:JSON.stringify({...stored.find(q=>q.id===examQuestion.id),matchingChoiceId:choiceId})});
  assert.equal((await edit('not-a-choice')).status,400,'Admin edits must validate the actual matching answer key.');
  const edited=await edit(wrongChoice);assert.equal(edited.status,200);assert.equal((await edited.json()).question.matching.correctChoiceId,wrongChoice);
  repo.evictCachedSessionQuestions(exam.id);
  const review=(await api(`/api/sessions/${exam.id}?batchSize=6`)).session;
  assert.equal(review.questions[0].matching.correctChoiceId,key.correctChoiceId,'historical answer keys must survive later edits');
  const {createEncryptedBackup,testRestoreBackup}=await import('./backup-service.ts');
  const {envelope}=await createEncryptedBackup();assert.equal((await testRestoreBackup(envelope)).status,'verified');
 }finally{
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await db.delete(bookmarks).where(eq(bookmarks.userUid,studentUid));await db.delete(examSessions).where(eq(examSessions.userUid,studentUid));
  await db.delete(adminAuditLogs).where(eq(adminAuditLogs.adminUid,adminUid));await db.delete(importBatches).where(eq(importBatches.adminUid,adminUid));
  if(subjectId)await db.delete(subjects).where(eq(subjects.id,subjectId));await db.delete(users).where(inArray(users.uid,[studentUid,adminUid]));repo.invalidateCatalogCache();
 }
});
