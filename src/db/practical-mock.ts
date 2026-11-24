import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pool } from './index.ts';
import { GradingError, gradePracticalStationsWithGemini, gradingRetrySeconds } from '../lib/gemini-short-answer.ts';
import { gradeWithAvailableCredentials } from '../lib/gemini-grading-pool.ts';
import { imageForStorage } from '../lib/telegram-question-images.ts';
import { parseShortAnswerBatch, type MarkingPoint, type ShortAnswerDefinition, type ShortAnswerGrade } from '../lib/short-answer-model.ts';
import { maxPracticalAnswerLength, maxPracticalMarkingPoints, practicalStationSeconds,
  type PracticalMcqOptions, type PracticalMockAttempt, type PracticalMockCard } from '../lib/practical-mock.ts';

export class PracticalMockError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const saveProcessingGraceSeconds = 5;
const gradeBatchSize = 5;
const gradeLeaseSeconds = 65;
const gradeSliceStartBudgetMs = 35_000;
const gradeWorkerConcurrency = 3;
// Shift effective start backwards by skipped_ms so skip jumps straight to the next station without changing elapsed-time queries.
const effectiveStart = `(a.started_at - a.skipped_ms * interval '1 millisecond')`;
const validId = (value: string) => {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) throw new PracticalMockError('Exam not found.', 404);
  return value;
};

type SavedAnswer = { text: string; revision: number };
type ExamAnswers = Record<number, SavedAnswer>;

export type PracticalMcqDefinition = ShortAnswerDefinition & {
  question_type: 'mcq';
  options: PracticalMcqOptions;
  correct_answer: string;
};

export type StoredPracticalStation = ShortAnswerDefinition | PracticalMcqDefinition;

function isMcqStation(station: StoredPracticalStation): station is PracticalMcqDefinition {
  return (station as PracticalMcqDefinition).question_type === 'mcq' && Boolean((station as PracticalMcqDefinition).options);
}

const studentStation = (station: StoredPracticalStation, unit = 1) => {
  const maxMarks = station.rubric.reduce((total, point) => total + point.marks, 0) * unit;
  if (isMcqStation(station)) {
    return {
      questionType: 'mcq' as const,
      question: station.question_text,
      images: station.images ?? [],
      maxMarks,
      options: station.options,
    };
  }
  return {
    questionType: 'short_answer' as const,
    question: station.question_text,
    images: station.images ?? [],
    maxMarks,
  };
};

// Store and grade integer units; convert only at the student API boundary.
export function practicalGradeForStudent(grade: ShortAnswerGrade, unit = 1): ShortAnswerGrade {
  return { ...grade, score: grade.score * unit, maxScore: grade.maxScore * unit,
    points: grade.points.map(point => ({ ...point, marks: point.marks * unit, awarded: point.awarded * unit })) };
}

export async function listPracticalMocks(uid: string, examId?: string) {
  const { rows } = await pool.query<PracticalMockCard>(`
    SELECT e.id, e.title, e.station_seconds AS "stationSeconds", jsonb_array_length(e.stations) AS "stationCount",
      CASE WHEN a.grades IS NOT NULL THEN 'graded' WHEN a.started_at IS NULL THEN 'ready'
        WHEN clock_timestamp() >= ${effectiveStart} + jsonb_array_length(e.stations) * e.station_seconds * interval '1 second' THEN 'finished'
        ELSE 'active' END AS status
    FROM practical_mock.exams e LEFT JOIN practical_mock.attempts a ON a.exam_id=e.id AND a.user_uid=$1
    WHERE (e.opens_at IS NULL OR e.opens_at <= statement_timestamp())
      AND CASE WHEN $2::uuid IS NULL THEN NOT e.unlisted ELSE e.id=$2 END
    ORDER BY e.created_at DESC, e.id
  `, [uid, examId === undefined ? null : validId(examId)]);
  return rows;
}

