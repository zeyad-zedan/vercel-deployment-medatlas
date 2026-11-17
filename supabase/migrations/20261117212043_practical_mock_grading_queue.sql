ALTER TABLE practical_mock.attempts
  ADD COLUMN grade_available_at timestamptz,
  ADD COLUMN grade_progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN grade_failures integer NOT NULL DEFAULT 0;

CREATE INDEX practical_mock_grading_due
  ON practical_mock.attempts (grade_available_at, started_at, exam_id, user_uid)
  WHERE grade_available_at IS NOT NULL AND grades IS NULL;
