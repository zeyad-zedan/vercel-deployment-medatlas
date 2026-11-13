import { randomUUID } from 'node:crypto';
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
    WHERE CASE WHEN $3::uuid IS NULL THEN NOT e.unlisted ELSE e.id=$3 END
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
    INSERT INTO practical_mock.attempts (exam_id, user_uid)
    SELECT id, $2 FROM practical_mock.exams WHERE id=$1
    ON CONFLICT (exam_id, user_uid) DO NOTHING
  `, [validId(examId), uid]);
  return readPracticalMock(uid, examId);
}

export async function readPracticalMock(uid: string, examId: string): Promise<PracticalMockAttempt> {
  const { rows: [row] } = await pool.query(`
    WITH attempt AS MATERIALIZED (
      SELECT e.title, e.stations, a.*, clock_timestamp() AS server_now,
        ${effectiveStart} AS effective_start,
        jsonb_array_length(e.stations) AS station_count
      FROM practical_mock.attempts a JOIN practical_mock.exams e ON e.id=a.exam_id
      WHERE a.exam_id=$1 AND a.user_uid=$2
    ), timing AS (
      SELECT *, floor(extract(epoch FROM (server_now - effective_start)) / $3::int)::int AS idx FROM attempt
    )
    SELECT title, station_count, idx, grades, grade_error,
      greatest(0, ceil(extract(epoch FROM (retry_at - server_now))*1000))::int AS retry_ms,
      (lease_until > server_now) IS TRUE AS grading,
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

export async function savePracticalMockAnswer(uid: string, examId: string, value: { stationIndex?: unknown; answer?: unknown; revision?: unknown }) {
  const { stationIndex, answer, revision } = value ?? {};
  if (typeof stationIndex !== 'number' || !Number.isInteger(stationIndex) || stationIndex < 0 || stationIndex >= maxPracticalStations ||
    typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || revision >= 2147483647 ||
    typeof answer !== 'string' || answer.length > maxPracticalAnswerLength) throw new PracticalMockError('Invalid station or answer.');
  const { rowCount } = await pool.query(`
    UPDATE practical_mock.attempts a
    SET answers=jsonb_set(a.answers, ARRAY[$3::int::text], jsonb_build_object('text',$4::text,'revision',$5::int+1))
    FROM practical_mock.exams e
    WHERE a.exam_id=$1 AND a.user_uid=$2 AND e.id=a.exam_id AND $3 < jsonb_array_length(e.stations)
      AND clock_timestamp() >= ${effectiveStart} + $3 * $6::interval
      AND clock_timestamp() < ${effectiveStart} + ($3+1) * $6::interval
      AND coalesce((a.answers->$3::int::text->>'revision')::int,0)=$5
  `, [validId(examId), uid, stationIndex, answer, revision, stationInterval]);
  if (!rowCount) throw new PracticalMockError('This station closed or its answer changed in another tab.', 409);
  return { revision: revision + 1 };
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
      (($3::int + 1)::bigint * $4::int * 1000) - floor(extract(epoch FROM (clock.now - a.started_at)) * 1000)::bigint)
    FROM practical_mock.exams e, clock
    WHERE a.exam_id=$1 AND a.user_uid=$2 AND e.id=a.exam_id AND a.grades IS NULL
      AND $3 < jsonb_array_length(e.stations)
      AND clock.now >= ${effectiveStart} + $3 * $5::interval
      AND clock.now < ${effectiveStart} + ($3 + 1) * $5::interval
  `, [validId(examId), uid, stationIndex, practicalStationSeconds, stationInterval]);
  if (!rowCount) throw new PracticalMockError('This station has already closed.', 409);
  return readPracticalMock(uid, examId);
}

function emptyGrade(station: ShortAnswerDefinition): ShortAnswerGrade {
  return { score: 0, maxScore: studentStation(station).maxMarks, feedback: 'No answer was saved for this station.',
    points: station.rubric.map(point => ({ ...point, awarded: 0, feedback: 'Unanswered.' })) };
}

export async function gradePracticalMock(uid: string, examId: string) {
  const lease = randomUUID();
  const { rows: [claimed] } = await pool.query<{ stations: ShortAnswerDefinition[]; answers: ExamAnswers }>(`
    UPDATE practical_mock.attempts a SET lease=$3, lease_until=clock_timestamp()+interval '35 seconds', grade_error=NULL
    FROM practical_mock.exams e
    WHERE a.exam_id=$1 AND a.user_uid=$2 AND e.id=a.exam_id AND a.grades IS NULL
      AND clock_timestamp() >= ${effectiveStart} + jsonb_array_length(e.stations) * $4::interval
      AND (a.lease_until IS NULL OR a.lease_until <= clock_timestamp())
      AND (a.retry_at IS NULL OR a.retry_at <= clock_timestamp())
    RETURNING e.stations, a.answers
  `, [validId(examId), uid, lease, stationInterval]);
  if (!claimed) {
    const current = await readPracticalMock(uid, examId);
    if (current.status === 'active') throw new PracticalMockError('Grading starts after the final station closes.', 409);
    return current;
  }

  let grades: ShortAnswerGrade[];
  try {
    const answered = claimed.stations.map((question, index) => ({ index, question, answer: claimed.answers[index]?.text.trim() ?? '' }))
      .filter(station => station.answer);
    grades = claimed.stations.map(emptyGrade);
    if (answered.length) {
      const result = await gradeWithAvailableCredentials(uid, (key, deadline) => gradePracticalStationsWithGemini(key, answered, deadline));
      for (const { index, grade } of result.grade) grades[index] = grade;
    }
  } catch (error) {
    const failure = error instanceof GradingError ? error : new GradingError('UNAVAILABLE', 15);
    const message = failure.code === 'KEY_MISSING' ? 'Add your Gemini API key in Profile & Settings, then retry grading.'
      : 'Grading is temporarily unavailable. Your answers are saved. Try again when grading is available.';
    await pool.query(`UPDATE practical_mock.attempts SET lease=NULL, lease_until=NULL, grade_error=$4,
      retry_at=clock_timestamp()+$5::int*interval '1 second' WHERE exam_id=$1 AND user_uid=$2 AND lease=$3`,
    [examId, uid, lease, message, failure.delaySeconds]);
    return readPracticalMock(uid, examId);
  }
  await pool.query(`UPDATE practical_mock.attempts SET grades=$4::jsonb, lease=NULL, lease_until=NULL, retry_at=NULL
    WHERE exam_id=$1 AND user_uid=$2 AND lease=$3`, [examId, uid, lease, JSON.stringify(grades)]);
  return readPracticalMock(uid, examId);
}
