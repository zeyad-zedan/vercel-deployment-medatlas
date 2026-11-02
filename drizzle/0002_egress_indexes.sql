-- Run outside a transaction so live student traffic can continue during index creation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attempt_user_question_latest
  ON public.question_attempts(user_uid, question_id, answered_at DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_user_started
  ON public.exam_sessions(user_uid, started_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attempt_answered_at
  ON public.question_attempts(answered_at);
