import 'dotenv/config';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {quizScore} from './quiz-scoring.ts';
import {tournamentsEnabled} from './study-rewards.ts';
process.env.NODE_ENV='test';process.env.STUDENT_API_KEY_ENCRYPTION_KEY=randomBytes(32).toString('hex');
const enabled=/^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL||'');
const {pool}=await import('../db/index.ts');after(()=>pool.end());
test('mixed scoring preserves MCQ scores, awards partial marks and leaves ungraded text pending',()=>{
 const score=quizScore([{questionId:1,correctAnswer:'B',selectedCanonical:'B'},{questionId:2,shortAnswerId:1,shortAnswerAttemptId:9,maxMarks:3,shortAnswerStatus:'graded',shortAnswerScore:2},{questionId:3,shortAnswerId:2,shortAnswerAttemptId:10,maxMarks:2,shortAnswerStatus:'saved'},{questionId:4,shortAnswerId:3,maxMarks:1}]);
 assert.equal(score.correctCount,1);assert.equal(score.incorrectCount,1);assert.equal(score.unansweredCount,1);assert.deepEqual(score.quizScore,{earnedMarks:3,maxMarks:7,pendingGradingCount:1,partiallyCorrectCount:1,shortAnswerCount:3});
});
test('one lecture quiz mixes all types with six-question reads, safe grading, bookmark/resume and immutable reviews', {skip:!enabled},async()=>{
 const repo=await import('../db/repository.ts'),keys=await import('./student-gemini-keys.ts'),{app}=await import('../../server.ts'),{createServerSessionToken}=await import('../middleware/auth.ts');
 const marker=randomUUID(),uid='mixed-student-'+marker,other=uid+'-other',admin='mixed-admin-'+marker;
 await pool.query("INSERT INTO users(uid,email,display_name,role) VALUES($1,$2,'Mixed test','student'),($3,$4,'Other','student'),($5,$6,'Mixed admin','admin')",[uid,uid+'@example.invalid',other,other+'@example.invalid',admin,admin+'@example.invalid']);
 const subject=(await pool.query("INSERT INTO subjects(slug,title,description) VALUES($1,'Mixed types','Fixture') RETURNING id",[marker])).rows[0],lecture=(await pool.query("INSERT INTO lectures(subject_id,title,description,content_type) VALUES($1,'Mixed section','Fixture','practical') RETURNING id",[subject.id])).rows[0];
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const tokens=Object.fromEntries([uid,other].map(id=>[id,createServerSessionToken({uid:id,email:id+'@example.invalid',emailVerified:true})]));
 const request=async(path:string,body?:any,owner=uid)=>{const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${tokens[owner]}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
 const ok=async(path:string,body?:any)=>{const result=await request(path,body);assert.ok(result.status<300,`${path} ${result.status}: ${JSON.stringify(result.data)}`);return result.data;};
 const realFetch=globalThis.fetch;let googleCalls=0;let fullCredit=false,unavailableOnce=false;
 let holdProvider:undefined|(()=>Promise<void>);
 globalThis.fetch=(async(input:any,init:any)=>{if(String(input).startsWith('https://generativelanguage.googleapis.com/')){googleCalls++;const content=JSON.parse(JSON.parse(init.body).contents[0].parts[0].text);assert.deepEqual(Object.keys(content).sort(),['model_answer','question','rubric','student_answer']);assert.ok(!JSON.stringify(content).includes('telegram'));await holdProvider?.();if(unavailableOnce){unavailableOnce=false;return new Response(null,{status:503});}return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({feedback:fullCredit?'Full credit.':'Partial credit.',points:content.rubric.map((p:any,i:number)=>({id:p.id,awarded:i?Number(fullCredit):2,feedback:'Checked against the model.'}))})}]}}]});}return realFetch(input,init);}) as typeof fetch;
 const model='PRIVATE MODEL '+marker;
 let tournamentId: number | undefined;
 try{
  const source=JSON.stringify({questions:[...Array.from({length:6},(_,i)=>({question_type:'mcq',question_text:`MCQ ${marker} ${i}`,options:{A:'One',B:'Two',C:'Three',D:'Four'},correct_answer:'A',explanation:'Explanation',tags:['Foundation'],status:'published'})),{question_type:'short_answer',question_text:'Describe the bone functions '+marker,model_answer:model,rubric:[{description:'Support',marks:2},{description:'Protection',marks:1}],tags:['Anatomy'],status:'published'}]});
  const imported=await repo.executeCsvImportAdmin({uid:admin,email:admin+'@example.invalid'},marker+'.json',source,lecture.id,undefined,{format:'json',imageFiles:[]});assert.equal(imported.batch.importedCount,7);
  const stored=(await pool.query('SELECT * FROM questions WHERE lecture_id=$1 ORDER BY id',[lecture.id])).rows,short=stored.find(q=>q.short_answer_id);assert.ok(short);assert.equal(stored.length,7);assert.ok(!JSON.stringify(short).includes(model),'The quiz bank must not duplicate model answers.');
  const start=(await ok('/api/sessions',{mode:'study',lectureIds:[lecture.id],batchSize:6})).session;assert.equal(start.totalQuestions,7);assert.equal(start.questions.filter((q:any)=>q.contentLoaded).length,6);assert.equal(start.questions[6].questionType,'short_answer');assert.ok(!JSON.stringify(start).includes(model));
  const batch=(await ok(`/api/sessions/${start.id}?batchSize=6&offset=6`)).session;const q=batch.questions[0];assert.equal(q.questionType,'short_answer');assert.equal(q.maxMarks,3);assert.ok(!JSON.stringify(batch).includes(model));
  assert.equal((await request(`/api/sessions/${start.id}/short-answer`,{questionId:q.id,answer:'My answer'},other)).status,403);
  assert.equal((await request(`/api/sessions/${start.id}/answer`,{questionId:q.id,selectedOption:'A',lockAnswer:true,slim:true})).status,400);
  const saved=await ok(`/api/sessions/${start.id}/short-answer`,{questionId:q.id,answer:'Support and protection'});assert.equal(saved.attempt.status,'saved');assert.equal(saved.session.quizScore.pendingGradingCount,1);assert.equal(saved.session.incorrectCount,0);
  await ok('/api/bookmarks/toggle',{questionId:q.id,bookmarked:true});const resumed=(await ok('/api/sessions',{mode:'study',lectureIds:[lecture.id],batchSize:6})).session;assert.equal(resumed.questions[6].hasSavedAnswer,true);
  const loaded=(await ok(`/api/sessions/${start.id}?batchSize=6&offset=6`)).session.questions[0];assert.equal(loaded.shortAnswerAttempt.answer,'Support and protection');assert.equal(loaded.isBookmarked,true);
  const dashboard=await ok('/api/dashboard');assert.equal(dashboard.totalIncorrectAnswers??dashboard.overview?.totalIncorrectAnswers??0,0);
  await keys.saveStudentGeminiKey(uid,'AIza'+'B'.repeat(35));const graded=await ok(`/api/sessions/${start.id}/short-answer/grade`,{questionId:q.id,consent:true});assert.equal(graded.attempt.result.score,2);assert.equal(graded.session.quizScore.maxMarks,9);assert.equal(graded.session.quizScore.earnedMarks,2);assert.equal(graded.session.quizScore.pendingGradingCount,0);assert.equal(googleCalls,1);
  await ok(`/api/sessions/${start.id}/short-answer/grade`,{questionId:q.id,consent:true});assert.equal(googleCalls,1);
  const completed=(await ok(`/api/sessions/${start.id}/complete`,{answers:{},batchSize:6})).session;assert.equal(completed.status,'completed');assert.equal(completed.quizScore.earnedMarks,2);
  const review=(await ok(`/api/sessions/${start.id}?batchSize=6&offset=6`)).session.questions[0];assert.equal(review.shortAnswerAttempt.modelAnswer,model);assert.equal(review.shortAnswerAttempt.answer,'Support and protection');
  const exam=(await ok('/api/sessions',{mode:'exam',lectureIds:[lecture.id],requestedCount:7,timeLimitMinutes:10,shuffleQuestions:false,batchSize:6})).session;
  const draft=await ok(`/api/sessions/${exam.id}/short-answer`,{questionId:q.id,answer:'A different exam answer'});assert.equal(draft.attempt.result,null);assert.equal(draft.attempt.modelAnswer,undefined);
  assert.equal((await request(`/api/sessions/${exam.id}/short-answer/grade`,{questionId:q.id,answer:'Attempt to grade early',consent:true})).status,409);
  assert.equal((await request(`/api/sessions/${exam.id}/short-answer/grade`,{questionId:q.id,consent:true})).status,409);assert.equal((await request(`/api/short-answers/answers/${draft.attempt.id}/grade`,{consent:true})).status,409);assert.equal(googleCalls,1);
  const examDone=(await ok(`/api/sessions/${exam.id}/complete`,{answers:{},batchSize:6})).session;assert.equal(examDone.quizScore.pendingGradingCount,1);const examGrade=await ok(`/api/sessions/${exam.id}/short-answer/grade`,{questionId:q.id,consent:true});assert.equal(examGrade.attempt.result.score,2);assert.equal(examGrade.session.quizScore.pendingGradingCount,0);assert.equal(googleCalls,2);
  const original=(await ok(`/api/sessions/${start.id}?batchSize=6&offset=6`)).session.questions[0];assert.equal(original.shortAnswerAttempt.answer,'Support and protection','A different quiz must not replace historical answers.');
  const bookmarks=await ok('/api/bookmarks?view=saved');assert.ok(bookmarks.bookmarks.some((b:any)=>b.questionId===q.id&&b.shortAnswerId));
  const { rows: [tournament] } = await pool.query<{ id: number }>(`
    INSERT INTO gamification.tournaments (title,starts_at,ends_at)
    VALUES ('Short answer tournament test',now()-interval '1 minute',now()+interval '1 minute') RETURNING id
  `);
  tournamentId = tournament.id;
  const joinRoute = `/api/tournaments/${tournamentId}/join`;
  const boardRoute = `/api/tournaments?id=${tournamentId}`;
  const rewards = await import('../db/study-rewards.ts');
  if (tournamentsEnabled) {
    await ok(joinRoute, { nickname: 'Written Atlas' });
  } else {
    assert.equal((await request(joinRoute, { nickname: 'Written Atlas' })).status, 404);
    assert.equal((await request(boardRoute)).status, 404);
    await rewards.joinTournament(uid, tournamentId, 'Written Atlas');
  }
  const readBoard = () => tournamentsEnabled ? ok(boardRoute) : rewards.getTournamentBoard(uid, tournamentId);
  const written = (await ok('/api/sessions',{mode:'custom',lectureIds:[lecture.id]})).session;
  const writtenRoute = `/api/sessions/${written.id}/short-answer`;
  assert.equal((await request(`${writtenRoute}/grade`,{questionId:q.id,answer:'A new partial response'})).status,400);
  let providerStarted!:()=>void,releaseProvider!:()=>void;
  const providerReady=new Promise<void>(resolve=>{providerStarted=resolve;});
  const providerGate=new Promise<void>(resolve=>{releaseProvider=resolve;});
  holdProvider=async()=>{providerStarted();await providerGate;};
  unavailableOnce=true;
  const previousProviderCalls=googleCalls;
  const pending=ok(`${writtenRoute}/grade`,{questionId:q.id,answer:'A new partial response',consent:true});
  try{
   await Promise.race([providerReady,pending.then(()=>{throw new Error('Grade completed before the provider call.');})]);
   const duplicate=await ok(`${writtenRoute}/grade`,{questionId:q.id,consent:true});
   assert.equal(duplicate.attempt.status,'grading');
   assert.equal(googleCalls,previousProviderCalls+1,'A concurrent request must reuse the active grading lease.');
  }finally{holdProvider=undefined;releaseProvider();}
  const combined=await pending;
  assert.equal(googleCalls,previousProviderCalls+2,'A 503 must recover within the original grading request.');
  assert.equal(combined.attempt.answer,'A new partial response');
  assert.equal(combined.attempt.result.score,2);
  assert.equal(combined.session.quizScore.pendingGradingCount,0);
  assert.equal((await readBoard()).ownRank.points, 0);
  fullCredit = true;
  await ok(writtenRoute, {questionId:q.id, answer:'A new full response'});
  const beforeGrade = await ok('/api/study-goal');
  await ok(`${writtenRoute}/grade`, {questionId:q.id, consent:true});
  await ok(`${writtenRoute}/grade`, {questionId:q.id, consent:true});
  assert.equal((await readBoard()).ownRank.points, tournamentsEnabled ? 3 : 0);
  assert.equal((await ok('/api/study-goal')).answered, beforeGrade.answered);
  // Standalone answers saved before this integration stay reachable through their new quiz entry.
  const legacyLecture=(await pool.query("INSERT INTO lectures(subject_id,title,description) VALUES($1,'Legacy written answers','Fixture') RETURNING id",[subject.id])).rows[0];
  const service=await import('./short-answer-service.ts'),{shortAnswerTemplate}=await import('./short-answer-model.ts');const legacyJson=JSON.parse(shortAnswerTemplate);legacyJson.questions[0].status='published';await service.importShortAnswers(legacyLecture.id,JSON.stringify(legacyJson),true,true);
  const oldQuestion=(await pool.query('SELECT id FROM short_answer_questions WHERE lecture_id=$1',[legacyLecture.id])).rows[0];await service.saveShortAnswer(uid,oldQuestion.id,'An older saved response');
  const legacyQuiz=(await ok('/api/sessions',{mode:'study',lectureIds:[legacyLecture.id],batchSize:6})).session;assert.equal(legacyQuiz.questions[0].shortAnswerAttempt.answer,'An older saved response');
  await repo.resetLectureProgress(uid,legacyLecture.id);const resetQuiz=(await ok('/api/sessions',{mode:'study',lectureIds:[legacyLecture.id],batchSize:6})).session;assert.equal(resetQuiz.questions[0].hasSavedAnswer,false,'Reset must not resurrect legacy saved responses.');assert.equal((await pool.query('SELECT answer FROM short_answer_attempts WHERE user_uid=$1 AND question_id=$2',[uid,oldQuestion.id])).rows[0].answer,'An older saved response','Reset keeps the historical written response.');
  const clearQuestion=resetQuiz.questions[0];await ok(`/api/sessions/${resetQuiz.id}/short-answer`,{questionId:clearQuestion.id,answer:'A response to clear'});await ok(`/api/sessions/${resetQuiz.id}/short-answer`,{questionId:clearQuestion.id,answer:''});await ok(`/api/sessions/${resetQuiz.id}/complete`,{answers:{},batchSize:6});const afterClear=(await ok('/api/sessions',{mode:'study',lectureIds:[legacyLecture.id],batchSize:6})).session;assert.equal(afterClear.questions[0].hasSavedAnswer,false,'Clearing text must not submit the previously saved response.');assert.ok((await pool.query('SELECT 1 FROM short_answer_attempts WHERE user_uid=$1 AND answer=$2',[uid,'A response to clear'])).rowCount);
  const {createEncryptedBackup,testRestoreBackup}=await import('./backup-service.ts');assert.equal((await testRestoreBackup((await createEncryptedBackup()).envelope)).status,'verified');
 }finally{
  globalThis.fetch=realFetch;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  if (tournamentId) await pool.query('DELETE FROM gamification.tournaments WHERE id=$1', [tournamentId]);
  await pool.query('DELETE FROM exam_sessions WHERE user_uid=ANY($1::text[])',[[uid,other]]);await pool.query('DELETE FROM import_batches WHERE admin_uid=$1',[admin]);await pool.query('DELETE FROM admin_audit_logs WHERE admin_uid=$1',[admin]);await pool.query('DELETE FROM subjects WHERE id=$1',[subject.id]);await pool.query('DELETE FROM users WHERE uid=ANY($1::text[])',[[uid,other,admin]]);repo.invalidateCatalogCache();
 }
});
