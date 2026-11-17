import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pool } from './index.ts';
import { GradingError, gradePracticalStationsWithGemini } from '../lib/gemini-short-answer.ts';
import { gradeWithAvailableCredentials } from '../lib/gemini-grading-pool.ts';
import { imageForStorage } from '../lib/telegram-question-images.ts';
import { parseShortAnswerBatch, type ShortAnswerDefinition, type ShortAnswerGrade } from '../lib/short-answer-model.ts';
import { maxPracticalAnswerLength, maxPracticalMarkingPoints, maxPracticalStations, practicalStationSeconds,
  type PracticalMockAttempt, type PracticalMockCard } from '../lib/practical-mock.ts';

export class PracticalMockError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const stationInterval = `${practicalStationSeconds} seconds`;
const saveProcessingGraceSeconds = 5;
const gradeBatchSize = 5;
const gradeLeaseSeconds = 60;
const gradeSliceStartBudgetMs = 55_000;
const gradeWorkerConcurrency = 6;
// Shift effective start backwards by skipped_ms so skip jumps straight to the next station without changing elapsed-time queries.
const effectiveStart = `(a.started_at - a.skipped_ms * interval '1 millisecond')`;
const validId = (value: string) => {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) throw new PracticalMockError('Exam not found.', 404);
  return value;
};

type SavedAnswer = { text: string; revision: number };
type ExamAnswers = Record<number, SavedAnswer>;
const studentStation = (station: ShortAnswerDefinition) => ({
  question: station.question_text,
  images: station.images ?? [],
  maxMarks: station.rubric.reduce((total, point) => total + point.marks, 0),
});

export async function listPracticalMocks(uid: string, examId?: string) {
  const { rows } = await pool.query<PracticalMockCard>(`
    SELECT e.id, e.title, jsonb_array_length(e.stations) AS "stationCount",
      CASE WHEN a.grades IS NOT NULL THEN 'graded' WHEN a.started_at IS NULL THEN 'ready'
        WHEN clock_timestamp() >= ${effectiveStart} + jsonb_array_length(e.stations) * $2::interval THEN 'finished'
        ELSE 'active' END AS status
    FROM practical_mock.exams e LEFT JOIN practical_mock.attempts a ON a.exam_id=e.id AND a.user_uid=$1
    WHERE (e.opens_at IS NULL OR e.opens_at <= statement_timestamp())
      AND CASE WHEN $3::uuid IS NULL THEN NOT e.unlisted ELSE e.id=$3 END
    ORDER BY e.created_at DESC, e.id
  `, [uid, stationInterval, examId === undefined ? null : validId(examId)]);
  return rows;
}

export async function publishPracticalMock(value: { id?: unknown; title?: unknown; stations?: unknown }) {
  const id = validId(typeof value?.id === 'string' ? value.id : '');
  const title = typeof value?.title === 'string' ? value.title.trim() : '';
  if (title.length < 3 || title.length > 120) throw new PracticalMockError('Enter an exam name of 3–120 characters.');
  if (!Array.isArray(value.stations) || !value.stations.length || value.stations.length > maxPracticalStations) {
    throw new PracticalMockError(`Add 1–${maxPracticalStations} stations.`);
  }
  const input = value.stations;
  const questions = input.map((station, index) => {
    if (!station || !Array.isArray(station.rubric) || station.rubric.length > maxPracticalMarkingPoints) {
      throw new PracticalMockError(`Station ${index + 1}: add up to ${maxPracticalMarkingPoints} marking points.`);
    }
    return { question_text: station.question, model_answer: station.modelAnswer, rubric: station.rubric };
  });
  let definitions: ShortAnswerDefinition[];
  try { definitions = parseShortAnswerBatch(JSON.stringify(questions)); }
  catch (error) { throw new PracticalMockError((error as Error).message); }
  const stations = definitions.map((definition, index) => {
    try { return { ...definition, images: [imageForStorage(input[index].image)] }; }
    catch { throw new PracticalMockError(`Station ${index + 1}: upload a valid photo.`); }
  });
  await pool.query(`
    INSERT INTO practical_mock.exams (id, title, stations) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING
  `, [id, title, JSON.stringify(stations)]);
  return id;
}

export async function startPracticalMock(uid: string, examId: string) {
  await pool.query(`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
    INSERT INTO practical_mock.attempts (exam_id, user_uid, started_at, grade_available_at)
    SELECT id, $2, clock.now, clock.now + jsonb_array_length(stations) * $3::interval + $4 * interval '1 second'
    FROM practical_mock.exams, clock WHERE id=$1
      AND (opens_at IS NULL OR opens_at <= statement_timestamp())
    ON CONFLICT (exam_id, user_uid) DO NOTHING
  `, [validId(examId), uid, stationInterval, saveProcessingGraceSeconds]);
  return readPracticalMock(uid, examId);
}

