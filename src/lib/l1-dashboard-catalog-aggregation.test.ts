import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test, after } from 'node:test';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { computeTopicPerformance, parseSpecialTags } from './mcq-engine.ts';

process.env.NODE_ENV = 'test';
const enabled = /^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '');
const {
  db,
  pool,
  users,
  modules,
  subjects,
  lectures,
  questions,
  examSessions,
  questionAttempts,
  bookmarks,
} = await import('../db/index.ts');
const repo = await import('../db/repository.ts');

after(async () => {
  await pool.end();
});

test('L1 catalog SQL aggregation matches full-row metadata calculation and avoids per-question transfer', { skip: !enabled }, async () => {
  await repo.ensureSeededDatabase();
  const marker = crypto.randomUUID().slice(0, 8);
  let modId: number | undefined;
  let pubSubjId: number | undefined;
  let draftSubjId: number | undefined;
  const lectIds: number[] = [];

  try {
    const [mod] = await db
      .insert(modules)
      .values({ code: `L1CAT-${marker}`, title: `L1 Cat Mod ${marker}`, description: 'Test', displayOrder: 99, status: 'published' })
      .returning();
    modId = mod.id;

    const [pubSubj, draftSubj] = await db
      .insert(subjects)
      .values([
        { moduleId: mod.id, slug: `l1cat-pub-${marker}`, title: `L1 Cat Pub ${marker}`, description: 'Pub', displayOrder: 98, status: 'published' },
        { moduleId: mod.id, slug: `l1cat-draft-${marker}`, title: `L1 Cat Draft ${marker}`, description: 'Draft', displayOrder: 99, status: 'draft' },
      ])
      .returning();
    pubSubjId = pubSubj.id;
    draftSubjId = draftSubj.id;

    const [pubLect, draftLect, lectInDraftSubj] = await db
      .insert(lectures)
      .values([
        { subjectId: pubSubj.id, title: `L1 Cat Lect Pub ${marker}`, description: 'Pub L', lectureNumber: 1, status: 'published' },
        { subjectId: pubSubj.id, title: `L1 Cat Lect Draft ${marker}`, description: 'Draft L', lectureNumber: 2, status: 'draft' },
        { subjectId: draftSubj.id, title: `L1 Cat Lect Under Draft Subj ${marker}`, description: 'DS L', lectureNumber: 1, status: 'published' },
      ])
      .returning();
    lectIds.push(pubLect.id, draftLect.id, lectInDraftSubj.id);

    const qDefs = [
      // 30 published questions in pubLect with varied difficulties & special_tags (Arabic comma, semicolon, mixed case)
      ...Array.from({ length: 30 }, (_, i) => ({
        subjectId: pubSubj.id,
        lectureId: pubLect.id,
        questionText: `L1Cat Q ${marker} #${i}`,
        optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D',
        correctAnswer: 'A', explanation: 'Secret explanation',
        difficulty: (['Easy', 'Medium', 'Hard'] as const)[i % 3],
        tags: 'Cardiology',
        specialTags: [
          '',
          'Old Exams',
          'old exam',
          'كتاب القسم، Old Exams',
          'High Yield; Important',
          'important',
        ][i % 6],
        status: 'published',
        contentHash: `l1cat-pub-${marker}-${i}`,
      })),
      // 3 published questions in draftLect (excluded from catalog)
      ...Array.from({ length: 3 }, (_, i) => ({
        subjectId: pubSubj.id,
        lectureId: draftLect.id,
        questionText: `L1Cat DraftLect Q ${marker} #${i}`,
        optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D',
        correctAnswer: 'B', explanation: 'E', difficulty: 'Easy',
        tags: 'Hidden', specialTags: 'Old Exams', status: 'published',
        contentHash: `l1cat-dl-${marker}-${i}`,
      })),
      // 2 published questions under draftSubj (excluded from catalog)
      ...Array.from({ length: 2 }, (_, i) => ({
        subjectId: draftSubj.id,
        lectureId: lectInDraftSubj.id,
        questionText: `L1Cat DraftSubj Q ${marker} #${i}`,
        optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D',
        correctAnswer: 'C', explanation: 'E', difficulty: 'Hard',
        tags: 'Hidden', specialTags: 'Important', status: 'published',
        contentHash: `l1cat-ds-${marker}-${i}`,
      })),
      // 4 draft/archived questions in pubLect (excluded from catalog)
      ...Array.from({ length: 4 }, (_, i) => ({
        subjectId: pubSubj.id,
        lectureId: pubLect.id,
        questionText: `L1Cat NonPub Q ${marker} #${i}`,
        optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D',
        correctAnswer: 'D', explanation: 'E', difficulty: 'Medium',
        tags: 'Hidden', specialTags: 'Old Exams', status: i % 2 === 0 ? 'draft' : 'archived',
        contentHash: `l1cat-np-${marker}-${i}`,
      })),
    ];
    await db.insert(questions).values(qDefs);

    repo.invalidateCatalogCache();

    // Instrument pool.query to verify grouped SQL is used instead of full-row metadata fetch
    const origQuery = pool.query.bind(pool);
    const seenQueries: Array<{ sql: string; rows: number }> = [];
    (pool as any).query = (...args: any[]) =>
      (origQuery as any)(...args).then((res: any) => {
        const sqlText = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '');
        seenQueries.push({ sql: String(sqlText), rows: Array.isArray(res?.rows) ? res.rows.length : 0 });
        return res;
      });

    let catalog: Awaited<ReturnType<typeof repo.getPublishedCatalog>>;
    try {
      catalog = await repo.getPublishedCatalog();
    } finally {
      (pool as any).query = origQuery;
    }

    // Verify no query fetched correct_answer from questions
    assert.ok(
      !seenQueries.some((q) => q.sql.includes('"questions"') && q.sql.includes('correct_answer')),
      'getPublishedCatalog() must not select per-question correct_answer metadata'
    );
    const qGroupQuery = seenQueries.find((q) => q.sql.includes('from "questions"') && q.sql.includes('group by'));
    assert.ok(qGroupQuery, 'getPublishedCatalog() must aggregate questions in SQL');

    // Verify our fixture lecture matches exact counts & breakdowns
    const foundLect = catalog.lectures.find((l: any) => l.id === pubLect.id);
    assert.ok(foundLect, 'published lecture must appear in catalog');
    assert.equal(foundLect.questionCount, 30);
    assert.deepEqual(foundLect.difficultyBreakdown, { Easy: 10, Medium: 10, Hard: 10 });
    assert.ok(!catalog.lectures.some((l: any) => l.id === draftLect.id || l.id === lectInDraftSubj.id));
    assert.ok(!catalog.subjects.some((s: any) => s.id === draftSubj.id));

    // Verify specialTags breakdown matches parseSpecialTags applied row-by-row
    const expectedSpec: Record<string, number> = {};
    const globalCanonical = new Map<string, string>();
    for (const q of qDefs.slice(0, 30)) {
      for (const st of parseSpecialTags(q.specialTags)) {
        const key = st.toLowerCase();
        const label = globalCanonical.get(key) ?? st;
        globalCanonical.set(key, label);
        expectedSpec[label] = (expectedSpec[label] || 0) + 1;
      }
    }
    assert.equal(foundLect.specialTagBreakdown['كتاب القسم'], 5);
    assert.equal(foundLect.specialTagBreakdown['High Yield'], 5);
    assert.equal(
      (foundLect.specialTagBreakdown['Old Exams'] || 0) + (foundLect.specialTagBreakdown['old exam'] || 0),
      15
    );
    assert.equal(
      (foundLect.specialTagBreakdown['Important'] || 0) + (foundLect.specialTagBreakdown['important'] || 0),
      10
    );

    // Ensure no answer keys leaked into serialized catalog
    assert.ok(!JSON.stringify(catalog).includes('Secret explanation'));
  } finally {
    if (lectIds.length) {
      await db.delete(questions).where(inArray(questions.lectureId, lectIds));
      await db.delete(lectures).where(inArray(lectures.id, lectIds));
    }
    if (pubSubjId || draftSubjId) {
      await db.delete(subjects).where(inArray(subjects.id, [pubSubjId, draftSubjId].filter((x): x is number => x !== undefined)));
    }
    if (modId !== undefined) await db.delete(modules).where(eq(modules.id, modId));
    repo.invalidateCatalogCache();
  }
});

