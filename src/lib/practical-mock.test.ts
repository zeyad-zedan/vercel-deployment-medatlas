import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

const local = /^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '');
process.env.NODE_ENV = 'test';
process.env.AUTH_SESSION_SECRET = 'medatlas-practical-mock-isolated-test-secret';
process.env.GEMINI_GRADING_POOL = JSON.stringify([{ key: 'AIza' + 'P'.repeat(35), project: 'mock-exam-test', rpm: 10000 }]);
const cronSecret = 'isolated-practical-cron-test-secret';
process.env.PRACTICAL_GRADING_CRON_SECRET = cronSecret;
const { pool } = await import('../db/index.ts');
after(() => pool.end());

test('timed practical exams keep stations private, save answers and release one batch of results', { skip: !local }, async () => {
  const { app } = await import('../../server.ts');
  const { savePracticalMockAnswer } = await import('../db/practical-mock.ts');
  const { createServerSessionToken } = await import('../middleware/auth.ts');
  const { imageForClient } = await import('./telegram-question-images.ts');
  const id = randomUUID();
  const owner = `practical-mock-${id}`;
  const admin = `${owner}-admin`;
  const other = `${owner}-other`;
  const ids = [owner, admin, other];
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const realFetch = globalThis.fetch;
  let gradingCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith('https://generativelanguage.googleapis.com/')) return realFetch(input, init);
    gradingCalls++;
    const request = JSON.parse(String(init?.body));
    const { stations } = JSON.parse(request.contents[0].parts[0].text);
    assert.deepEqual(stations.map((station: any) => station.student_answer),
      gradingCalls === 1 ? ['First answer', 'Second answer'] : ['Skipped early']);
    for (const station of stations) assert.deepEqual(Object.keys(station).sort(), ['index', 'model_answer', 'question', 'rubric', 'student_answer']);
    const grades = stations.map(({index, rubric}: any) => ({ index, feedback: 'Good.', points: rubric.map((point: any) => ({ id: point.id, awarded: point.marks, feedback: 'Correct.' })) }));
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ grades }) }] } }] });
  };
  try {
    await pool.query(`INSERT INTO public.users(uid,email,display_name,role,profile_completed,email_verified)
      VALUES ($1,$1||'@example.invalid','Test student','student',true,true),
             ($2,$2||'@example.invalid','Test author','admin',true,true),
             ($3,$3||'@example.invalid','Other student','student',true,true)`, ids);
    const tokens = new Map(ids.map(uid => [uid, createServerSessionToken({ uid, email: `${uid}@example.invalid`, emailVerified: true })]));
    async function call(path = '', { uid = owner, method = 'GET', body, status = 200 }: { uid?: string; method?: string; body?: unknown; status?: number } = {}) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/practical-mocks${path}`, {
        method, headers: { Authorization: `Bearer ${tokens.get(uid)}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      assert.equal(response.status, status, `${method} ${path} ${JSON.stringify(data)}`);
      return data;
    }
    async function runGrader() {
      const url = `http://127.0.0.1:${address.port}/api/cron/practical-mock-grading`;
      assert.equal((await fetch(url)).status, 401);
      const verify = (timestamp: string, secret = cronSecret) => fetch(url, { headers: {
        'X-MedAtlas-Grading-Timestamp': timestamp,
        'X-MedAtlas-Grading-Signature': createHmac('sha256', secret).update(timestamp).digest('hex'),
      } });
      assert.equal((await verify(String(Math.floor(Date.now() / 1000) - 180))).status, 401);
      const timestamp = String(Math.floor(Date.now() / 1000));
      assert.equal((await verify(timestamp, 'wrong-secret')).status, 401);
      const response = await verify(timestamp);
      assert.equal(response.status, 200, await response.text());
    }
    const image = imageForClient({ id: 'a'.repeat(64), alt: 'Fixture image', telegramFileId: 'private-file-id', mimeType: 'image/png', fileSize: 123 });
    const exam = { id, title: 'Practical fixture', stations: ['First', 'Second'].map(label => ({ image,
      question: `${label} question`, modelAnswer: `${label} model`, rubric: [{ description: 'Named the structure', marks: 2 }] })) };
    await call('', { method: 'POST', body: exam, status: 403 });
    await call('', { uid: admin, method: 'POST', body: exam, status: 201 });
    await call('', { uid: admin, method: 'POST', body: exam, status: 201 });
    const cards = await call();
    assert.equal(cards.filter((card: any) => card.id === id).length, 1);
    assert.equal(cards.find((card: any) => card.id === id).status, 'ready');
    const start = await call(`/${id}/start`, { method: 'POST' });
    assert.equal(start.stationIndex, 0);
    assert.ok(start.remainingMs > 110_000 && start.remainingMs <= 120_000);
    assert.equal(start.station.question, 'First question');
    assert.ok(start.station.images[0].source.startsWith('/api/question-images/'));
    assert.doesNotMatch(JSON.stringify(start), /Second question|First model|private-file-id|rubric/);
    await call(`/${id}`, { uid: other, status: 404 });
    await call(`/${id}/grade`, { method: 'POST', status: 409 });
    await call(`/${id}/answer`, { method: 'PUT', body: { stationIndex: 1, answer: 'Too early', revision: 0 }, status: 409 });
    await call(`/${id}/answer`, { method: 'PUT', body: { stationIndex: 0, answer: 'First answer', revision: 0 } });
    const replay = await call(`/${id}/answer`, { method: 'PUT', body: { stationIndex: 0, answer: 'First answer', revision: 0 } });
    assert.equal(replay.revision, 1, 'A save with a lost response returns the committed revision');
    await call(`/${id}/answer`, { method: 'PUT', body: { stationIndex: 0, answer: 'Stale edit', revision: 0 }, status: 409 });
    assert.equal((await call(`/${id}`)).answer, 'First answer');

    await pool.query(`UPDATE practical_mock.attempts SET started_at=clock_timestamp()-interval '121 seconds' WHERE exam_id=$1 AND user_uid=$2`, [id, owner]);
    const next = await call(`/${id}/start`, { method: 'POST' });
    assert.equal(next.stationIndex, 1, 'Starting twice must not restart the timer');
    await call(`/${id}/answer`, { method: 'PUT', body: { stationIndex: 0, answer: 'Too late', revision: 1 }, status: 409 });
    const delayed = await savePracticalMockAnswer(owner, id,
      { stationIndex: 0, answer: 'First answer', revision: 1 }, Date.now() - 2_000);
    assert.equal(delayed.revision, 2, 'A save received before closing can finish processing shortly afterward');
    await call(`/${id}/answer`, { method: 'PUT', body: { stationIndex: 1, answer: 'Second answer', revision: 0 } });
    await pool.query(`UPDATE practical_mock.attempts
      SET started_at=clock_timestamp()-interval '246 seconds', grade_available_at=clock_timestamp()
      WHERE exam_id=$1 AND user_uid=$2`, [id, owner]);
    assert.equal((await call(`/${id}`)).status, 'grading');
    assert.equal(gradingCalls, 0);
    await runGrader();
    const result = await call(`/${id}`);
    assert.equal(result.status, 'graded');
    assert.deepEqual(result.stations.map((station: any) => station.grade.score), [2, 2]);
    assert.equal(result.stations[0].modelAnswer, 'First model');
    assert.deepEqual((await call(`/${id}/grade`, { method: 'POST' })).stations.map((station: any) => station.grade.score), [2, 2]);
    assert.equal(gradingCalls, 1);

    const skippedStart = await call(`/${id}/start`, { uid: other, method: 'POST' });
    assert.equal(skippedStart.stationIndex, 0);
    await call(`/${id}/skip`, { uid: other, method: 'POST', body: { stationIndex: 1 }, status: 409 });
    await call(`/${id}/answer`, { uid: other, method: 'PUT', body: { stationIndex: 0, answer: 'Skipped early', revision: 0 } });
    const afterSkip = await call(`/${id}/skip`, { uid: other, method: 'POST', body: { stationIndex: 0 } });
    assert.equal(afterSkip.stationIndex, 1);
    assert.ok(afterSkip.remainingMs > 110_000 && afterSkip.remainingMs <= 120_000);
    await call(`/${id}/answer`, { uid: other, method: 'PUT', body: { stationIndex: 0, answer: 'Too late', revision: 1 }, status: 409 });
    await call(`/${id}/skip`, { uid: other, method: 'POST', body: { stationIndex: 0 }, status: 409 });
    const finishedBySkip = await call(`/${id}/skip`, { uid: other, method: 'POST', body: { stationIndex: 1 } });
    assert.equal(finishedBySkip.status, 'grading');
    await call(`/${id}/skip`, { uid: other, method: 'POST', body: { stationIndex: 1 }, status: 409 });
    await pool.query(`UPDATE practical_mock.attempts
      SET started_at=started_at-interval '6 seconds', grade_available_at=clock_timestamp()
      WHERE exam_id=$1 AND user_uid=$2`, [id, other]);
    await runGrader();
    const skippedGraded = await call(`/${id}`, { uid: other });
    assert.equal(skippedGraded.status, 'graded');
    assert.equal(skippedGraded.stations[0].answer, 'Skipped early');
    assert.equal(skippedGraded.stations[1].answer, '');

    const { createEncryptedBackup, testRestoreBackup } = await import('./backup-service.ts');
    const restored = await testRestoreBackup((await createEncryptedBackup()).envelope);
    assert.equal(restored.status, 'verified', restored.error ?? restored.reason);
    assert.ok(restored.tableCounts.practicalMockExams >= 1 && restored.tableCounts.practicalMockAttempts >= 1);
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.query('DELETE FROM public.users WHERE uid=ANY($1)', [ids]);
    await pool.query('DELETE FROM practical_mock.exams WHERE id=$1', [id]);
  }
});
test('retains completed batches and resumes an expired lease without regrading saved stations', { skip: !local }, async () => {
  const {runPracticalMockGrading,readPracticalMock}=await import('../db/practical-mock.ts');
  const {parseShortAnswerBatch,shortAnswerTemplate}=await import('./short-answer-model.ts');
  const id=randomUUID();
  const uid=`mock-resume-${id}`;
  const [question]=parseShortAnswerBatch(shortAnswerTemplate);
  const stations=Array.from({length:6},()=>question);
  const answers=Object.fromEntries(stations.map((_,index)=>[index,{text:`Answer ${index}`,revision:1}]));
  let calls:number[][]=[];
  const original=globalThis.fetch;
  globalThis.fetch=async (input,init)=>{
    if(!String(input).startsWith('https://generativelanguage.googleapis.com/'))return original(input,init);
    const request=JSON.parse(String(init?.body));
    const {stations:batch}=JSON.parse(request.contents[0].parts[0].text);
    calls.push(batch.map(({index}:{index:number})=>index));
    if(calls.length===2)return Response.json({candidates:[{finishReason:'MAX_TOKENS'}]});
    const grades=batch.map(({index,rubric}:any)=>({index,feedback:'Marked',points:rubric.map((p:any)=>({id:p.id,awarded:p.marks,feedback:'Correct'}))}));
    await new Promise(resolve=>setTimeout(resolve,12)); // Provider request outlasts configured per-project spacing.
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({grades})}]}}]});
  };
  try {
    await pool.query("INSERT INTO public.users(uid,email,display_name) VALUES($1,$1||'@example.invalid','Fixture')",[uid]);
    await pool.query('INSERT INTO practical_mock.exams(id,title,stations) VALUES($1,$2,$3::jsonb)',[id,'Queue fixture',JSON.stringify(stations)]);
    await pool.query(`INSERT INTO practical_mock.attempts(exam_id,user_uid,started_at,answers,grade_available_at,lease,lease_until)
      VALUES($1,$2,clock_timestamp()-interval '13 minutes',$3::jsonb,clock_timestamp(),$4,clock_timestamp()-interval '1 second')`,
      [id,uid,JSON.stringify(answers),randomUUID()]);
    const [first,second]=await Promise.all([runPracticalMockGrading(),runPracticalMockGrading()]);
    assert.equal(first.processed+second.processed,2);
    assert.deepEqual(calls,[[0,1,2,3,4],[5]]);
    const {rows:[pending]}=await pool.query('SELECT grades,grade_progress FROM practical_mock.attempts WHERE exam_id=$1 AND user_uid=$2',[id,uid]);
    assert.equal(pending.grades,null);
    assert.equal(Object.keys(pending.grade_progress).length,5);
    assert.equal((await readPracticalMock(uid,id)).status,'grading');
    await pool.query("UPDATE practical_mock.attempts SET grade_available_at=clock_timestamp() WHERE exam_id=$1",[id]);
    // Advance the fake credential's cooldown in the isolated test schema.
    await pool.query("DELETE FROM public.gemini_grading_pool_state WHERE model=$1",[process.env.GEMINI_GRADING_MODEL||'gemini-3.5-flash-lite']);
    await runPracticalMockGrading();
    assert.deepEqual(calls,[[0,1,2,3,4],[5],[5]]);
    const result=await readPracticalMock(uid,id);
    assert.equal(result.status,'graded');
    if(result.status==='graded')assert.equal(result.stations.length,6);
  }finally{
    globalThis.fetch=original;
    await pool.query('DELETE FROM public.users WHERE uid=$1',[uid]);
    await pool.query('DELETE FROM practical_mock.exams WHERE id=$1',[id]);
  }
});
