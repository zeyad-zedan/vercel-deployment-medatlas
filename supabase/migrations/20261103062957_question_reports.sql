CREATE TABLE IF NOT EXISTS public.question_reports (
  id serial PRIMARY KEY,
  user_uid text NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  question_id integer REFERENCES public.questions(id) ON DELETE SET NULL,
  lecture_id integer REFERENCES public.lectures(id) ON DELETE SET NULL,
  reason text NOT NULL CONSTRAINT question_report_reason_check CHECK (reason IN ('wrong_answer', 'outside_syllabus')),
  question_text text NOT NULL,
  status text NOT NULL DEFAULT 'open' CONSTRAINT question_report_status_check CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text REFERENCES public.users(uid) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_question_report_open ON public.question_reports(user_uid, question_id, reason) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_question_report_status_created ON public.question_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_question_report_user ON public.question_reports(user_uid);
CREATE INDEX IF NOT EXISTS idx_question_report_question ON public.question_reports(question_id);
CREATE INDEX IF NOT EXISTS idx_question_report_lecture ON public.question_reports(lecture_id);
CREATE INDEX IF NOT EXISTS idx_question_report_resolved_by ON public.question_reports(resolved_by);

-- Firebase sessions are authorized by the server. The Data API must not expose student reports.
ALTER TABLE public.question_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.question_reports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.question_reports_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.question_reports TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.question_reports_id_seq TO service_role;
