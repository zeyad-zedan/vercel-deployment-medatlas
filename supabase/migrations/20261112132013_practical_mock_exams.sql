CREATE SCHEMA practical_mock;
REVOKE ALL ON SCHEMA practical_mock FROM PUBLIC, anon, authenticated;

CREATE TABLE practical_mock.exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  stations jsonb NOT NULL CHECK (jsonb_typeof(stations) = 'array' AND jsonb_array_length(stations) BETWEEN 1 AND 12),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE practical_mock.attempts (
  exam_id uuid NOT NULL REFERENCES practical_mock.exams(id),
  user_uid text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  answers jsonb NOT NULL DEFAULT '{}',
  grades jsonb,
  lease uuid,
  lease_until timestamptz,
  retry_at timestamptz,
  grade_error text,
  PRIMARY KEY (exam_id, user_uid)
);

CREATE INDEX practical_mock_attempts_user ON practical_mock.attempts (user_uid);
ALTER TABLE practical_mock.exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE practical_mock.attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA practical_mock FROM PUBLIC, anon, authenticated;
