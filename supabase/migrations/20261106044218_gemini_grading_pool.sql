SET lock_timeout = '5s';
-- Ephemeral coordination only: hashes, timestamps and leases; never API keys or student answers.
CREATE TABLE public.gemini_grading_pool_state (
 model text PRIMARY KEY,
 state jsonb NOT NULL DEFAULT '{"keys":{},"projects":{}}'::jsonb
);
ALTER TABLE public.gemini_grading_pool_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gemini_grading_pool_state FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON public.gemini_grading_pool_state FROM anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  REVOKE ALL ON public.gemini_grading_pool_state FROM authenticated;
 END IF;
END $$;