function parseMcqStation(station: any, index: number): PracticalMcqDefinition {
  const question = typeof station?.question === 'string' ? station.question.trim() : '';
  if (!question || question.length > 4000) throw new PracticalMockError(`Station ${index + 1}: enter a question (1–4000 characters).`);
  const rawOptions = station?.options;
  if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    throw new PracticalMockError(`Station ${index + 1}: provide 2–6 MCQ options.`);
  }
  const options: PracticalMcqOptions = {};
  for (const [rawKey, rawVal] of Object.entries(rawOptions)) {
    const key = rawKey.trim().toUpperCase();
    if (!/^[A-F]$/.test(key)) throw new PracticalMockError(`Station ${index + 1}: option keys must be letters A–F.`);
    if (typeof rawVal !== 'string' || !rawVal.trim() || rawVal.trim().length > 1000) {
      throw new PracticalMockError(`Station ${index + 1}: option ${key} must be 1–1000 characters.`);
    }
    options[key] = rawVal.trim();
  }
  const keys = Object.keys(options);
  if (keys.length < 2 || keys.length > 6) throw new PracticalMockError(`Station ${index + 1}: provide 2–6 MCQ options.`);
  const rawCorrect = typeof station?.correctAnswer === 'string' ? station.correctAnswer : typeof station?.correct_answer === 'string' ? station.correct_answer : '';
  const correct = rawCorrect.trim().toUpperCase();
  if (!options[correct]) throw new PracticalMockError(`Station ${index + 1}: correctAnswer must match one of the options.`);
  const marks = station?.marks === undefined ? 1 : station.marks;
  if (typeof marks !== 'number' || !Number.isInteger(marks) || marks < 1 || marks > 10) {
    throw new PracticalMockError(`Station ${index + 1}: MCQ marks must be an integer 1–10.`);
  }
  const explanation = typeof station?.explanation === 'string' ? station.explanation.trim() : '';
  if (explanation.length > 2000) throw new PracticalMockError(`Station ${index + 1}: explanation must be up to 2000 characters.`);
  const photos = station.images ?? (station.image ? [station.image] : []);
  if (!Array.isArray(photos) || photos.length > 4) throw new PracticalMockError(`Station ${index + 1}: use up to four photos.`);
  let storedImages;
  try { storedImages = photos.map(imageForStorage); }
  catch { throw new PracticalMockError(`Station ${index + 1}: upload a valid photo.`); }
  const modelAnswer = explanation ? `${correct}) ${options[correct]} — ${explanation}` : `${correct}) ${options[correct]}`;
  const rubric: MarkingPoint[] = [{ id: 'p1', description: `Correct choice: ${correct}) ${options[correct]}`, marks }];
  return {
    question_type: 'mcq',
    question_text: question,
    options,
    correct_answer: correct,
    model_answer: modelAnswer,
    rubric,
    tags: [],
    status: 'published',
    images: storedImages,
  };
}

export function parsePracticalMockStations(input: any[]): StoredPracticalStation[] {
  if (!input.length) throw new PracticalMockError('Add at least 1 station.');
  const results: StoredPracticalStation[] = new Array(input.length);
  const writtenEntries: Array<{ index: number; raw: any; payload: { question_text: any; model_answer: any; rubric: any } }> = [];

  for (let index = 0; index < input.length; index++) {
    const station = input[index];
    const kind = station?.questionType ?? station?.question_type ?? 'short_answer';
    if (kind === 'mcq') {
      results[index] = parseMcqStation(station, index);
    } else {
      if (!station || !Array.isArray(station.rubric) || station.rubric.length > maxPracticalMarkingPoints) {
        throw new PracticalMockError(`Station ${index + 1}: add up to ${maxPracticalMarkingPoints} marking points.`);
      }
      writtenEntries.push({
        index,
        raw: station,
        payload: { question_text: station.question, model_answer: station.modelAnswer, rubric: station.rubric },
      });
    }
  }

  if (writtenEntries.length) {
    const definitions: ShortAnswerDefinition[] = [];
    try {
      for (let offset = 0; offset < writtenEntries.length; offset += 200) {
        const chunk = writtenEntries.slice(offset, offset + 200).map(e => e.payload);
        definitions.push(...parseShortAnswerBatch(JSON.stringify(chunk)));
      }
    } catch (error) {
      throw new PracticalMockError((error as Error).message);
    }
    definitions.forEach((definition, i) => {
      const { index, raw } = writtenEntries[i];
      const photos = raw.images ?? (raw.image ? [raw.image] : []);
      if (!Array.isArray(photos) || photos.length > 4) throw new PracticalMockError(`Station ${index + 1}: use up to four photos.`);
      try { results[index] = { ...definition, images: photos.map(imageForStorage) }; }
      catch { throw new PracticalMockError(`Station ${index + 1}: upload a valid photo.`); }
    });
  }

  return results;
}

