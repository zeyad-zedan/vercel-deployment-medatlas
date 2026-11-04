SET lock_timeout = '5s';
CREATE TABLE public.student_gemini_keys (
  user_uid text PRIMARY KEY REFERENCES public.users(uid) ON DELETE CASCADE,
  encrypted_key text NOT NULL,
  key_suffix text NOT NULL CHECK (length(key_suffix) = 4),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.student_gemini_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.student_gemini_keys FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.student_gemini_keys FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.student_gemini_keys FROM authenticated;
  END IF;
END $$;
-- No client policies: access is through the authenticated application server only.