export async function readPracticalMock(uid: string, examId: string): Promise<PracticalMockAttempt> {
  const { rows: [row] } = await pool.query(`
    WITH attempt AS MATERIALIZED (
      SELECT e.title, e.stations, a.*, clock_timestamp() AS server_now,
        ${effectiveStart} AS effective_start,
        jsonb_array_length(e.stations) AS station_count
      FROM practical_mock.attempts a JOIN practical_mock.exams e ON e.id=a.exam_id
      WHERE a.exam_id=$1 AND a.user_uid=$2 AND (e.opens_at IS NULL OR e.opens_at <= statement_timestamp())
    ), timing AS (
      SELECT *, floor(extract(epoch FROM (server_now - effective_start)) / $3::int)::int AS idx FROM attempt
    )
    SELECT title, station_count, idx, grades, grade_error,
      greatest(0, ceil(extract(epoch FROM (coalesce(grade_available_at, retry_at) - server_now))*1000))::int AS retry_ms,
      (grade_available_at IS NOT NULL OR lease_until > server_now) IS TRUE AS grading,
      CASE WHEN idx < station_count THEN stations->idx END AS station,
      CASE WHEN idx < station_count THEN answers->idx::text END AS answer,
      CASE WHEN grades IS NOT NULL THEN stations END AS completed_stations,
      CASE WHEN grades IS NOT NULL THEN answers END AS completed_answers,
      CASE WHEN idx < station_count THEN ceil(extract(epoch FROM
        (effective_start + (idx+1) * $3::int * interval '1 second' - server_now))*1000)::int END AS remaining_ms
    FROM timing
  `, [validId(examId), uid, practicalStationSeconds]);
  if (!row) throw new PracticalMockError('Exam attempt not found.', 404);
  const exam = { id: examId, title: row.title, stationCount: row.station_count };
  if (row.station) {
    return { ...exam, status: 'active', stationIndex: row.idx, station: studentStation(row.station),
      answer: row.answer?.text ?? '', revision: row.answer?.revision ?? 0, remainingMs: row.remaining_ms };
  }
  if (row.grades) {
    return { ...exam, status: 'graded', stations: (row.completed_stations as ShortAnswerDefinition[]).map((station, index) => ({
      ...studentStation(station), answer: row.completed_answers[index]?.text ?? '', modelAnswer: station.model_answer, grade: row.grades[index],
    })) };
  }
  return { ...exam, status: row.grading ? 'grading' : 'finished', retryInMs: row.retry_ms, gradingError: row.grade_error };
}

export async function savePracticalMockAnswer(
  uid: string, examId: string, value: { stationIndex?: unknown; answer?: unknown; revision?: unknown }, receivedAt = Date.now(),
) {
  const { stationIndex, answer, revision } = value ?? {};
  if (typeof stationIndex !== 'number' || !Number.isInteger(stationIndex) || stationIndex < 0 || stationIndex >= maxPracticalStations ||
    typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || revision >= 2147483647 ||
    typeof answer !== 'string' || answer.length > maxPracticalAnswerLength) throw new PracticalMockError('Invalid station or answer.');
  const id = validId(examId);
  const waitingSince = performance.now();
  const client = await pool.connect();
  const acquiredAt = performance.now();
  try {
    const { rowCount } = await client.query(`
    UPDATE practical_mock.attempts a
    SET answers=jsonb_set(a.answers, ARRAY[$3::int::text], jsonb_build_object('text',$4::text,'revision',$5::int+1))
    FROM practical_mock.exams e
    WHERE a.exam_id=$1 AND a.user_uid=$2 AND (e.opens_at IS NULL OR e.opens_at <= statement_timestamp()) AND e.id=a.exam_id AND $3 < jsonb_array_length(e.stations)
      AND a.grades IS NULL
      AND to_timestamp($7::double precision/1000) >= ${effectiveStart} + $3 * $6::interval
      AND to_timestamp($7::double precision/1000) < ${effectiveStart} + ($3+1) * $6::interval
      AND clock_timestamp() < ${effectiveStart} + ($3+1) * $6::interval + $8 * interval '1 second'
      AND coalesce((a.answers->$3::int::text->>'revision')::int,0)=$5
    `, [id, uid, stationIndex, answer, revision, stationInterval, receivedAt, saveProcessingGraceSeconds]);
    if (!rowCount) {
      // A committed save can lose its response. A replay of that revision is safe.
      const saved = await client.query(`
        SELECT 1 FROM practical_mock.attempts
        WHERE exam_id=$1 AND user_uid=$2
          AND (answers->$3::int::text->>'revision')::int=$4 AND answers->$3::int::text->>'text'=$5
      `, [id, uid, stationIndex, revision + 1, answer]);
      if (!saved.rowCount) throw new PracticalMockError('This station closed or its answer changed in another tab.', 409);
    }
    return { revision: revision + 1, poolMs: Math.round(acquiredAt - waitingSince),
      databaseMs: Math.round(performance.now() - acquiredAt) };
  } finally {
    client.release();
  }
}

