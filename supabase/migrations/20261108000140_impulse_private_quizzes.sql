-- Separate, non-exposed schema. No changes to MedAtlas students, lectures or bookmarks.
CREATE SCHEMA IF NOT EXISTS impulse;
REVOKE ALL ON SCHEMA impulse FROM PUBLIC, anon, authenticated;
CREATE TABLE impulse.quizzes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL,
 title text NOT NULL, password_hash text NOT NULL, draft jsonb NOT NULL DEFAULT '[]',
 published_version uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE impulse.versions (
 id uuid PRIMARY KEY, quiz_id uuid NOT NULL REFERENCES impulse.quizzes(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE impulse.quizzes ADD CONSTRAINT impulse_published_version_fk FOREIGN KEY(published_version) REFERENCES impulse.versions(id);
CREATE TABLE impulse.questions (
 id uuid PRIMARY KEY, version_id uuid NOT NULL REFERENCES impulse.versions(id),
 position integer NOT NULL CHECK(position>=0), definition jsonb NOT NULL,
 UNIQUE(version_id,position)
);
CREATE TABLE impulse.attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), quiz_id uuid NOT NULL REFERENCES impulse.quizzes(id),
 version_id uuid NOT NULL REFERENCES impulse.versions(id), student_uid text NOT NULL,
 current_position integer NOT NULL DEFAULT 0, completed boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(quiz_id,student_uid)
);
CREATE TABLE impulse.answers (
 attempt_id uuid NOT NULL REFERENCES impulse.attempts(id), question_id uuid NOT NULL REFERENCES impulse.questions(id),
 answer jsonb NOT NULL, result jsonb, status text NOT NULL DEFAULT 'saved',
 lease uuid, lease_until timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(attempt_id,question_id)
);
ALTER TABLE impulse.quizzes ENABLE ROW LEVEL SECURITY;
ALTER TABLE impulse.versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE impulse.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE impulse.attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE impulse.answers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA impulse FROM PUBLIC, anon, authenticated;
CREATE INDEX impulse_versions_quiz ON impulse.versions(quiz_id);
CREATE INDEX impulse_attempts_quiz ON impulse.attempts(quiz_id);
