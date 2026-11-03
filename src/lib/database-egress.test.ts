import 'dotenv/config';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { eq } from 'drizzle-orm';

process.env.NODE_ENV = 'test';
const { db, pool, questions, examSessions, questionAttempts, lectureFiles, bookmarks } = await import('../db/index.ts');
const { saveSessionQuestionAnswer, getStudentDashboardAnalytics, toggleBookmarkForStudent, getStudentBookmarksAndReview } = await import('../db/repository.ts');
after(async () => { await pool.end(); });

test('concurrent answer saves preserve both answers and locked study answers', async () => {
  const qs = await db.select({ id: questions.id, correctAnswer: questions.correctAnswer }).from(questions).where(eq(questions.status, 'published')).limit(2);
  assert.equal(qs.length, 2);
  const uid = `egress-regression-${Date.now()}`;
  const order = qs.map((q) => ({ questionId: q.id, permutation: { A: 'A', B: 'B', C: 'C', D: 'D' },
    selectedDisplayed: null, selectedCanonical: null, submitted: false, correctAnswer: q.correctAnswer }));
  const [session] = await db.insert(examSessions).values({ userUid: uid, title: 'Temporary egress regression',
    mode: 'study', totalQuestions: 2, unansweredCount: 2, questionOrderJson: JSON.stringify(order) }).returning();
  try {
    // Saving is independent of selecting an answer or completing this in-progress session.
    const bookmarkSaves = await Promise.all([toggleBookmarkForStudent(uid, qs[0].id, undefined, true), toggleBookmarkForStudent(uid, qs[0].id, undefined, true)]);
    assert.ok(bookmarkSaves.every((result) => result.bookmarked));
    const beforeAnswering = await getStudentBookmarksAndReview(uid);
    assert.equal(beforeAnswering.bookmarks.length, 1);
    assert.equal(beforeAnswering.bookmarks[0]?.questionId, qs[0].id);
    assert.equal(beforeAnswering.answeredQuestions.length, 0);
    assert.equal((await toggleBookmarkForStudent('another-user', qs[0].id, undefined, false)).bookmarked, false);
    const updates = await Promise.all(qs.map((q) => saveSessionQuestionAnswer(uid, session.id, q.id, q.correctAnswer as any, true, undefined, true)));
    assert.ok(updates.every((u) => !('questions' in u)));
    const [saved] = await db.select().from(examSessions).where(eq(examSessions.id, session.id));
    assert.equal(saved.correctCount, 2);
    assert.equal(saved.unansweredCount, 0);
    assert.ok(JSON.parse(saved.questionOrderJson).every((item: any) => item.submitted && item.selectedCanonical));
    const wrong = qs[0].correctAnswer === 'A' ? 'B' : 'A';
    await saveSessionQuestionAnswer(uid, session.id, qs[0].id, wrong, true, undefined, true);
    const [unchanged] = await db.select().from(examSessions).where(eq(examSessions.id, session.id));
    assert.equal(unchanged.correctCount, 2);
    const attempts = await db.select({ id: questionAttempts.id }).from(questionAttempts).where(eq(questionAttempts.sessionId, session.id));
    assert.equal(attempts.length, 2);
    const dashboard = await getStudentDashboardAnalytics(uid);
    assert.equal(dashboard.history.find((s: any) => s.id === session.id)?.answeredCount, 2);
    await assert.rejects(saveSessionQuestionAnswer('another-user', session.id, qs[0].id, 'A', false, undefined, true));
  } finally {
    await db.delete(bookmarks).where(eq(bookmarks.userUid, uid));
    await db.delete(questionAttempts).where(eq(questionAttempts.sessionId, session.id));
    await db.delete(examSessions).where(eq(examSessions.id, session.id));
  }
});

test('saved bookmarks omit review payloads and preserve latest-attempt status and review order', async () => {
  const uid = `review-egress-${Date.now()}`;
  const qs = await db.select({ id: questions.id }).from(questions)
    .where(eq(questions.status, 'published')).limit(2);
  assert.equal(qs.length, 2);
  try {
    const sessions = await db.insert(examSessions).values(['first', 'second'].map(title => ({
      userUid: uid, title, mode: 'study', totalQuestions: 2, questionOrderJson: '[]',
    }))).returning({ id: examSessions.id });
    const attempt = {
      userUid: uid, correctOptionSnapshot: 'A', questionSnapshotJson: '{}', answeredAt: new Date(),
    };
    await db.insert(questionAttempts).values([
      { ...attempt, sessionId: sessions[0].id, questionId: qs[0].id, selectedOption: 'B', isCorrect: false },
      { ...attempt, sessionId: sessions[1].id, questionId: qs[0].id, selectedOption: 'A', isCorrect: true },
      { ...attempt, sessionId: sessions[1].id, questionId: qs[1].id, selectedOption: null, isCorrect: false },
    ]);
    const emptySaved = await getStudentBookmarksAndReview(uid, true);
    assert.equal(emptySaved.answeredCount, 2);
    assert.deepEqual(emptySaved.bookmarks, []);
    await toggleBookmarkForStudent(uid, qs[0].id, undefined, true);
    const saved = await getStudentBookmarksAndReview(uid, true);
    const full = await getStudentBookmarksAndReview(uid);
    assert.deepEqual(saved.bookmarks, full.bookmarks);
    assert.equal(saved.bookmarks[0]?.lastAttemptStatus, 'correct');
    assert.deepEqual(saved.answeredQuestions, []);
    assert.equal(saved.answeredCount, full.answeredQuestions.length);
    assert.deepEqual(full.answeredQuestions.map(q => [q?.questionId, q?.status]), [
      [qs[1].id, 'unanswered'], [qs[0].id, 'correct'],
    ]);
  } finally {
    await db.delete(bookmarks).where(eq(bookmarks.userUid, uid));
    await db.delete(examSessions).where(eq(examSessions.userUid, uid));
  }
});

test('original PDF routes stay blocked, including Range requests and known Telegram files', async () => {
  const { app } = await import('../../server.ts');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const lecturesPage = await fetch(origin + '/lectures/');
    // This API-only test app has no SPA fallback. The document guard must pass the page through.
    assert.notEqual(lecturesPage.status, 410, 'the document guard must allow the Lectures page');
    const [file] = await db.select({ url: lectureFiles.url }).from(lectureFiles).limit(1);
    assert.ok(file);
    for (const route of ['/lectures/never-use-database.pdf', file.url, '/other.pdf']) {
      const response = await fetch(origin + route, {headers:{Range:'bytes=0-1024'}});
      assert.equal(response.status, 410);
      assert.match(response.headers.get('cache-control')!, /no-store/);
      assert.ok(!(await response.text()).startsWith('%PDF-'));
    }
    const catalog = await (await fetch(origin+'/api/catalog')).json();
    assert.ok(!JSON.stringify(catalog).includes('/lectures/'));
    const reference = catalog.lectures.find((lecture: any) => lecture.pdfUrl)?.pdfUrl;
    assert.ok(reference?.startsWith('/api/documents/'));
    const unauthenticated = await fetch(origin + reference);
    assert.equal(unauthenticated.status,401);
    const {getProtectedPdfMetadata} = await import('../db/repository.ts');
    const metadata = await getProtectedPdfMetadata(file.url,'non-admin-security-regression');
    // Metadata remains tiny; source PDF bytes are never selected from PostgreSQL.
    if (metadata) assert.deepEqual(Object.keys(metadata),['telegramFileId','watermarksEnabled']);
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