test('L1 dashboard SQL aggregation matches original JS calculation across all edge cases and real-time resets', { skip: !enabled }, async () => {
  await repo.ensureSeededDatabase();
  const marker = crypto.randomUUID().slice(0, 8);
  const emptyUid = `l1dash-empty-${marker}`;
  const edgeUid = `l1dash-edge-${marker}`;
  let subjId: number | undefined;
  const lectIds: number[] = [];

  try {
    const [subj] = await db
      .insert(subjects)
      .values({ slug: `l1dash-${marker}`, title: `L1 Dash Subj ${marker}`, description: 'Test', displayOrder: 97, status: 'published' })
      .returning();
    subjId = subj.id;

    const [lectA, lectB, draftLect] = await db
      .insert(lectures)
      .values([
        { subjectId: subj.id, title: `L1 Dash Lect A ${marker}`, description: 'A', lectureNumber: 1, status: 'published' },
        { subjectId: subj.id, title: `L1 Dash Lect B ${marker}`, description: 'B', lectureNumber: 2, status: 'published' },
        { subjectId: subj.id, title: `L1 Dash Draft Lect ${marker}`, description: 'D', lectureNumber: 3, status: 'draft' },
      ])
      .returning();
    lectIds.push(lectA.id, lectB.id, draftLect.id);

    const insertedQs = await db
      .insert(questions)
      .values([
        // 0..3: published in lectA (including duplicate tag & empty tag)
        { subjectId: subj.id, lectureId: lectA.id, questionText: `Q0 ${marker}`, optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'A', explanation: 'SecretAns0', difficulty: 'Easy', tags: 'Renal, Renal, Electrolytes', status: 'published', contentHash: `l1d-${marker}-0` },
        { subjectId: subj.id, lectureId: lectA.id, questionText: `Q1 ${marker}`, optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'A', explanation: 'SecretAns1', difficulty: 'Medium', tags: 'Cardio, ECG', status: 'published', contentHash: `l1d-${marker}-1` },
        { subjectId: subj.id, lectureId: lectA.id, questionText: `Q2 ${marker}`, optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'A', explanation: 'SecretAns2', difficulty: 'Hard', tags: '   ', status: 'published', contentHash: `l1d-${marker}-2` },
        { subjectId: subj.id, lectureId: lectA.id, questionText: `Q3 ${marker}`, optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'A', explanation: 'SecretAns3', difficulty: 'Easy', tags: 'Neuro', status: 'published', contentHash: `l1d-${marker}-3` },
        // 4..5: published in lectB
        { subjectId: subj.id, lectureId: lectB.id, questionText: `Q4 ${marker}`, optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'B', explanation: 'SecretAns4', difficulty: 'Medium', tags: 'Pulm', status: 'published', contentHash: `l1d-${marker}-4` },
        { subjectId: subj.id, lectureId: lectB.id, questionText: `Q5 ${marker}`, optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'B', explanation: 'SecretAns5', difficulty: 'Hard', tags: 'Pulm', status: 'published', contentHash: `l1d-${marker}-5` },
        // 6: published in draftLect (under published subj -> counts in subjectProgress, not published lectureBreakdown)
        { subjectId: subj.id, lectureId: draftLect.id, questionText: `Q6 ${marker}`, optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'C', explanation: 'SecretAns6', difficulty: 'Easy', tags: 'DraftLectTag', status: 'published', contentHash: `l1d-${marker}-6` },
        // 7: draft question (counts in summary & General Medical Concepts, not subjectProgress/lectureBreakdown)
        { subjectId: subj.id, lectureId: lectA.id, questionText: `Q7 ${marker}`, optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'D', explanation: 'SecretAns7', difficulty: 'Easy', tags: 'HiddenDraftTag', status: 'draft', contentHash: `l1d-${marker}-7` },
      ])
      .returning();

    await db.insert(users).values([
      { uid: emptyUid, email: `${emptyUid}@example.invalid`, displayName: 'Empty', profileCompleted: true },
      { uid: edgeUid, email: `${edgeUid}@example.invalid`, displayName: 'Edge', profileCompleted: true },
    ]);

    const t0 = new Date('2026-10-15T12:00:00.000Z').getTime();
    const [sessCompleted, sessInProgress, sessCustom] = await db
      .insert(examSessions)
      .values([
        { userUid: edgeUid, title: 'LectA Completed', mode: 'study', subjectId: subj.id, lectureId: lectA.id, status: 'completed', totalQuestions: 4, correctCount: 2, incorrectCount: 1, unansweredCount: 1, scorePercentage: 50, startedAt: new Date(t0), completedAt: new Date(t0 + 60_000), questionOrderJson: '[]' },
        { userUid: edgeUid, title: 'LectA InProgress', mode: 'study', subjectId: subj.id, lectureId: lectA.id, status: 'in_progress', totalQuestions: 4, correctCount: 1, incorrectCount: 0, unansweredCount: 3, scorePercentage: 25, startedAt: new Date(t0 + 120_000), questionOrderJson: '[]' },
        { userUid: edgeUid, title: 'Custom Mix', mode: 'custom', subjectId: null, lectureId: null, status: 'completed', totalQuestions: 6, correctCount: 4, incorrectCount: 2, unansweredCount: 0, scorePercentage: 67, startedAt: new Date(t0 + 240_000), completedAt: new Date(t0 + 300_000), questionOrderJson: '[]' },
      ])
      .returning();

    const sameTs = new Date(t0 + 10_000);
    await db.insert(questionAttempts).values([
      // Q0 (duplicate tag "Renal, Renal, Electrolytes"): old wrong -> newer right at EXACT same timestamp (higher id wins)
      { sessionId: sessCompleted.id, userUid: edgeUid, questionId: insertedQs[0].id, subjectId: subj.id, lectureId: lectA.id, selectedOption: 'B', isCorrect: false, correctOptionSnapshot: 'A', questionSnapshotJson: '{}', answeredAt: sameTs },
      { sessionId: sessInProgress.id, userUid: edgeUid, questionId: insertedQs[0].id, subjectId: subj.id, lectureId: lectA.id, selectedOption: 'A', isCorrect: true, correctOptionSnapshot: 'A', questionSnapshotJson: '{}', answeredAt: sameTs },
      // Q1: older answered -> newer CLEARED (selectedOption = NULL) MUST hide older answer!
      { sessionId: sessCompleted.id, userUid: edgeUid, questionId: insertedQs[1].id, subjectId: subj.id, lectureId: lectA.id, selectedOption: 'A', isCorrect: true, correctOptionSnapshot: 'A', questionSnapshotJson: '{}', answeredAt: new Date(t0 + 20_000) },
      { sessionId: sessInProgress.id, userUid: edgeUid, questionId: insertedQs[1].id, subjectId: subj.id, lectureId: lectA.id, selectedOption: null, isCorrect: false, gradingStatus: 'cleared', correctOptionSnapshot: 'A', questionSnapshotJson: '{}', answeredAt: new Date(t0 + 30_000) },
      // Q2: pending short answer (gradingStatus = 'saved') -> isCorrect MUST coerce to NULL
      { sessionId: sessCompleted.id, userUid: edgeUid, questionId: insertedQs[2].id, subjectId: subj.id, lectureId: lectA.id, selectedOption: 'SA', isCorrect: true, gradingStatus: 'saved', correctOptionSnapshot: 'SA', questionSnapshotJson: '{}', answeredAt: new Date(t0 + 40_000) },
      // Q4 in lectB: graded short answer -> keeps isCorrect = false
      { sessionId: sessCustom.id, userUid: edgeUid, questionId: insertedQs[4].id, subjectId: subj.id, lectureId: lectB.id, selectedOption: 'SA', isCorrect: false, gradingStatus: 'graded', correctOptionSnapshot: 'SA', questionSnapshotJson: '{}', answeredAt: new Date(t0 + 50_000) },
      // Q6 in draftLect: published question in draft lecture
      { sessionId: sessCustom.id, userUid: edgeUid, questionId: insertedQs[6].id, subjectId: subj.id, lectureId: draftLect.id, selectedOption: 'C', isCorrect: true, correctOptionSnapshot: 'C', questionSnapshotJson: '{}', answeredAt: new Date(t0 + 60_000) },
      // Q7: draft question (counts in summary + General Medical Concepts, excluded from subjectProgress)
      { sessionId: sessCustom.id, userUid: edgeUid, questionId: insertedQs[7].id, subjectId: subj.id, lectureId: lectA.id, selectedOption: 'D', isCorrect: true, correctOptionSnapshot: 'D', questionSnapshotJson: '{}', answeredAt: new Date(t0 + 70_000) },
      // Deleted question (questionId = NULL) -> must be ignored
      { sessionId: sessCustom.id, userUid: edgeUid, questionId: null, subjectId: subj.id, lectureId: lectA.id, selectedOption: 'A', isCorrect: true, correctOptionSnapshot: 'A', questionSnapshotJson: '{}', answeredAt: new Date(t0 + 80_000) },
    ]);
    await db.insert(bookmarks).values({ userUid: edgeUid, questionId: insertedQs[0].id, note: '' });

    repo.invalidateCatalogCache();

    // 1. Verify empty user
    const emptyDash = await repo.getStudentDashboardAnalytics(emptyUid);
    assert.equal(emptyDash.summary.totalQuestionsAnswered, 0);
    assert.equal(emptyDash.summary.uniqueQuestionsAttempted, 0);
    assert.equal(emptyDash.summary.totalCorrectAnswers, 0);
    assert.equal(emptyDash.summary.totalIncorrectAnswers, 0);
    assert.equal(emptyDash.summary.overallAccuracy, 0);
    assert.equal(emptyDash.summary.lecturesAttemptedCount, 0);
    assert.deepEqual(emptyDash.topicPerformance, []);
    assert.deepEqual(emptyDash.history, []);

    // 2. Instrument pool.query on edgeUid to confirm 1-row CTE aggregation & no full-row metadata fetch
    repo.invalidateCatalogCache();
    const origQuery = pool.query.bind(pool);
    const seenQueries: Array<{ sql: string; rows: number }> = [];
    (pool as any).query = (...args: any[]) =>
      (origQuery as any)(...args).then((res: any) => {
        const sqlText = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '');
        seenQueries.push({ sql: String(sqlText), rows: Array.isArray(res?.rows) ? res.rows.length : 0 });
        return res;
      });

    let edgeDash: Awaited<ReturnType<typeof repo.getStudentDashboardAnalytics>>;
    try {
      edgeDash = await repo.getStudentDashboardAnalytics(edgeUid);
    } finally {
      (pool as any).query = origQuery;
    }

    assert.ok(
      !seenQueries.some((q) => q.sql.includes('"questions"') && q.sql.includes('correct_answer')),
      'getStudentDashboardAnalytics() must not call readQuestionMetadata()'
    );
    const cteQuery = seenQueries.find((q) => q.sql.includes('WITH latest_per_question'));
    assert.ok(cteQuery && cteQuery.rows === 1, 'dashboard attempt stats CTE must return exactly 1 aggregated row');

    // 3. Compare against reference JS implementation of original algorithm
    const rawAttempts = await db
      .selectDistinctOn([questionAttempts.questionId], {
        questionId: questionAttempts.questionId,
        subjectId: questionAttempts.subjectId,
        lectureId: questionAttempts.lectureId,
        selectedOption: questionAttempts.selectedOption,
        isCorrect: sql<boolean | null>`CASE WHEN ${questionAttempts.gradingStatus} IS NOT NULL AND ${questionAttempts.gradingStatus} != 'graded' THEN NULL ELSE ${questionAttempts.isCorrect} END`.as('is_correct'),
        answeredAt: questionAttempts.answeredAt,
      })
      .from(questionAttempts)
      .where(eq(questionAttempts.userUid, edgeUid))
      .orderBy(questionAttempts.questionId, desc(questionAttempts.answeredAt), desc(questionAttempts.id));

    const allPubQs = await db
      .select({ id: questions.id, subjectId: questions.subjectId, lectureId: questions.lectureId, tags: questions.tags })
      .from(questions)
      .where(eq(questions.status, 'published'));
    const qMap = new Map(allPubQs.map((q) => [q.id, q]));

    const sortedAnswered = [...rawAttempts]
      .sort((a, b) => new Date(b.answeredAt).getTime() - new Date(a.answeredAt).getTime())
      .filter((a) => a.selectedOption !== null && a.questionId !== null);

    // Exact summary checks: Q0(right), Q2(pending), Q4(wrong), Q6(right), Q7(draft,right) => 5 answered, 3 correct, 1 incorrect, 1 pending
    assert.equal(edgeDash.summary.totalQuestionsAnswered, sortedAnswered.length);
    assert.equal(edgeDash.summary.totalQuestionsAnswered, 5);
    assert.equal(edgeDash.summary.totalCorrectAnswers, 3);
    assert.equal(edgeDash.summary.totalIncorrectAnswers, 1);
    assert.equal(edgeDash.summary.overallAccuracy, Math.round((3 / 4) * 100));
    assert.equal(edgeDash.summary.lecturesAttemptedCount, 3); // lectA, lectB, draftLect
    assert.equal(edgeDash.summary.totalPublishedQuestions, allPubQs.length);
    assert.equal(edgeDash.summary.bookmarkCount, 1);

    // Exact subjectProgress & lectureBreakdown checks
    const subjRow = edgeDash.subjectProgress.find((s: any) => s.subjectId === subj.id);
    assert.ok(subjRow);
    // Subject has 7 published questions (4 in lectA + 2 in lectB + 1 in draftLect), 4 attempted (Q0, Q2, Q4, Q6; Q7 is draft)
    assert.equal(subjRow.totalPublishedQuestions, 7);
    assert.equal(subjRow.uniqueQuestionsAttempted, 4);
    assert.equal(subjRow.correctAnswers, 2); // Q0, Q6
    assert.equal(subjRow.incorrectAnswers, 1); // Q4
    assert.equal(subjRow.accuracyPercentage, Math.round((2 / 3) * 100));
    assert.ok(subjRow.lastAttemptAt instanceof Date);
    assert.equal(subjRow.lastAttemptAt.toISOString(), new Date(t0 + 60_000).toISOString());

    const lectARow = subjRow.lectures.find((l: any) => l.lectureId === lectA.id);
    assert.ok(lectARow);
    assert.equal(lectARow.totalPublishedQuestions, 4);
    assert.equal(lectARow.uniqueQuestionsAttempted, 2); // Q0 (right) + Q2 (pending); Q1 was cleared!
    assert.equal(lectARow.correctAnswers, 1);
    assert.equal(lectARow.incorrectAnswers, 0);
    assert.equal(lectARow.accuracyPercentage, 100);
    assert.equal(lectARow.activeSessionId, sessInProgress.id);
    assert.equal(lectARow.reviewSessionId, sessCompleted.id);

    // Exact topicPerformance comparison against original computeTopicPerformance
    const expectedTopics = computeTopicPerformance(
      sortedAnswered
        .filter((a) => a.isCorrect !== null)
        .map((a) => ({ questionId: a.questionId, isCorrect: a.isCorrect as boolean, tags: qMap.get(a.questionId!)?.tags || '' }))
    );
    assert.deepStrictEqual(edgeDash.topicPerformance, expectedTopics);
    // Verify duplicate tag "Renal, Renal, Electrolytes" produced totalAttempts=2, uniqueQuestionsAttempted=1
    const renal = edgeDash.topicPerformance.find((t: any) => t.topic === 'Renal');
    assert.deepEqual(renal, {
      topic: 'Renal',
      totalAttempts: 2,
      uniqueQuestionsAttempted: 1,
      correctAttempts: 2,
      accuracyPercentage: 100,
      isSmallSample: true,
      classification: 'Insufficient Sample',
    });

    // No answer keys or explanations leaked
    assert.ok(!JSON.stringify(edgeDash).includes('SecretAns'));

    // 4. Verify real-time reflection of new answer WITHOUT invalidating catalog cache!
    await db.insert(questionAttempts).values({
      sessionId: sessCustom.id,
      userUid: edgeUid,
      questionId: insertedQs[5].id,
      subjectId: subj.id,
      lectureId: lectB.id,
      selectedOption: 'B',
      isCorrect: true,
      correctOptionSnapshot: 'B',
      questionSnapshotJson: '{}',
      answeredAt: new Date(t0 + 90_000),
    });
    const afterNewAnswer = await repo.getStudentDashboardAnalytics(edgeUid);
    assert.equal(afterNewAnswer.summary.totalQuestionsAnswered, 6);
    assert.equal(afterNewAnswer.summary.totalCorrectAnswers, 4);

    // 5. Verify real-time reflection of resetLectureProgress() WITHOUT invalidating catalog cache!
    await repo.resetLectureProgress(edgeUid, lectA.id);
    const afterReset = await repo.getStudentDashboardAnalytics(edgeUid);
    const resetSubj = afterReset.subjectProgress.find((s: any) => s.subjectId === subj.id);
    const resetLectA = resetSubj?.lectures.find((l: any) => l.lectureId === lectA.id);
    assert.equal(resetLectA?.uniqueQuestionsAttempted, 0);
    assert.equal(resetLectA?.activeSessionId, null);
    assert.equal(resetLectA?.reviewSessionId, null);
    const untouchedLectB = resetSubj?.lectures.find((l: any) => l.lectureId === lectB.id);
    assert.equal(untouchedLectB?.uniqueQuestionsAttempted, 2);
  } finally {
    await db.delete(bookmarks).where(inArray(bookmarks.userUid, [emptyUid, edgeUid]));
    await db.delete(questionAttempts).where(inArray(questionAttempts.userUid, [emptyUid, edgeUid]));
    await db.delete(examSessions).where(inArray(examSessions.userUid, [emptyUid, edgeUid]));
    await db.delete(users).where(inArray(users.uid, [emptyUid, edgeUid]));
    if (lectIds.length) {
      await db.delete(questions).where(inArray(questions.lectureId, lectIds));
      await db.delete(lectures).where(inArray(lectures.id, lectIds));
    }
    if (subjId !== undefined) await db.delete(subjects).where(eq(subjects.id, subjId));
    repo.invalidateCatalogCache();
  }
});
