import 'dotenv/config';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { isWholeLectureStudy, reconcileLectureStudyItems } from './lecture-study-progress.ts';
import { getResumeQuestionIndex, rememberSessionQuestion } from './session-progress.ts';

process.env.NODE_ENV = 'test';
const enabled = /^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '');
const { db, pool, questions, lectures, examSessions, questionAttempts, bookmarks } = await import('../db/index.ts');
const repo = await import('../db/repository.ts');
after(async () => { await pool.end(); });

test('cumulative study restores canonical answers through shuffled options and excludes filtered practice', () => {
  assert.equal(isWholeLectureStudy({ mode: 'study', lectureIds: [1] }), true);
  for (const changes of [{ onlyMistakes: true }, { requestedCount: 5 }, { difficulties: ['Hard'] }, { tagFilter: 'topic' }, { specialTags: ['book'] }, { mode: 'exam' }, { mode: 'custom' }]) {
    assert.equal(isWholeLectureStudy({ mode: 'study', lectureIds: [1], ...changes }), false);
  }
  const items = reconcileLectureStudyItems([{ questionId: 1, permutation: { A: 'C', B: 'D', C: 'A', D: 'B' }, selectedCanonical: null, selectedDisplayed: null, submitted: false }],
    [{ id: 1, correctAnswer: 'A' }, { id: 2, correctAnswer: 'B' }], [{ questionId: 1, selectedOption: 'A' }], false);
  assert.equal(items[0].selectedDisplayed, 'C');
  assert.equal(items[0].submitted, true);
  assert.equal(items[1].submitted, false);
});

test('lecture resume chooses unanswered questions rather than a previously answered cursor', () => {
  const previous = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } } as Storage;
  try {
    const session = { id: 701, mode: 'study', status: 'in_progress', questions: [{ id: 1, submitted: true }, { id: 2, submitted: false }, { id: 3, submitted: true }, { id: 4, submitted: false }] };
    rememberSessionQuestion(701, 1, 0);
    assert.equal(getResumeQuestionIndex(session), 1);
    rememberSessionQuestion(701, 4, 3);
    assert.equal(getResumeQuestionIndex(session), 3);
    assert.equal(getResumeQuestionIndex({ ...session, resumeQuestionId: 2 }), 1);
    assert.equal(getResumeQuestionIndex({ ...session, status: 'completed' }), 3);
    assert.equal(getResumeQuestionIndex({ ...session, mode: 'exam' }), 3);
  } finally { globalThis.localStorage = previous; }
});