export async function publishPracticalMock(value: { id?: unknown; title?: unknown; stations?: unknown; stationSeconds?: unknown; markUnit?: unknown; unlisted?: unknown }) {
  const id = validId(typeof value?.id === 'string' ? value.id : '');
  const title = typeof value?.title === 'string' ? value.title.trim() : '';
  if (title.length < 3 || title.length > 120) throw new PracticalMockError('Enter an exam name of 3–120 characters.');
  if (!Array.isArray(value.stations) || !value.stations.length) {
    throw new PracticalMockError('Add at least 1 station.');
  }
  const seconds = value.stationSeconds ?? practicalStationSeconds;
  const unit = value.markUnit ?? 1;
  const unlisted = Boolean(value.unlisted);
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 30 || seconds > 600) throw new PracticalMockError('Use 30–600 seconds per slide.');
  if (unit !== 1 && unit !== 0.25) throw new PracticalMockError('Use a mark unit of 1 or 0.25.');
  const stations = parsePracticalMockStations(value.stations);
  await pool.query(`
    INSERT INTO practical_mock.exams (id, title, stations, station_seconds, mark_unit, unlisted) VALUES ($1, $2, $3::jsonb, $4, $5, $6) ON CONFLICT (id) DO NOTHING
  `, [id, title, JSON.stringify(stations), seconds, unit, unlisted]);
  return id;
}

export async function startPracticalMock(uid: string, examId: string) {
  await pool.query(`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
    INSERT INTO practical_mock.attempts (exam_id, user_uid, started_at, grade_available_at)
    SELECT id, $2, clock.now, clock.now + jsonb_array_length(stations) * station_seconds * interval '1 second' + $3 * interval '1 second'
    FROM practical_mock.exams, clock WHERE id=$1
      AND (opens_at IS NULL OR opens_at <= statement_timestamp())
    ON CONFLICT (exam_id, user_uid) DO NOTHING
  `, [validId(examId), uid, saveProcessingGraceSeconds]);
  return readPracticalMock(uid, examId);
}

export async function readPracticalMock(uid: string, examId: string): Promise<PracticalMockAttempt> {
  const { rows: [row] } = await pool.query(`
    WITH attempt AS MATERIALIZED (
      SELECT e.title, e.stations, e.station_seconds, e.mark_unit, a.*, clock_timestamp() AS server_now,
        ${effectiveStart} AS effective_start,
        jsonb_array_length(e.stations) AS station_count
      FROM practical_mock.attempts a JOIN practical_mock.exams e ON e.id=a.exam_id
      WHERE a.exam_id=$1 AND a.user_uid=$2 AND (e.opens_at IS NULL OR e.opens_at <= statement_timestamp())
    ), timing AS (
      SELECT *, floor(extract(epoch FROM (server_now - effective_start)) / station_seconds)::int AS idx FROM attempt
    )
    SELECT title, station_count, mark_unit, idx, grades, grade_error,
      greatest(0, ceil(extract(epoch FROM (coalesce(grade_available_at, retry_at) - server_now))*1000))::int AS retry_ms,
      (grade_available_at IS NOT NULL OR lease_until > server_now) IS TRUE AS grading,
      CASE WHEN idx < station_count THEN stations->idx END AS station,
      CASE WHEN idx < station_count THEN answers->idx::text END AS answer,
      CASE WHEN idx >= station_count THEN stations END AS completed_stations,
      CASE WHEN idx >= station_count THEN answers END AS completed_answers,
      CASE WHEN idx < station_count THEN ceil(extract(epoch FROM
        (effective_start + (idx+1) * station_seconds * interval '1 second' - server_now))*1000)::int END AS remaining_ms
    FROM timing
  `, [validId(examId), uid]);
  if (!row) throw new PracticalMockError('Exam attempt not found.', 404);
  const exam = { id: examId, title: row.title, stationCount: row.station_count };
  const unit = Number(row.mark_unit);
  if (row.station) {
    return { ...exam, status: 'active', stationIndex: row.idx, station: studentStation(row.station, unit),
      answer: row.answer?.text ?? '', revision: row.answer?.revision ?? 0, remainingMs: row.remaining_ms };
  }
  if (row.grades) {
    return { ...exam, status: 'graded', stations: (row.completed_stations as StoredPracticalStation[]).map((station, index) => ({
      ...studentStation(station, unit),
      answer: row.completed_answers[index]?.text ?? '',
      modelAnswer: station.model_answer,
      ...(isMcqStation(station) ? { correctOption: station.correct_answer } : {}),
      grade: practicalGradeForStudent(row.grades[index], unit),
    })) };
  }
  const previewStations = Array.isArray(row.completed_stations)
    ? (row.completed_stations as StoredPracticalStation[]).map((station, index) => {
        const rawAnswer = row.completed_answers?.[index]?.text ?? '';
        const mcqGrade = isMcqStation(station) ? practicalGradeForStudent(gradeMcqStation(station, rawAnswer), unit) : undefined;
        return {
          ...studentStation(station, unit),
          answer: rawAnswer,
          modelAnswer: station.model_answer,
          ...(isMcqStation(station) ? { correctOption: station.correct_answer } : {}),
          ...(mcqGrade ? { grade: mcqGrade } : {}),
        };
      })
    : undefined;
  return { ...exam, status: row.grading ? 'grading' : 'finished', retryInMs: row.retry_ms, gradingError: row.grade_error, stations: previewStations };
}

