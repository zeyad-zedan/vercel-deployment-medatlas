import 'dotenv/config';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import { clearResetSessionStorage } from './session-progress.ts';
import { ExamCompletionGate } from './exam-completion.ts';
import { BoundedDocumentQueue } from './document-renderer.ts';

process.env.NODE_ENV = 'test';
const enabled = /^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '');
const { db, pool, users, questions, lectures, examSessions, questionAttempts, bookmarks } = await import('../db/index.ts');
const repo = await import('../db/repository.ts');
after(async () => { await pool.end(); });

test('reset cleanup preserves all drafts, cursors and active markers outside the reset sessions', () => {
  const previous = globalThis.localStorage;
  const data = new Map<string, string>();
  for (const id of [101, 202]) for (const prefix of ['medatlas_session_curr_idx_', 'medatlas_session_question_', 'medatlas_session_draft_answers_']) data.set(prefix + id, `saved-${id}`);
  data.set('medatlas_active_session_id', '202');
  globalThis.localStorage = { getItem: key => data.get(key) ?? null, removeItem: key => { data.delete(key); } } as Storage;
  try {
    clearResetSessionStorage([101]);
    assert.equal(data.get('medatlas_session_draft_answers_202'), 'saved-202');
    assert.equal(data.get('medatlas_session_question_202'), 'saved-202');
    assert.equal(data.get('medatlas_active_session_id'), '202');
    assert.equal(data.has('medatlas_session_draft_answers_101'), false);
    clearResetSessionStorage([]);
    assert.equal(data.get('medatlas_session_draft_answers_202'), 'saved-202');
    clearResetSessionStorage([202]);
    assert.equal(data.has('medatlas_active_session_id'), false);
  } finally { globalThis.localStorage = previous; }
});