test('22 study + 5 custom answers restore 27/60; custom-only 9/60 resumes without deleting history', { skip: !enabled }, async () => {
  await repo.ensureSeededDatabase();
  const marker = crypto.randomUUID();
  const uid = `resume-${marker}`;
  const fixtureLectures: number[] = [];
  try {
    const [base] = await db.select().from(questions).where(eq(questions.status, 'published')).limit(1);
    assert.ok(base);
    const lectureQuestions: number[][] = [];
    for (let i = 0; i < 2; i++) {
      const [lecture] = await db.insert(lectures).values({ subjectId: base.subjectId, title: `Resume ${marker} ${i}`, description: 'Disposable resume test' }).returning();
      fixtureLectures.push(lecture.id);
      const inserted = await db.insert(questions).values(Array.from({ length: 60 }, (_, index) => ({ ...base, id: undefined,
        lectureId: lecture.id, questionBankId: null, questionText: `Resume test ${marker} ${i} ${index}`, contentHash: `${marker}-${i}-${index}` }))).returning({ id: questions.id });
      lectureQuestions.push(inserted.map(question => question.id));
    }
    repo.invalidateCatalogCache();
    const study = (await repo.createPracticeOrExamSession(uid, { mode: 'study', lectureIds: [fixtureLectures[0]] })).session;
    for (const question of study.questions.slice(0, 22)) await repo.saveSessionQuestionAnswer(uid, study.id, question.id, question.correctDisplayedOption, true, 0, true);
    const [studyBefore] = await db.select().from(examSessions).where(eq(examSessions.id, study.id));
    const [history] = await db.insert(examSessions).values({ ...studyBefore, id: undefined, status: 'completed', title: 'Historical completed study', completedAt: new Date() }).returning();
    const custom = (await repo.createPracticeOrExamSession(uid, { mode: 'custom', lectureIds: [fixtureLectures[0]], shuffleQuestions: false, shuffleOptions: true })).session;
    for (const index of [36, 46, 48, 55, 56]) {
      const question = custom.questions[index];
      const wrong = (['A', 'B', 'C', 'D'] as const).find(option => option !== question.correctDisplayedOption)!;
      await repo.saveSessionQuestionAnswer(uid, custom.id, question.id, wrong, true, 0, true);
    }
    await repo.toggleBookmarkForStudent(uid, study.questions[0].id, undefined, true);
    const before = await db.select().from(questionAttempts).where(eq(questionAttempts.userUid, uid));
    const opened = (await repo.createPracticeOrExamSession(uid, { mode: 'study', lectureIds: [fixtureLectures[0]] })).session;
    assert.equal(opened.id, study.id);
    assert.equal(opened.questions.filter((question: any) => question.submitted).length, 27);
    assert.equal(opened.correctCount, 22);
    assert.equal(opened.incorrectCount, 5);
    assert.equal(opened.unansweredCount, 33);
    // These five custom answers are Q37, Q47, Q49, Q56, Q57. Next is Q23, not Q28.
    assert.equal(getResumeQuestionIndex(opened), 22);
    const dashboard = await repo.getStudentDashboardAnalytics(uid);
    const progress = dashboard.subjectProgress.flatMap((subject: any) => subject.lectures).find((lecture: any) => lecture.lectureId === fixtureLectures[0]);
    assert.equal(progress?.uniqueQuestionsAttempted, 27);
    assert.equal(progress?.accuracyPercentage, 81);
    assert.deepEqual(await db.select().from(questionAttempts).where(eq(questionAttempts.userUid, uid)), before);
    assert.deepEqual((await db.select().from(examSessions).where(eq(examSessions.id, history.id)))[0], history);
    assert.equal((await db.select().from(bookmarks).where(eq(bookmarks.userUid, uid))).length, 1);
    const repeated = await Promise.all(Array.from({ length: 3 }, () => repo.createPracticeOrExamSession(uid, { mode: 'study', lectureIds: [fixtureLectures[0]] })));
    assert.ok(repeated.every(result => result.session.id === study.id));
    const customOnly = (await repo.createPracticeOrExamSession(uid, { mode: 'custom', lectureIds: [fixtureLectures[1]], shuffleQuestions: false })).session;
    for (const index of [0, 3, 12, 21, 28, 38, 40, 42, 43]) {
      const question = customOnly.questions[index];
      await repo.saveSessionQuestionAnswer(uid, customOnly.id, question.id, question.correctDisplayedOption, true, 0, true);
    }
    const simultaneous = await Promise.all(Array.from({ length: 2 }, () => repo.createPracticeOrExamSession(uid, { mode: 'study', lectureIds: [fixtureLectures[1]] })));
    assert.equal(simultaneous[0].session.id, simultaneous[1].session.id);
    assert.equal(simultaneous[0].session.questions.filter((question: any) => question.submitted).length, 9);
    assert.equal(getResumeQuestionIndex(simultaneous[0].session), 1);
    // Submitting a partially answered study set must not make the rest read-only.
    const completedId = simultaneous[0].session.id;
    await repo.completeExamSession(uid, completedId);
    const [completedBefore] = await db.select().from(examSessions).where(eq(examSessions.id, completedId));
    const continued = (await repo.createPracticeOrExamSession(uid, { mode: 'study', lectureIds: [fixtureLectures[1]] })).session;
    assert.notEqual(continued.id, completedId);
    assert.equal(continued.status, 'in_progress');
    assert.equal(continued.questions.filter((question: any) => question.submitted).length, 9);
    assert.deepEqual((await db.select().from(examSessions).where(eq(examSessions.id, completedId)))[0], completedBefore);
    const filtered = (await repo.createPracticeOrExamSession(uid, { mode: 'study', lectureIds: [fixtureLectures[0]], onlyMistakes: true })).session;
    assert.notEqual(filtered.id, study.id);
    assert.equal(filtered.totalQuestions, 5);
    assert.equal(filtered.questions.filter((question: any) => question.submitted).length, 0);
    // A cached lecture must include questions published after its previous opening.
    await db.insert(questions).values({ ...base, id: undefined, lectureId: fixtureLectures[0], questionBankId: null,
      questionText: `New published question ${marker}`, contentHash: `${marker}-new` });
    repo.invalidateCatalogCache();
    const expanded = (await repo.createPracticeOrExamSession(uid, { mode: 'study', lectureIds: [fixtureLectures[0]] })).session;
    assert.equal(expanded.totalQuestions, 61);
    assert.equal(expanded.questions.length, 61);
    assert.equal(expanded.questions.filter((question: any) => question.submitted).length, 27);
    await db.update(questions).set({ status: 'archived' }).where(eq(questions.id, lectureQuestions[0][0]));
    repo.invalidateCatalogCache();
    const reduced = (await repo.createPracticeOrExamSession(uid, { mode: 'study', lectureIds: [fixtureLectures[0]] })).session;
    assert.equal(reduced.totalQuestions, 60);
    assert.equal(reduced.questions.filter((question: any) => question.submitted).length, 26);
    const afterArchive = await repo.getStudentDashboardAnalytics(uid);
    assert.equal(afterArchive.subjectProgress.flatMap((subject: any) => subject.lectures).find((lecture: any) => lecture.lectureId === fixtureLectures[0])?.uniqueQuestionsAttempted, 26);
  } finally {
    await db.delete(bookmarks).where(eq(bookmarks.userUid, uid));
    await db.delete(examSessions).where(eq(examSessions.userUid, uid));
    if (fixtureLectures.length) {
      await db.delete(questions).where(inArray(questions.lectureId, fixtureLectures));
      await db.delete(lectures).where(inArray(lectures.id, fixtureLectures));
    }
    repo.invalidateCatalogCache();
  }
});
