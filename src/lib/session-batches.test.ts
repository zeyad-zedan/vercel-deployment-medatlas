import 'dotenv/config';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import { mergeQuestionBatch, mergeCompletedStudy, questionBatchOffset } from './session-batches.ts';
import { readSessionDrafts, getResumeQuestionIndex } from './session-progress.ts';

process.env.NODE_ENV = 'test';
const enabled = /^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '');
const { db, pool, questions, lectures, examSessions, questionAttempts, bookmarks } = await import('../db/index.ts');
const repo = await import('../db/repository.ts');
after(async () => { await pool.end(); });

test('batch content merges never undo newer local answers/bookmarks or discard other loaded batches', () => {
  assert.equal(questionBatchOffset(5), 0); assert.equal(questionBatchOffset(6), 6);
  const previous = { id: 1, status: 'in_progress', correctCount: 2, questions: [
    { id: 10, index: 0, contentLoaded: true, questionText: 'cached', isBookmarked: true },
    { id: 20, index: 6, contentLoaded: false, selectedDisplayed: 'B', submitted: true, isBookmarked: true },
  ] };
  const merged = mergeQuestionBatch(previous, { id: 1, status: 'in_progress', correctCount: 0, questions: [
    { id: 20, index: 6, contentLoaded: true, questionText: 'new', selectedDisplayed: null, submitted: false, isBookmarked: false },
  ] });
  assert.equal(merged.correctCount, 2);
  assert.equal(merged.questions[0], previous.questions[0]);
  assert.equal(merged.questions[1].selectedDisplayed, 'B');
  assert.equal(merged.questions[1].submitted, true);
  assert.equal(merged.questions[1].isBookmarked, true);
  assert.equal(mergeQuestionBatch(previous, { id: 2 }), previous);
  const completed = mergeCompletedStudy({...previous,mode:'study'},{id:1,mode:'study',status:'completed',questionBatch:{size:6},questions:[{id:10,contentLoaded:false,submitted:true}]});
  assert.equal(completed.questions[0].questionText,'cached');
  assert.equal(completed.questions[0].contentLoaded,true);
  assert.equal(completed.questions[0].isBookmarked,true);
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => key.includes('draft_answers') ? JSON.stringify({version:1, answers:{20:'C'}}) : null } as Storage;
  try {
    assert.deepEqual(readSessionDrafts({...previous, mode:'exam'}), {20:'C'}, 'unloaded question drafts must survive');
    assert.equal(getResumeQuestionIndex({...previous, mode:'study', resumeQuestionId:20, questions: previous.questions.map(q=>({...q,submitted:false,selectedDisplayed:null}))}), 1);
  } finally { globalThis.localStorage = original; }
});

