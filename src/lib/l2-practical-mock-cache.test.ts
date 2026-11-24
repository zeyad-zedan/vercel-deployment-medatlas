import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

const local = /^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '');
process.env.NODE_ENV = 'test';
process.env.AUTH_SESSION_SECRET = 'medatlas-l2-cache-isolated-test-secret-32chars';
process.env.GEMINI_GRADING_POOL = JSON.stringify([
  { key: 'AIza' + 'L'.repeat(35), project: 'l2-cache-test-proj-1', rpm: 10000, concurrency: 5 },
  { key: 'AIza' + 'M'.repeat(35), project: 'l2-cache-test-proj-2', rpm: 10000, concurrency: 5 },
]);

const examId = '40506034-00ff-47a7-a2f9-d9d1c963eaba';
const { pool } = await import('../db/index.ts');
const {
  clearPracticalMockStationCacheForTests,
  parsePracticalMockStations,
  readPracticalMock,
  runPracticalMockGrading,
} = await import('../db/practical-mock.ts');

after(() => pool.end());

function makeStations(count: number, labelPrefix = 'Initial') {
  return parsePracticalMockStations(
    Array.from({ length: count }, (_, i) =>
      i % 3 === 0
        ? {
            questionType: 'mcq',
            question: `${labelPrefix} MCQ station ${i + 1}`,
            options: { A: 'Alpha', B: 'Beta', C: 'Gamma', D: 'Delta' },
            correctAnswer: 'B',
            marks: 2,
            explanation: 'Beta is correct.',
            images: [],
          }
        : {
            questionType: 'short_answer',
            question: `${labelPrefix} Written station ${i + 1}`,
            modelAnswer: `${labelPrefix} model ${i + 1}`,
            rubric: [{ description: `${labelPrefix} rubric ${i + 1}`, marks: 2 }],
            images: [],
          },
    ),
  );
}