test('expiry ticks submit once during slow requests, after success, and after failures until manual retry', async () => {
  const gate = new ExamCompletionGate();
  let calls = 0;
  let release!: () => void;
  const first = gate.run(1, () => { calls++; return new Promise<void>(resolve => { release = resolve; }); })!;
  for (let i = 0; i < 100; i++) assert.equal(gate.run(1, async () => { calls++; }), undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release(); await first;
  assert.equal(gate.run(1, async () => { calls++; }), undefined);
  await assert.rejects(gate.run(2, async () => { calls++; throw new Error('Offline'); })!, /Offline/);
  assert.equal(gate.run(2, async () => { calls++; }), undefined);
  await gate.run(2, async () => { calls++; }, true);
  assert.equal(calls, 3);
});

test('failed resets retain browser drafts and successful resets only clear acknowledged session IDs', async () => {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  const data = new Map([['medatlas_session_draft_answers_101', 'target'], ['medatlas_session_draft_answers_202', 'other']]);
  globalThis.localStorage = { getItem: key => data.get(key) ?? null, removeItem: key => { data.delete(key); } } as Storage;
  const { api } = await import('./api.ts');
  try {
    globalThis.fetch = async () => Response.json({ error: 'Temporarily unavailable' }, { status: 503 });
    await assert.rejects(api.resetLectureProgress(5), /Temporarily unavailable/);
    assert.equal(data.get('medatlas_session_draft_answers_101'), 'target');
    assert.equal(data.get('medatlas_session_draft_answers_202'), 'other');
    globalThis.fetch = async () => Response.json({ success: true, resetSessionIds: [101] });
    await api.resetLectureProgress(5);
    assert.equal(data.has('medatlas_session_draft_answers_101'), false);
    assert.equal(data.get('medatlas_session_draft_answers_202'), 'other');
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

test('PDF bursts queue at the same concurrency limit and recover after bounded wait expiry', async () => {
  const queue = new BoundedDocumentQueue(2, 2, 1000);
  let active = 0, peak = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const job = () => queue.run(async () => { active++; peak = Math.max(peak, active); await gate; active--; return 'page'; });
  const jobs = [job(), job(), job(), job()];
  await assert.rejects(job(), { status: 429 });
  assert.equal(peak, 2);
  release();
  assert.deepEqual(await Promise.all(jobs), ['page', 'page', 'page', 'page']);
  assert.equal(peak, 2);
  const expiring = new BoundedDocumentQueue(1, 1, 20);
  let finish!: () => void;
  const busy = expiring.run(() => new Promise<void>(resolve => { finish = resolve; }));
  await assert.rejects(expiring.run(async () => assert.fail('expired work must not execute')), { status: 429 });
  finish(); await busy;
  assert.equal(await expiring.run(async () => 'recovered'), 'recovered');
});

test('paged history preserves every answer and targeted reset preserves other lectures, bookmarks and users', { skip: !enabled }, async () => {
  await repo.ensureSeededDatabase();
  const marker = crypto.randomUUID();
  const uid = `priority-${marker}`, foreignUid = `priority-other-${marker}`;
  const lectureIds: number[] = [];
  try {
    const baseQuestions = await db.select().from(questions).where(eq(questions.status, 'published')).limit(20);
    const base = baseQuestions[0]; assert.ok(base);
    const other = baseQuestions.find(question => question.subjectId !== base.subjectId) || base;
    await db.insert(users).values([{ uid, email: `${uid}@example.invalid`, displayName: 'Priority test', profileCompleted: true },
      { uid: foreignUid, email: `${foreignUid}@example.invalid`, displayName: 'Other student', profileCompleted: true }]);
    const questionIds: number[] = [];
    for (let index = 0; index < 2; index++) {
      const source = index ? other : base;
      const [lecture] = await db.insert(lectures).values({ subjectId: source.subjectId, title: `Priority ${marker} ${index}`, description: 'Disposable checks' }).returning();
      lectureIds.push(lecture.id);
      const inserted = await db.insert(questions).values(Array.from({ length: 200 }, (_, n) => ({ ...source, id: undefined, questionBankId: null,shortAnswerId:null,shortAnswerMaxMarks:1,
        lectureId: lecture.id, questionText: `Priority ${marker} ${index} ${n}`, contentHash: `${marker}-${index}-${n}` }))).returning({ id: questions.id });
      questionIds.push(...inserted.map(question => question.id));
    }
    const [mixed] = await db.insert(examSessions).values({ userUid: uid, title: 'Mixed practice', mode: 'custom', totalQuestions: 400, questionOrderJson: '[]' }).returning();
    const [lectureStudy] = await db.insert(examSessions).values({ userUid: uid, title: 'Target lecture study', mode: 'study', lectureId: lectureIds[0], totalQuestions: 200, questionOrderJson: '[]' }).returning();
    const [foreign] = await db.insert(examSessions).values({ userUid: foreignUid, title: 'Other student progress', mode: 'study', lectureId: lectureIds[0], totalQuestions: 1, questionOrderJson: '[]' }).returning();
    await db.insert(questionAttempts).values(questionIds.map((id, index) => ({ userUid: uid, sessionId: mixed.id, questionId: id,
      subjectId: index < 200 ? base.subjectId : other.subjectId, lectureId: lectureIds[index < 200 ? 0 : 1], selectedOption: index % 2 ? 'B' : 'A',
      isCorrect: index % 2 === 0, correctOptionSnapshot: 'A', questionSnapshotJson: '{}', answeredAt: new Date(1700000000000 + index * 1000) })));
    await db.insert(questionAttempts).values({ userUid: foreignUid, sessionId: foreign.id, questionId: questionIds[0],
      lectureId: lectureIds[0], subjectId: base.subjectId, selectedOption: 'A', isCorrect: true, correctOptionSnapshot: 'A', questionSnapshotJson: '{}' });
    await repo.toggleBookmarkForStudent(uid, questionIds[0], undefined, true);
    await repo.toggleBookmarkForStudent(uid, questionIds[200], undefined, true);
    repo.invalidateCatalogCache();
    await repo.getPublishedCatalog();
    const before = await db.select().from(questionAttempts).where(eq(questionAttempts.userUid, uid));
    const legacyRows = (await pool.query('SELECT * FROM questions WHERE id=ANY($1)', [questionIds])).rows;
    const legacyPayloadBytes = Buffer.byteLength(JSON.stringify(legacyRows));
    const originalQuery = pool.query.bind(pool);
    let pagedResultBytes = 0;
    pool.query = ((...args: any[]) => (originalQuery as any)(...args).then((result: any) => {
      pagedResultBytes += Buffer.byteLength(JSON.stringify(result.rows)); return result;
    })) as typeof pool.query;
    let first: Awaited<ReturnType<typeof repo.getStudentBookmarksAndReview>>;
    try { first = await repo.getStudentBookmarksAndReview(uid, false, { page: 1, pageSize: 25, reviewOnly: true }); }
    finally { pool.query = originalQuery; }
    assert.equal(first.answeredCount, 400);
    assert.equal(first.bookmarkCount, 2);
    assert.equal(first.answeredQuestions.length, 25);
    assert.deepEqual(first.bookmarks, []);
    assert.equal(first.reviewPagination?.hasMore, true);
    assert.ok(pagedResultBytes < legacyPayloadBytes / 5, 'one page must return substantially less database data than the old unbounded question read');
    const seen = new Set<number>();
    for (let page = 1; page <= 16; page++) {
      const result = page === 1 ? first : await repo.getStudentBookmarksAndReview(uid, false, { page, pageSize: 25, reviewOnly: true });
      for (const question of result.answeredQuestions) { assert.equal(seen.has(question!.questionId), false); seen.add(question!.questionId); }
      assert.equal(result.reviewPagination?.hasMore, page < 16);
    }
    assert.equal(seen.size, 400);
    const wrong = await repo.getStudentBookmarksAndReview(uid, false, { status: 'incorrect', reviewOnly: true });
    assert.equal(wrong.reviewPagination?.totalCount, 200);
    assert.ok(wrong.answeredQuestions.every(question => question!.status === 'incorrect'));
    const subject = await repo.getStudentBookmarksAndReview(uid, false, { subjectId: other.subjectId, reviewOnly: true });
    assert.ok(subject.answeredQuestions.every(question => question!.subjectId === other.subjectId));
    assert.deepEqual(await db.select().from(questionAttempts).where(eq(questionAttempts.userUid, uid)), before);
    const retained = before.filter(attempt => attempt.lectureId === lectureIds[1]);
    const savedBookmarks = await db.select().from(bookmarks).where(eq(bookmarks.userUid, uid));
    const reset = await repo.resetLectureProgress(uid, lectureIds[0]);
    assert.deepEqual(reset.resetSessionIds, [lectureStudy.id]);
    assert.deepEqual(await db.select().from(questionAttempts).where(eq(questionAttempts.userUid, uid)), retained);
    assert.deepEqual(await db.select().from(bookmarks).where(eq(bookmarks.userUid, uid)), savedBookmarks);
    assert.equal((await db.select().from(questionAttempts).where(eq(questionAttempts.userUid, foreignUid))).length, 1);
    assert.equal((await db.select().from(examSessions).where(eq(examSessions.id, mixed.id))).length, 1);
    if (process.env.MEDATLAS_EGRESS_REPORT_PATH) fs.writeFileSync(process.env.MEDATLAS_EGRESS_REPORT_PATH, JSON.stringify({ questionsInHistory: 400, questionsPerPage: 25,
      legacyQuestionResultBytes: legacyPayloadBytes, pagedDatabaseResultBytes: pagedResultBytes,
      resultPayloadReductionPercent: Math.round((1 - pagedResultBytes / legacyPayloadBytes) * 100), progressPreserved: true }, null, 2));
  } finally {
    await db.delete(bookmarks).where(inArray(bookmarks.userUid, [uid, foreignUid]));
    await db.delete(examSessions).where(inArray(examSessions.userUid, [uid, foreignUid]));
    if (lectureIds.length) { await db.delete(questions).where(inArray(questions.lectureId, lectureIds)); await db.delete(lectures).where(inArray(lectures.id, lectureIds)); }
    await db.delete(users).where(inArray(users.uid, [uid, foreignUid]));
    repo.invalidateCatalogCache();
  }
});
