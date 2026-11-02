import 'dotenv/config';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { eq } from 'drizzle-orm';

process.env.NODE_ENV = 'test';
const { db, pool, questions, examSessions, questionAttempts, lectureFiles } = await import('../db/index.ts');
const { saveSessionQuestionAnswer, getStudentDashboardAnalytics } = await import('../db/repository.ts');
after(async () => { await pool.end(); });

test('concurrent answer saves preserve both answers and locked study answers', async () => {
  const qs = await db.select({ id: questions.id, correctAnswer: questions.correctAnswer }).from(questions).limit(2);
  assert.equal(qs.length, 2);
  const uid = `egress-regression-${Date.now()}`;
  const order = qs.map((q) => ({ questionId: q.id, permutation: { A: 'A', B: 'B', C: 'C', D: 'D' },
    selectedDisplayed: null, selectedCanonical: null, submitted: false, correctAnswer: q.correctAnswer }));
  const [session] = await db.insert(examSessions).values({ userUid: uid, title: 'Temporary egress regression',
    mode: 'study', totalQuestions: 2, unansweredCount: 2, questionOrderJson: JSON.stringify(order) }).returning();
  try {
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
    await db.delete(questionAttempts).where(eq(questionAttempts.sessionId, session.id));
    await db.delete(examSessions).where(eq(examSessions.id, session.id));
  }
});

test('PDF route fails closed without Telegram and serves a real Telegram PDF when configured', async () => {
  const { app } = await import('../../server.ts');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.TELEGRAM_BOT_TOKEN = '';
    const disabled = await fetch(`${origin}/lectures/never-use-database.pdf`);
    assert.equal(disabled.status, 503);
    process.env.TELEGRAM_BOT_TOKEN = token;
    const missing = await fetch(`${origin}/lectures/nonexistent-egress-test.pdf`);
    assert.equal(missing.status, 404);
    const [file] = await db.select({ url: lectureFiles.url }).from(lectureFiles).limit(1);
    assert.ok(file);
    const response = await fetch(origin + file.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-medatlas-source'), 'telegram');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  } finally {
    process.env.TELEGRAM_BOT_TOKEN = token;
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