export async function savePracticalMockAnswer(
  uid: string, examId: string, value: { stationIndex?: unknown; answer?: unknown; revision?: unknown }, receivedAt = Date.now(),
) {
  const { stationIndex, answer, revision } = value ?? {};
  if (typeof stationIndex !== 'number' || !Number.isInteger(stationIndex) || stationIndex < 0 || stationIndex >= 2147483647 ||
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
      AND to_timestamp($6::double precision/1000) >= ${effectiveStart} + $3 * e.station_seconds * interval '1 second'
      AND to_timestamp($6::double precision/1000) < ${effectiveStart} + ($3+1) * e.station_seconds * interval '1 second'
      AND clock_timestamp() < ${effectiveStart} + ($3+1) * e.station_seconds * interval '1 second' + $7 * interval '1 second'
      AND coalesce((a.answers->$3::int::text->>'revision')::int,0)=$5
    `, [id, uid, stationIndex, answer, revision, receivedAt, saveProcessingGraceSeconds]);
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
  if (typeof stationIndex !== 'number' || !Number.isInteger(stationIndex) || stationIndex < 0 || stationIndex >= 2147483647) {
    throw new PracticalMockError('Invalid station.');
  }
  // Single materialized clock snapshot prevents clock drift between active-window verification and skipped_ms calculation.
  const { rowCount } = await pool.query(`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
    UPDATE practical_mock.attempts a
    SET skipped_ms = GREATEST(0::bigint,
      (($3::int + 1)::bigint * e.station_seconds * 1000) - floor(extract(epoch FROM (clock.now - a.started_at)) * 1000)::bigint),
      grade_available_at = CASE WHEN a.grade_available_at IS NOT NULL THEN
        clock.now + (jsonb_array_length(e.stations) - $3::int - 1) * e.station_seconds * interval '1 second' + $4 * interval '1 second'
      END
    FROM practical_mock.exams e, clock
    WHERE a.exam_id=$1 AND a.user_uid=$2 AND (e.opens_at IS NULL OR e.opens_at <= statement_timestamp()) AND e.id=a.exam_id AND a.grades IS NULL
      AND $3 < jsonb_array_length(e.stations)
      AND clock.now >= ${effectiveStart} + $3 * e.station_seconds * interval '1 second'
      AND clock.now < ${effectiveStart} + ($3 + 1) * e.station_seconds * interval '1 second'
  `, [validId(examId), uid, stationIndex, saveProcessingGraceSeconds]);
  if (!rowCount) throw new PracticalMockError('This station has already closed.', 409);
  return readPracticalMock(uid, examId);
}

function emptyGrade(station: StoredPracticalStation): ShortAnswerGrade {
  return { score: 0, maxScore: studentStation(station).maxMarks, feedback: 'No answer was saved for this station.',
    points: station.rubric.map(point => ({ ...point, awarded: 0, feedback: 'Unanswered.' })) };
}

function gradeMcqStation(station: PracticalMcqDefinition, rawAnswer: string): ShortAnswerGrade {
  const selected = rawAnswer.trim().toUpperCase();
  if (!selected) return emptyGrade(station);
  const point = station.rubric[0];
  const isCorrect = selected === station.correct_answer;
  const awarded = isCorrect ? point.marks : 0;
  return {
    score: awarded,
    maxScore: point.marks,
    feedback: isCorrect
      ? `Correct (${station.correct_answer}).`
      : `Selected ${selected}; correct answer is ${station.correct_answer}.`,
    points: [{ ...point, awarded, feedback: isCorrect ? 'Correct choice.' : `Incorrect (selected ${selected}).` }],
  };
}

export async function gradePracticalMock(uid: string, examId: string) {
  const current = await readPracticalMock(uid, examId);
  if (current.status === 'active') throw new PracticalMockError('Grading starts after the final station closes.', 409);
  if (current.status !== 'finished') return current;

  // Existing attempts and paused jobs can be re-queued for the bounded background worker.
  await pool.query(`
    UPDATE practical_mock.attempts a
    SET grade_available_at=greatest(clock_timestamp(),
      ${effectiveStart} + jsonb_array_length(e.stations) * e.station_seconds * interval '1 second' + $3 * interval '1 second'),
      grade_error=NULL,
      grade_failures=0,
      retry_at=NULL
    FROM practical_mock.exams e
    WHERE a.exam_id=$1 AND a.user_uid=$2 AND e.id=a.exam_id AND a.grades IS NULL
      AND a.grade_available_at IS NULL
      AND (a.lease_until IS NULL OR a.lease_until <= clock_timestamp())
  `, [validId(examId), uid, saveProcessingGraceSeconds]);

  return readPracticalMock(uid, examId);
}

type GradingJob = {
  exam_id: string;
  user_uid: string;
  exam_version: string;
  stations: StoredPracticalStation[] | null;
  answers: ExamAnswers;
  grade_progress: Record<number, ShortAnswerGrade>;
  grade_failures: number;
};

// Cache exam station definitions per worker process, validated on every claim via PostgreSQL
// tuple version (xmin:ctid) so even direct SQL hotfixes to practical_mock.exams invalidate immediately.
const maxCachedGradingExams = 32;
const gradingExamStationCache = new Map<string, { version: string; stations: StoredPracticalStation[] }>();

export function clearPracticalMockStationCacheForTests() {
  gradingExamStationCache.clear();
}

function snapshotCachedGradingStations() {
  const entries = new Map<string, { version: string; stations: StoredPracticalStation[] }>();
  const versions: Record<string, string> = {};
  for (const [examId, entry] of gradingExamStationCache) {
    entries.set(examId, entry);
    versions[examId] = entry.version;
  }
  return { entries, versions };
}

function rememberGradingStations(examId: string, version: string, stations: StoredPracticalStation[]) {
  if (!gradingExamStationCache.has(examId) && gradingExamStationCache.size >= maxCachedGradingExams) {
    const oldest = gradingExamStationCache.keys().next().value;
    if (oldest !== undefined) gradingExamStationCache.delete(oldest);
  }
  gradingExamStationCache.set(examId, { version, stations });
}

async function processPracticalMockBatch() {
  const lease = randomUUID();
  const cachedSnapshot = snapshotCachedGradingStations();
  const { rows: [job] } = await pool.query<GradingJob>(`
    WITH next_attempt AS (
      SELECT a.exam_id, a.user_uid, e.stations, (e.xmin::text || ':' || e.ctid::text) AS exam_version
      FROM practical_mock.attempts a JOIN practical_mock.exams e ON e.id=a.exam_id
      WHERE a.grade_available_at <= statement_timestamp() AND a.grades IS NULL
        AND (a.lease_until IS NULL OR a.lease_until <= statement_timestamp())
        AND (e.opens_at IS NULL OR e.opens_at <= statement_timestamp())
        AND ${effectiveStart} + jsonb_array_length(e.stations) * e.station_seconds * interval '1 second' + $1 * interval '1 second' <= statement_timestamp()
      ORDER BY a.grade_available_at, a.started_at, a.exam_id, a.user_uid
      LIMIT 1 FOR UPDATE OF a SKIP LOCKED
    )
    UPDATE practical_mock.attempts a
    SET lease=$2, lease_until=clock_timestamp()+$3 * interval '1 second'
    FROM next_attempt n
    WHERE a.exam_id=n.exam_id AND a.user_uid=n.user_uid
    RETURNING a.exam_id, a.user_uid, n.exam_version,
      CASE WHEN ($4::jsonb ->> a.exam_id::text) = n.exam_version THEN NULL ELSE n.stations END AS stations,
      a.answers, a.grade_progress, a.grade_failures
  `, [saveProcessingGraceSeconds, lease, gradeLeaseSeconds, JSON.stringify(cachedSnapshot.versions)]);
  if (!job) return 'empty';

  let jobStations: StoredPracticalStation[];
  if (job.stations) {
    rememberGradingStations(job.exam_id, job.exam_version, job.stations);
    jobStations = job.stations;
  } else {
    const cached = cachedSnapshot.entries.get(job.exam_id);
    if (cached && cached.version === job.exam_version) {
      jobStations = cached.stations;
    } else {
      const { rows: [examRow] } = await pool.query<{ stations: StoredPracticalStation[]; exam_version: string }>(
        `SELECT stations, (xmin::text || ':' || ctid::text) AS exam_version FROM practical_mock.exams WHERE id=$1`,
        [job.exam_id],
      );
      if (!examRow) return 'deferred';
      rememberGradingStations(job.exam_id, examRow.exam_version, examRow.stations);
      jobStations = examRow.stations;
    }
  }

  const started = performance.now();
  // Grade MCQ stations deterministically in code without calling Gemini.
  for (let index = 0; index < jobStations.length; index++) {
    const station = jobStations[index];
    if (isMcqStation(station) && !job.grade_progress[index]) {
      job.grade_progress[index] = gradeMcqStation(station, job.answers[index]?.text ?? '');
    }
  }
  const pending = jobStations.map((question, index) => ({
    question, index, answer: job.answers[index]?.text.trim() ?? '',
  })).filter(station => !isMcqStation(station.question) && station.answer && !job.grade_progress[station.index]);
  // Reduce the batch on repeated timeouts or invalid model output for this attempt.
  const batch = pending.slice(0, Math.max(1, gradeBatchSize >> Math.min(job.grade_failures, 3)));
  // Dense, multipart slides need more output per station than the older image-only exams.
  while (batch.length > 1 && batch.reduce((n, s) => n + s.question.rubric.length, 0) > 40) batch.pop();
  const key = [job.exam_id, job.user_uid, lease];
  if (batch.length) {
    try {
      const result = await gradeWithAvailableCredentials(job.user_uid,
        (apiKey, deadline) => gradePracticalStationsWithGemini(apiKey, batch, deadline));
      for (const { index, grade } of result.grade) job.grade_progress[index] = grade;
    } catch (error) {
      const failure = error instanceof GradingError ? error : new GradingError('UNAVAILABLE', gradingRetrySeconds);
      const sizeFailure = ['TIMEOUT', 'INVALID_RESPONSE'].includes(failure.code);
      const accessFailure = ['POOL_ACCESS', 'POOL_MODEL_UNAVAILABLE', 'UNAVAILABLE', 'GEMINI_UNAVAILABLE'].includes(failure.code);
      const failures = job.grade_failures + Number(sizeFailure || accessFailure);
      const paused = [
        'KEY_MISSING', 'KEY_OR_ACCESS', 'MODEL_UNAVAILABLE', 'GEMINI_BAD_REQUEST',
        'POOL_CONFIG',
      ].includes(failure.code) || failures >= 5;
      const message = failure.code === 'KEY_MISSING' ? 'Add your Gemini API key in Profile & Settings, then retry grading.'
        : 'Grading needs attention. Your answers and any completed grades are saved.';
      const poolBusy = ['POOL_BUSY', 'POOL_RATE_LIMIT', 'POOL_QUOTA'].includes(failure.code);
      const delay = poolBusy
        ? Math.max(1, Math.min(30, failure.delaySeconds || gradingRetrySeconds))
        : process.env.GEMINI_GRADING_POOL?.trim()
          ? gradingRetrySeconds
          : Math.max(gradingRetrySeconds, failure.delaySeconds);
      await pool.query(`
        UPDATE practical_mock.attempts
        SET lease=NULL, lease_until=NULL, grade_error=$4, grade_failures=$5,
          grade_available_at=CASE WHEN $6 THEN NULL ELSE clock_timestamp()+$7 * interval '1 second' END
        WHERE exam_id=$1 AND user_uid=$2 AND lease=$3
      `, [...key, paused ? message : null, failures, paused, delay]);
      if (!poolBusy) console.warn('[practical-grading] batch deferred', { code: failure.code, paused,
        batchSize: batch.length, elapsedMs: Math.round(performance.now() - started) });
      if (poolBusy) return Math.ceil(delay * 1000 + Math.random() * 400);
      return failure.code === 'POOL_STORAGE' ? 'storage' : 'deferred';
    }
  }

  const grades = pending.length === batch.length
    ? jobStations.map((station, index) => job.grade_progress[index] ?? emptyGrade(station))
    : null;
  const { rowCount } = await pool.query(`
    UPDATE practical_mock.attempts
    SET grade_progress=CASE WHEN $5::jsonb IS NULL THEN $4::jsonb ELSE '{}'::jsonb END,
      grades=$5::jsonb, grade_failures=0, grade_error=NULL,
      grade_available_at=CASE WHEN $5::jsonb IS NULL THEN clock_timestamp() ELSE NULL END,
      retry_at=NULL, lease=NULL, lease_until=NULL
    WHERE exam_id=$1 AND user_uid=$2 AND lease=$3
  `, [...key, JSON.stringify(job.grade_progress), grades && JSON.stringify(grades)]);
  if (!rowCount) {
    console.warn('[practical-grading] stale lease discarded', { batchSize: batch.length, elapsedMs: Math.round(performance.now() - started) });
    return 'deferred';
  }
  return grades ? 'completed' : 'checkpointed';
}

// Leave time for the last provider call and database acknowledgement inside the 90s function limit.
export async function runPracticalMockGrading() {
  const started = performance.now();
  const stopStartingAt = started + gradeSliceStartBudgetMs;
  const counts = { completed: 0, checkpointed: 0, deferred: 0, storage: 0, capacityWaits: 0 };
  async function worker() {
    while (performance.now() < stopStartingAt) {
      let result: 'empty' | 'completed' | 'checkpointed' | 'deferred' | 'storage' | number;
      try {
        result = await processPracticalMockBatch();
      } catch (error) {
        console.warn('[practical-grading] batch storage error', { code: (error as { code?: string })?.code });
        counts.storage++;
        break;
      }
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


export async function adminListPracticalMockAttempts(examId: string) {
  const id = validId(examId);
  const { rows: [exam] } = await pool.query(`SELECT id, title, stations, mark_unit FROM practical_mock.exams WHERE id=$1`, [id]);
  if (!exam) throw new PracticalMockError('Exam not found.', 404);
  const unit = Number(exam.mark_unit);
  const stations = exam.stations as StoredPracticalStation[];
  const maxMarks = stations.reduce((s, st) => s + st.rubric.reduce((a, p) => a + p.marks, 0), 0) * unit;
  const { rows } = await pool.query(`
    SELECT a.user_uid AS "uid", coalesce(u.display_name, u.email, a.user_uid) AS "name", coalesce(u.email, '') AS "email",
      a.started_at AS "startedAt", a.grades, a.answers,
      CASE WHEN a.grades IS NOT NULL THEN 'graded'
        WHEN clock_timestamp() >= ${effectiveStart} + jsonb_array_length(e.stations) * e.station_seconds * interval '1 second' THEN 'pending'
        ELSE 'solving' END AS status
    FROM practical_mock.attempts a
    JOIN practical_mock.exams e ON e.id = a.exam_id
    LEFT JOIN public.users u ON u.uid = a.user_uid
    WHERE a.exam_id = $1
    ORDER BY (a.grades IS NULL AND clock_timestamp() >= ${effectiveStart} + jsonb_array_length(e.stations) * e.station_seconds * interval '1 second') DESC, a.started_at ASC
  `, [id]);
  return {
    examId: exam.id,
    title: exam.title,
    markUnit: unit,
    maxMarks,
    stationCount: stations.length,
    attempts: rows.map((r: any) => {
      const score = Array.isArray(r.grades) ? r.grades.reduce((s: number, g: any) => s + (Number(g?.score) || 0), 0) * unit : null;
      return { uid: r.uid, name: r.name, email: r.email, startedAt: r.startedAt, status: r.status, score, maxMarks };
    }),
  };
}

export async function adminGetPracticalMockAttempt(examId: string, uid: string) {
  const id = validId(examId);
  const { rows: [row] } = await pool.query(`
    SELECT e.id, e.title, e.stations, e.mark_unit, a.answers, a.grades, a.started_at AS "startedAt",
      coalesce(u.display_name, u.email, a.user_uid) AS "name", coalesce(u.email, '') AS "email"
    FROM practical_mock.attempts a
    JOIN practical_mock.exams e ON e.id = a.exam_id
    LEFT JOIN public.users u ON u.uid = a.user_uid
    WHERE a.exam_id = $1 AND a.user_uid = $2
  `, [id, uid]);
  if (!row) throw new PracticalMockError('Attempt not found.', 404);
  const unit = Number(row.mark_unit);
  const stations = (row.stations as StoredPracticalStation[]).map((station, index) => {
    const answer = row.answers?.[index]?.text ?? '';
    const existingGrade: ShortAnswerGrade | null = Array.isArray(row.grades) ? row.grades[index] ?? null : null;
    const autoMcqGrade = isMcqStation(station) ? gradeMcqStation(station, answer) : null;
    const rawGrade = existingGrade ?? autoMcqGrade;
    return {
      index,
      questionType: isMcqStation(station) ? 'mcq' : 'short_answer',
      question: station.question_text,
      images: station.images ?? [],
      options: isMcqStation(station) ? station.options : undefined,
      correctOption: isMcqStation(station) ? station.correct_answer : undefined,
      modelAnswer: station.model_answer,
      rubric: station.rubric.map(p => ({ id: p.id, description: p.description, maxUnits: p.marks, maxMarks: p.marks * unit })),
      answer,
      gradeUnits: rawGrade ? rawGrade.points.map(p => ({ id: p.id, awardedUnits: p.awarded, feedback: p.feedback })) : null,
      feedback: rawGrade?.feedback ?? '',
    };
  });
  return { examId: row.id, title: row.title, uid, name: row.name, email: row.email, markUnit: unit, stations };
}

export async function adminSavePracticalMockGrades(examId: string, uid: string, body: { stations?: Array<{ index: number; feedback?: string; points: Array<{ id: string; awardedUnits: number; feedback?: string }> }> }) {
  const id = validId(examId);
  const { rows: [row] } = await pool.query(`
    SELECT e.stations, e.mark_unit, a.answers
    FROM practical_mock.attempts a JOIN practical_mock.exams e ON e.id = a.exam_id
    WHERE a.exam_id = $1 AND a.user_uid = $2
  `, [id, uid]);
  if (!row) throw new PracticalMockError('Attempt not found.', 404);
  const examStations = row.stations as StoredPracticalStation[];
  const byIndex = new Map((body?.stations ?? []).map(s => [s.index, s]));
  const grades: ShortAnswerGrade[] = examStations.map((station, index) => {
    const rawAnswer = row.answers?.[index]?.text ?? '';
    if (isMcqStation(station)) return gradeMcqStation(station, rawAnswer);
    const submitted = byIndex.get(index);
    const pts = station.rubric.map(rule => {
      const match = submitted?.points?.find(p => p.id === rule.id);
      const awarded = Math.max(0, Math.min(rule.marks, Math.round(Number(match?.awardedUnits ?? 0))));
      return { ...rule, awarded, feedback: typeof match?.feedback === 'string' ? match.feedback.slice(0, 700) : '' };
    });
    const score = pts.reduce((s, p) => s + p.awarded, 0);
    const maxScore = pts.reduce((s, p) => s + p.marks, 0);
    return { score, maxScore, feedback: typeof submitted?.feedback === 'string' && submitted.feedback.trim() ? submitted.feedback.trim().slice(0, 1500) : 'Graded by instructor.', points: pts };
  });
  await pool.query(`
    UPDATE practical_mock.attempts
    SET grades = $3::jsonb, grade_progress = '{}'::jsonb, grade_available_at = NULL, grade_error = NULL, grade_failures = 0, retry_at = NULL, lease = NULL, lease_until = NULL
    WHERE exam_id = $1 AND user_uid = $2
  `, [id, uid, JSON.stringify(grades)]);
  const unit = Number(row.mark_unit);
  return { saved: true, score: grades.reduce((s, g) => s + g.score, 0) * unit, maxScore: grades.reduce((s, g) => s + g.maxScore, 0) * unit };
}
