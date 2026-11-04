SET lock_timeout = '5s';
CREATE TABLE public.short_answer_questions (
 id serial PRIMARY KEY, lecture_id integer NOT NULL REFERENCES public.lectures(id) ON DELETE CASCADE,
 definition jsonb NOT NULL, content_hash text NOT NULL, max_score integer NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(lecture_id,content_hash)
);
CREATE INDEX short_answer_questions_lecture_status ON public.short_answer_questions(lecture_id,status,id);
CREATE TABLE public.short_answer_attempts (
 id serial PRIMARY KEY, user_uid text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
 question_id integer NOT NULL REFERENCES public.short_answer_questions(id) ON DELETE CASCADE,
 answer text NOT NULL, answer_hash text NOT NULL, snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'saved' CHECK(status IN ('saved','grading','graded','failed')),
 result jsonb, error_code text, model text, lease_id text, grade_started_at timestamptz,
 retry_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_uid,question_id,answer_hash)
);
CREATE INDEX short_answer_attempts_owner_question ON public.short_answer_attempts(user_uid,question_id,id DESC);
CREATE INDEX short_answer_attempts_owner_started ON public.short_answer_attempts(user_uid,grade_started_at DESC);
ALTER TABLE public.short_answer_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.short_answer_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.short_answer_questions,public.short_answer_attempts FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.short_answer_questions_id_seq,public.short_answer_attempts_id_seq FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON public.short_answer_questions,public.short_answer_attempts FROM anon;
  REVOKE ALL ON SEQUENCE public.short_answer_questions_id_seq,public.short_answer_attempts_id_seq FROM anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  REVOKE ALL ON public.short_answer_questions,public.short_answer_attempts FROM authenticated;
  REVOKE ALL ON SEQUENCE public.short_answer_questions_id_seq,public.short_answer_attempts_id_seq FROM authenticated;
 END IF;
END $$;