test('L2: station cache preserves concurrency, partial grading, retries, recovery, expiry, publication, and invalidates immediately on direct SQL station update', { skip: !local }, async () => {
  clearPracticalMockStationCacheForTests();
  const uidA = `l2-a-${randomUUID()}`;
  const uidB = `l2-b-${randomUUID()}`;
  const uidActive = `l2-active-${randomUUID()}`;
  const uidHotfix = `l2-hotfix-${randomUUID()}`;
  const allUids = [uidA, uidB, uidActive, uidHotfix];

  const stations = makeStations(12, 'Initial');
  const answers = Object.fromEntries(
    stations.map((s: any, idx) => [
      idx,
      { text: s.question_type === 'mcq' ? 'B' : `Student text ${idx}`, revision: 1 },
    ]),
  );

  // Track claim SQL responses to verify cache hits (stations === null) vs misses
  let claimMisses = 0;
  let claimHits = 0;
  const origQuery = pool.query.bind(pool);
  (pool as any).query = async function (...args: any[]) {
    const res = await (origQuery as any)(...args);
    const sqlText = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
    if (sqlText.includes('WITH next_attempt AS') && Array.isArray(res?.rows) && res.rows.length > 0) {
      if (res.rows[0].stations === null) claimHits++;
      else claimMisses++;
    }
    return res;
  };

  const seenQuestionsByCall: string[][] = [];
  let failOnce = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith('https://generativelanguage.googleapis.com/')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body));
    const { stations: batch } = JSON.parse(body.contents[0].parts[0].text);
    seenQuestionsByCall.push(batch.map((s: any) => s.question));
    if (failOnce && seenQuestionsByCall.length === 2) {
      failOnce = false;
      return Response.json({ candidates: [{ finishReason: 'MAX_TOKENS' }] });
    }
    const grades = batch.map(({ index, rubric }: any) => ({
      index,
      feedback: `Graded ${index}`,
      points: rubric.map((p: any) => ({ id: p.id, awarded: p.marks, feedback: p.description })),
    }));
    return Response.json({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ grades }) }] } }],
    });
  };

  try {
    await origQuery('DELETE FROM practical_mock.attempts WHERE exam_id = $1', [examId]);
    await origQuery('DELETE FROM practical_mock.exams WHERE id = $1', [examId]);
    await origQuery('DELETE FROM public.gemini_grading_pool_state');
    await origQuery(
      `INSERT INTO public.users(uid, email, display_name, role, profile_completed, email_verified)
       SELECT u, u || '@example.invalid', 'L2 Test', 'student', true, true FROM unnest($1::text[]) u`,
      [allUids],
    );
    await origQuery(
      `INSERT INTO practical_mock.exams(id, title, stations, station_seconds, mark_unit)
       VALUES($1, 'L2 Equivalence Exam', $2::jsonb, 60, 0.25)`,
      [examId, JSON.stringify(stations)],
    );

    // 1. uidA: finished & due; uidB: expired lease (recovery); uidActive: still mid-exam (must NOT be claimed!)
    await origQuery(
      `INSERT INTO practical_mock.attempts(exam_id, user_uid, started_at, answers, grade_available_at, lease, lease_until)
       VALUES
         ($1, $2, clock_timestamp() - interval '30 minutes', $5::jsonb, clock_timestamp() - interval '1 second', NULL, NULL),
         ($1, $3, clock_timestamp() - interval '30 minutes', $5::jsonb, clock_timestamp() - interval '1 second', $6::uuid, clock_timestamp() - interval '2 seconds'),
         ($1, $4, clock_timestamp() - interval '1 minute', $5::jsonb, clock_timestamp() - interval '1 second', NULL, NULL)`,
      [examId, uidA, uidB, uidActive, JSON.stringify(answers), randomUUID()],
    );

    // Concurrent worker invocations
    await Promise.all([runPracticalMockGrading(), runPracticalMockGrading()]);
    // Retry any deferred batch after transient MAX_TOKENS failure
    await origQuery(
      `UPDATE practical_mock.attempts SET grade_available_at = clock_timestamp()
       WHERE exam_id = $1 AND grades IS NULL AND user_uid = ANY($2)`,
      [examId, [uidA, uidB]],
    );
    await origQuery('DELETE FROM public.gemini_grading_pool_state');
    await runPracticalMockGrading();

    const resA = await readPracticalMock(uidA, examId);
    const resB = await readPracticalMock(uidB, examId);
    const resActive = await readPracticalMock(uidActive, examId);

    assert.equal(resA.status, 'graded');
    assert.equal(resB.status, 'graded');
    assert.equal(resActive.status, 'active', 'Non-expired active exam attempt must never be graded early');
    if (resA.status === 'graded' && resB.status === 'graded') {
      assert.deepStrictEqual(resA.stations, resB.stations, 'Recovered attempt must match normal attempt identically');
      assert.equal(resA.stations.length, 12);
      assert.equal(resA.stations[0].grade.score, 0.5, 'Quarter-mark conversion preserved');
    }
    assert.ok(claimHits > 0, `Expected cache hits on repeated claims, got hits=${claimHits}, misses=${claimMisses}`);

    // 2. Verify future opens_at is still enforced even when exam is warm in cache
    await origQuery(`UPDATE practical_mock.exams SET opens_at = clock_timestamp() + interval '1 hour' WHERE id = $1`, [examId]);
    await origQuery(
      `INSERT INTO practical_mock.attempts(exam_id, user_uid, started_at, answers, grade_available_at)
       VALUES($1, $2, clock_timestamp() - interval '30 minutes', $3::jsonb, clock_timestamp() - interval '1 second')`,
      [examId, uidHotfix, JSON.stringify(answers)],
    );
    const closedRun = await runPracticalMockGrading();
    assert.equal(closedRun.processed, 0, 'Cached exam with future opens_at must not be claimed');

    // 3. Direct SQL hotfix to practical_mock.exams.stations (simulating production manual SQL fix)
    const missesBeforeHotfix = claimMisses;
    const updatedStations = makeStations(12, 'Hotfixed');
    await origQuery(
      `UPDATE practical_mock.exams SET opens_at = NULL, stations = $2::jsonb WHERE id = $1`,
      [examId, JSON.stringify(updatedStations)],
    );
    seenQuestionsByCall.length = 0;
    await origQuery('DELETE FROM public.gemini_grading_pool_state');
    await runPracticalMockGrading();

    assert.ok(claimMisses > missesBeforeHotfix, 'Direct SQL UPDATE on practical_mock.exams must invalidate station cache immediately via xmin:ctid');
    assert.ok(
      seenQuestionsByCall.flat().every(q => q.startsWith('Hotfixed')),
      `Expected all graded stations after SQL hotfix to use updated definition, saw: ${JSON.stringify(seenQuestionsByCall)}`,
    );
    const resHotfix = await readPracticalMock(uidHotfix, examId);
    assert.equal(resHotfix.status, 'graded');
    if (resHotfix.status === 'graded') {
      assert.ok(resHotfix.stations[1].grade.points[0].feedback.startsWith('Hotfixed rubric'));
    }
  } finally {
    globalThis.fetch = realFetch;
    (pool as any).query = origQuery;
    clearPracticalMockStationCacheForTests();
    await origQuery('DELETE FROM practical_mock.attempts WHERE exam_id = $1', [examId]);
    await origQuery('DELETE FROM practical_mock.exams WHERE id = $1', [examId]);
    await origQuery('DELETE FROM public.users WHERE uid = ANY($1)', [allUids]);
    await origQuery('DELETE FROM public.gemini_grading_pool_state');
  }
});