export async function skipPracticalMock(uid: string, examId: string, value: { stationIndex?: unknown }) {
  const stationIndex = value?.stationIndex;
  if (typeof stationIndex !== 'number' || !Number.isInteger(stationIndex) || stationIndex < 0 || stationIndex >= maxPracticalStations) {
    throw new PracticalMockError('Invalid station.');
  }
  // Single materialized clock snapshot prevents clock drift between active-window verification and skipped_ms calculation.
  const { rowCount } = await pool.query(`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
    UPDATE practical_mock.attempts a
    SET skipped_ms = GREATEST(0::bigint,
      (($3::int + 1)::bigint * $4::int * 1000) - floor(extract(epoch FROM (clock.now - a.started_at)) * 1000)::bigint),
      grade_available_at = CASE WHEN a.grade_available_at IS NOT NULL THEN
        clock.now + (jsonb_array_length(e.stations) - $3::int - 1) * $5::interval + $6 * interval '1 second'
      END
    FROM practical_mock.exams e, clock
    WHERE a.exam_id=$1 AND a.user_uid=$2 AND (e.opens_at IS NULL OR e.opens_at <= statement_timestamp()) AND e.id=a.exam_id AND a.grades IS NULL
      AND $3 < jsonb_array_length(e.stations)
      AND clock.now >= ${effectiveStart} + $3 * $5::interval
      AND clock.now < ${effectiveStart} + ($3 + 1) * $5::interval
  `, [validId(examId), uid, stationIndex, practicalStationSeconds, stationInterval, saveProcessingGraceSeconds]);
  if (!rowCount) throw new PracticalMockError('This station has already closed.', 409);
  return readPracticalMock(uid, examId);
}

function emptyGrade(station: ShortAnswerDefinition): ShortAnswerGrade {
  return { score: 0, maxScore: studentStation(station).maxMarks, feedback: 'No answer was saved for this station.',
    points: station.rubric.map(point => ({ ...point, awarded: 0, feedback: 'Unanswered.' })) };
}

export async function gradePracticalMock(uid: string, examId: string) {
  const current = await readPracticalMock(uid, examId);
  if (current.status === 'active') throw new PracticalMockError('Grading starts after the final station closes.', 409);
  if (current.status !== 'finished') return current;

  // Existing attempts and jobs that need a student's intervention can be queued again.
  await pool.query(`
    UPDATE practical_mock.attempts a
    SET grade_available_at=greatest(clock_timestamp(),
      ${effectiveStart} + jsonb_array_length(e.stations) * $3::interval + $4 * interval '1 second'),
      grade_error=NULL, grade_failures=0, retry_at=NULL
    FROM practical_mock.exams e
    WHERE a.exam_id=$1 AND a.user_uid=$2 AND e.id=a.exam_id AND a.grades IS NULL
      AND a.grade_available_at IS NULL
      AND (a.lease_until IS NULL OR a.lease_until <= clock_timestamp())
  `, [validId(examId), uid, stationInterval, saveProcessingGraceSeconds]);
  return readPracticalMock(uid, examId);
}

type GradingJob = {
  exam_id: string;
  user_uid: string;
  stations: ShortAnswerDefinition[];
  answers: ExamAnswers;
  grade_progress: Record<number, ShortAnswerGrade>;
  grade_failures: number;
};