test('six-question database reads preserve progress/bookmarks, paging, review snapshots and exam secrecy', { skip: !enabled }, async () => {
  await repo.ensureSeededDatabase();
  const marker = crypto.randomUUID(), uid = `batch-${marker}`;
  let lectureId: number | undefined;
  let capture: { bytes: number; fullQuestionRows: number; snapshotRows: number } | undefined;
  const patched = new Map<any, any>();
  const record = (result: any) => {
    if (!capture || !result?.rows) return;
    capture.bytes += Buffer.byteLength(JSON.stringify(result.rows));
    if (result.fields?.some((field: any) => field.name === 'question_text')) capture.fullQuestionRows += result.rows.length;
    if (result.fields?.some((field: any) => field.name === 'question_snapshot_json')) capture.snapshotRows += result.rows.length;
  };
  const instrument = (client: any) => {
    if (patched.has(client)) return;
    const original = client.query;
    patched.set(client, original);
    client.query = function (...args: any[]) {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        args[args.length - 1] = (err: any, result: any) => { record(result); callback(err, result); };
        return original.apply(this, args);
      }
      return original.apply(this, args).then((result: any) => { record(result); return result; });
    };
  };
  pool.on('acquire', instrument);
  const measured = async (action: () => Promise<any>) => {
    capture = { bytes: 0, fullQuestionRows: 0, snapshotRows: 0 };
    try { const value = await action(); return { value, ...capture }; } finally { capture = undefined; }
  };
  try {
    const [base] = await db.select().from(questions).where(eq(questions.status, 'published')).limit(1);
    const [lecture] = await db.insert(lectures).values({ subjectId: base.subjectId, title: `Batches ${marker}`, description: 'Disposable batching verification' }).returning();
    lectureId = lecture.id;
    const inserted = await db.insert(questions).values(Array.from({ length: 60 }, (_, index) => ({ ...base, id: undefined,
      questionBankId: null, lectureId: lecture.id, questionText: `Batch ${index + 1}: ${base.questionText}`, explanation: base.explanation,
      contentHash: `${marker}-${index}` }))).returning({id:questions.id});
    repo.invalidateCatalogCache();
    const started = await measured(() => repo.createPracticeOrExamSession(uid, {mode:'study',lectureIds:[lectureId!],batched:true}));
    const session = started.value.session;
    assert.equal(started.fullQuestionRows, 6, 'starting must select only six full question rows from Postgres');
    assert.equal(session.questions.length, 60);
    assert.equal(session.questions.filter((q: any)=>q.contentLoaded).length, 6);
    assert.equal(session.questions[6].questionText, undefined);
    assert.equal(repo.getCachedSessionQuestions(session.id)?.length, 6);
    repo.evictCachedSessionQuestions(session.id);
    const before = await measured(()=>repo.getExamSessionForStudent(uid,session.id));
    repo.evictCachedSessionQuestions(session.id);
    const after = await measured(()=>repo.getExamSessionForStudent(uid,session.id,undefined,{batched:true}));
    assert.equal(before.fullQuestionRows,60); assert.equal(after.fullQuestionRows,6);
    assert.ok(after.bytes < before.bytes / 3, 'database result bytes, not just browser bytes, must fall');
    const q = session.questions[0];
    await repo.toggleBookmarkForStudent(uid,q.id,undefined,true);
    await Promise.all(session.questions.slice(0,2).map((item: any)=>repo.saveSessionQuestionAnswer(uid,session.id,item.id,item.correctDisplayedOption,true,0,true)));
    const savedAttempts = await db.select().from(questionAttempts).where(eq(questionAttempts.userUid,uid));
    const savedBookmarks = await db.select().from(bookmarks).where(eq(bookmarks.userUid,uid));
    const page = await measured(()=>repo.getExamSessionForStudent(uid,session.id,undefined,{batched:true,batchOnly:true,offset:6}));
    assert.equal(page.fullQuestionRows,6); assert.equal(page.value.questions.length,6);
    assert.deepEqual(page.value.questions.map((q:any)=>q.index),[6,7,8,9,10,11]);
    const repeat = await measured(()=>repo.getExamSessionForStudent(uid,session.id,undefined,{batched:true,batchOnly:true,offset:6}));
    assert.equal(repeat.fullQuestionRows,0,'loaded content is reused from the server cache');
    const ids = new Set<number>();
    for(let offset=0;offset<60;offset+=6) {
      const part = await repo.getExamSessionForStudent(uid,session.id,undefined,{batched:true,batchOnly:true,offset});
      for(const item of part.questions) {assert.ok(item.contentLoaded); assert.ok(!ids.has(item.id));ids.add(item.id);}
    }
    assert.equal(ids.size,60);
    assert.deepEqual(await db.select().from(questionAttempts).where(eq(questionAttempts.userUid,uid)),savedAttempts);
    assert.deepEqual(await db.select().from(bookmarks).where(eq(bookmarks.userUid,uid)),savedBookmarks);
    const resumed = (await repo.createPracticeOrExamSession(uid,{mode:'study',lectureIds:[lectureId],batched:true})).session;
    assert.equal(resumed.id,session.id); assert.equal(resumed.questions[0].isBookmarked,true); assert.equal(getResumeQuestionIndex(resumed),2);
    await assert.rejects(repo.getExamSessionForStudent('another-student',session.id,undefined,{batched:true,batchOnly:true,offset:6}));
    for(const offset of [-6,1,60,NaN]) await assert.rejects(repo.getExamSessionForStudent(uid,session.id,undefined,{batched:true,batchOnly:true,offset}));
    repo.evictCachedSessionQuestions(session.id);
    const completed = await measured(()=>repo.completeExamSession(uid,session.id,undefined,undefined,{batched:true}));
    assert.equal(completed.value.correctCount,2); assert.equal(completed.value.unansweredCount,58);
    assert.ok(completed.fullQuestionRows <= 6,'early submission must not fetch all untouched questions');
    assert.equal(completed.snapshotRows,2,'review reads only snapshots in its six-question batch');
    assert.equal((await db.select().from(bookmarks).where(eq(bookmarks.userUid,uid))).length,1);
    const snapBefore = (await db.select().from(questionAttempts).where(eq(questionAttempts.userUid,uid))).map(a=>a.questionSnapshotJson);
    await db.update(questions).set({questionText:'Edited after completion'}).where(eq(questions.id,q.id));
    repo.evictCachedSessionQuestions(session.id);
    const review=await repo.getExamSessionForStudent(uid,session.id,undefined,{batched:true});
    assert.equal(review.questions[0].questionText,q.questionText,'completed review must use historical snapshots');
    assert.deepEqual((await db.select().from(questionAttempts).where(eq(questionAttempts.userUid,uid))).map(a=>a.questionSnapshotJson),snapBefore);
    const [legacy] = await db.select().from(examSessions).where(eq(examSessions.id,session.id));
    await db.update(examSessions).set({questionOrderJson:JSON.stringify(JSON.parse(legacy.questionOrderJson).map(({correctAnswer,...item}:any)=>item))}).where(eq(examSessions.id,session.id));
    const historicalKey=q.correctCanonicalOption;
    await db.update(questions).set({correctAnswer:historicalKey==='A'?'B':'A'}).where(eq(questions.id,q.id));
    const oldReview=await repo.getExamSessionForStudent(uid,session.id,undefined,{batched:true,offset:6});
    assert.equal(oldReview.questions[0].contentLoaded,false);
    assert.equal(oldReview.questions[0].correctDisplayedOption,q.correctDisplayedOption,'legacy navigator must prefer the historical key');
    const exam=(await repo.createPracticeOrExamSession(uid,{mode:'exam',lectureIds:[lectureId],requestedCount:13,shuffleQuestions:false,batched:true})).session;
    for(const question of exam.questions) assert.equal(question.correctDisplayedOption,undefined);
    const last=await repo.getExamSessionForStudent(uid,exam.id,undefined,{batched:true,batchOnly:true,offset:12});
    assert.equal(last.questions.length,1); assert.equal(last.questions[0].explanation,undefined); assert.equal(last.questions[0].correctCanonicalOption,undefined);
    const picked=exam.questions[0]; await repo.saveSessionQuestionAnswer(uid,exam.id,picked.id,'A',false,0,true);
    const examCompleted=await repo.completeExamSession(uid,exam.id,{[picked.id]:'A'},0,{batched:true});
    assert.equal(examCompleted.unansweredCount,12);assert.equal(examCompleted.questions.filter((q:any)=>q.contentLoaded).length,6);
    const continued=(await repo.createPracticeOrExamSession(uid,{mode:'study',lectureIds:[lectureId],batched:true})).session;
    for(const id of inserted.slice(2,9).map(q=>q.id))await repo.saveSessionQuestionAnswer(uid,continued.id,id,'A',true,0,true);
    const later=(await repo.createPracticeOrExamSession(uid,{mode:'study',lectureIds:[lectureId],batched:true})).session;
    assert.equal(later.questionBatch.offset,6);
    assert.equal(getResumeQuestionIndex(later),9,'resume must load the six-question window around the next unanswered question');
    assert.equal(later.questions.filter((q:any)=>q.contentLoaded).length,6);
    const historyBefore=await db.select().from(questionAttempts).where(eq(questionAttempts.userUid,uid));
    const bookmarksBefore=await db.select().from(bookmarks).where(eq(bookmarks.userUid,uid));
    const fresh=(await repo.createPracticeOrExamSession(uid,{mode:'study',lectureIds:[lectureId],requestedCount:60,shuffleQuestions:false,avoidRecent:false,batched:true})).session;
    assert.notEqual(fresh.id,later.id);
    assert.equal(fresh.unansweredCount,60);
    assert.equal(fresh.questions.filter((q:any)=>q.contentLoaded).length,6);
    const freshQuestion=fresh.questions[0];
    await repo.saveSessionQuestionAnswer(uid,fresh.id,freshQuestion.id,freshQuestion.correctDisplayedOption,true,0,true);
    const reopened=await repo.getExamSessionForStudent(uid,fresh.id,undefined,{batched:true});
    assert.equal(reopened.id,fresh.id);assert.equal(getResumeQuestionIndex(reopened),1);
    const oldReviewAgain=await repo.getExamSessionForStudent(uid,session.id,undefined,{batched:true,offset:0});
    assert.equal(oldReviewAgain.status,'completed');assert.equal(oldReviewAgain.questions[0].selectedDisplayed,q.correctDisplayedOption);
    assert.deepEqual(await db.select().from(bookmarks).where(eq(bookmarks.userUid,uid)),bookmarksBefore);
    const historyAfter=await db.select().from(questionAttempts).where(eq(questionAttempts.userUid,uid));
    for(const old of historyBefore)assert.deepEqual(historyAfter.find(row=>row.id===old.id),old,'Fresh attempts never rewrite old answers or grades');
    const report={questions:60,batchSize:6,oldDatabaseResultBytes:before.bytes,newDatabaseResultBytes:after.bytes,
      reductionPercent:Math.round((1-after.bytes/before.bytes)*100),oldFullQuestionRows:before.fullQuestionRows,newFullQuestionRows:after.fullQuestionRows,
      startDatabaseResultBytes:started.bytes,nextBatchDatabaseResultBytes:page.bytes,earlySubmitDatabaseResultBytes:completed.bytes,
      earlySubmitFullQuestionRows:completed.fullQuestionRows,progressPreserved:true,bookmarksPreserved:true};
    fs.writeFileSync('D:/MedAtlas-feature-tests/six-question-egress-check.json',JSON.stringify(report,null,2));
  } finally {
    pool.removeListener('acquire',instrument);for(const [client,query] of patched)client.query=query;
    await db.delete(bookmarks).where(eq(bookmarks.userUid,uid));await db.delete(examSessions).where(eq(examSessions.userUid,uid));
    if(lectureId){await db.delete(questions).where(eq(questions.lectureId,lectureId));await db.delete(lectures).where(eq(lectures.id,lectureId));}
    repo.invalidateCatalogCache();
  }
});
