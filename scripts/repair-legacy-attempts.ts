import 'dotenv/config';
import { pool } from '../src/db/index.ts';

// One-time server-side repair replaces the former repair job on every dashboard request.
// Never downloads session JSON or PDF bytes to this process.
try {
  if (!process.argv.includes('--apply')) throw new Error('Pass --apply to backfill missing saved answers.');
  const result = await pool.query(`
    INSERT INTO question_attempts
      (session_id, user_uid, question_id, subject_id, lecture_id, selected_option,
       correct_option_snapshot, is_correct, question_snapshot_json, time_spent_seconds, answered_at)
    SELECT s.id, s.user_uid, q.id, q.subject_id, q.lecture_id, e->>'selectedCanonical',
      q.correct_answer, (e->>'selectedCanonical') = q.correct_answer,
      jsonb_build_object('id', q.id, 'questionText', q.question_text,
        'optionA', q.option_a, 'optionB', q.option_b, 'optionC', q.option_c, 'optionD', q.option_d,
        'correctAnswer', q.correct_answer, 'explanation', q.explanation,
        'explanationA', q.explanation_a, 'explanationB', q.explanation_b,
        'explanationC', q.explanation_c, 'explanationD', q.explanation_d,
        'subjectTitle', sub.title, 'lectureTitle', lec.title, 'difficulty', q.difficulty,
        'tags', q.tags, 'specialTags', q.special_tags, 'diagramSvg', q.diagram_svg,
        'pageNumber', q.page_number, 'version', q.version)::text, 0, s.started_at
    FROM exam_sessions s CROSS JOIN LATERAL jsonb_array_elements(s.question_order_json::jsonb) e
    JOIN questions q ON q.id = (e->>'questionId')::int
    JOIN subjects sub ON sub.id = q.subject_id JOIN lectures lec ON lec.id = q.lecture_id
    WHERE NOT(s.mode = 'exam' AND s.status = 'in_progress')
      AND e->>'selectedCanonical' IN ('A','B','C','D')
      AND NOT EXISTS (SELECT 1 FROM question_attempts a WHERE a.session_id=s.id AND a.question_id=q.id)
    ON CONFLICT (session_id, question_id) DO NOTHING`);
  console.log(`Backfilled ${result.rowCount} missing saved answers; existing attempts unchanged.`);
} finally { await pool.end(); }