async function processPracticalMockBatch() {
  const lease = randomUUID();
  const { rows: [job] } = await pool.query<GradingJob>(`
    WITH next_attempt AS (
      SELECT a.exam_id, a.user_uid, e.stations
      FROM practical_mock.attempts a JOIN practical_mock.exams e ON e.id=a.exam_id
      WHERE a.grade_available_at <= statement_timestamp() AND a.grades IS NULL
        AND (a.lease_until IS NULL OR a.lease_until <= statement_timestamp())
        AND (e.opens_at IS NULL OR e.opens_at <= statement_timestamp())
        AND ${effectiveStart} + jsonb_array_length(e.stations) * $1::interval + $2 * interval '1 second' <= statement_timestamp()
      ORDER BY a.grade_available_at, a.started_at, a.exam_id, a.user_uid
      LIMIT 1 FOR UPDATE OF a SKIP LOCKED
    )
    UPDATE practical_mock.attempts a
    SET lease=$3, lease_until=clock_timestamp()+$4 * interval '1 second'
    FROM next_attempt n
    WHERE a.exam_id=n.exam_id AND a.user_uid=n.user_uid
    RETURNING a.exam_id, a.user_uid, n.stations, a.answers, a.grade_progress, a.grade_failures
  `, [stationInterval, saveProcessingGraceSeconds, lease, gradeLeaseSeconds]);
  if (!job) return 'empty';

  const started = performance.now();
  const pending = job.stations.map((question, index) => ({
    question, index, answer: job.answers[index]?.text.trim() ?? '',
  })).filter(station => station.answer && !job.grade_progress[station.index]);
  // Reduce the batch on repeated timeouts or invalid model output for this attempt.
  const batch = pending.slice(0, Math.max(1, gradeBatchSize >> Math.min(job.grade_failures, 3)));
  const key = [job.exam_id, job.user_uid, lease];
  if (batch.length) {
    try {
      const result = await gradeWithAvailableCredentials(job.user_uid,
        (apiKey, deadline) => gradePracticalStationsWithGemini(apiKey, batch, deadline));
      for (const { index, grade } of result.grade) job.grade_progress[index] = grade;
    } catch (error) {
      const failure = error instanceof GradingError ? error : new GradingError('UNAVAILABLE', 15);
      const sizeFailure = ['TIMEOUT', 'INVALID_RESPONSE'].includes(failure.code);
      const accessFailure = ['POOL_ACCESS', 'POOL_MODEL_UNAVAILABLE'].includes(failure.code);
      const failures = job.grade_failures + Number(sizeFailure || accessFailure);
      const paused = [
        'KEY_MISSING', 'KEY_OR_ACCESS', 'MODEL_UNAVAILABLE', 'GEMINI_BAD_REQUEST',
        'POOL_CONFIG',
      ].includes(failure.code) || failures >= 5;
      const message = failure.code === 'KEY_MISSING' ? 'Add your Gemini API key in Profile & Settings, then retry grading.'
        : 'Grading needs attention. Your answers and any completed grades are saved.';
      const poolBusy = failure.code === 'POOL_BUSY';
      const delay = poolBusy ? failure.delaySeconds + Math.random() * 0.5
        : Math.max(failure.delaySeconds, sizeFailure ? 2 ** failures * 5 : 10) + Math.floor(Math.random() * 6);
      await pool.query(`
        UPDATE practical_mock.attempts
        SET lease=NULL, lease_until=NULL, grade_error=$4, grade_failures=$5,
          grade_available_at=CASE WHEN $6 THEN NULL ELSE clock_timestamp()+$7 * interval '1 second' END
        WHERE exam_id=$1 AND user_uid=$2 AND lease=$3
      `, [...key, paused ? message : null, failures, paused, delay]);
      if (!poolBusy) console.warn('[practical-grading] batch deferred', { code: failure.code, paused,
        batchSize: batch.length, elapsedMs: Math.round(performance.now() - started) });
      if (poolBusy) return Math.ceil(delay * 1000);
      return failure.code === 'POOL_STORAGE' ? 'storage' : 'deferred';
    }
  }

  const grades = pending.length === batch.length
    ? job.stations.map((station, index) => job.grade_progress[index] ?? emptyGrade(station))
    : null;
  await pool.query(`
    UPDATE practical_mock.attempts
    SET grade_progress=CASE WHEN $5::jsonb IS NULL THEN $4::jsonb ELSE '{}'::jsonb END,
      grades=$5::jsonb, grade_failures=0, grade_error=NULL,
      grade_available_at=CASE WHEN $5::jsonb IS NULL THEN clock_timestamp() ELSE NULL END,
      retry_at=NULL, lease=NULL, lease_until=NULL
    WHERE exam_id=$1 AND user_uid=$2 AND lease=$3
  `, [...key, JSON.stringify(job.grade_progress), grades && JSON.stringify(grades)]);
  return grades ? 'completed' : 'checkpointed';
}

// Leave time for the last provider call and database acknowledgement inside the 90s function limit.
export async function runPracticalMockGrading() {
  const started = performance.now();
  const stopStartingAt = started + gradeSliceStartBudgetMs;
  const counts = { completed: 0, checkpointed: 0, deferred: 0, storage: 0, capacityWaits: 0 };
  async function worker() {
    while (performance.now() < stopStartingAt) {
      const result = await processPracticalMockBatch();
      if (result === 'empty') break;
      if (typeof result === 'number') {
        counts.capacityWaits++;
        if (performance.now() + result >= stopStartingAt) break;
        await sleep(result);
        continue;
      }
      counts[result]++;
      if (result === 'storage') break;
    }
  }
  const results = await Promise.allSettled(Array.from({ length: gradeWorkerConcurrency }, worker));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  const processed = counts.completed + counts.checkpointed + counts.deferred + counts.storage;
  if (processed || counts.capacityWaits) console.info('[practical-grading] worker run', {
    ...counts, elapsedMs: Math.round(performance.now() - started),
  });
  return { processed, ...counts };
}
