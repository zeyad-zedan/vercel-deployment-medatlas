-- Existing accounts retain their names and skip onboarding. New accounts must
-- explicitly complete a profile, including accounts created by an older app.
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS faculty text NOT NULL DEFAULT 'Benha University';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS profile_completed boolean NOT NULL DEFAULT true;
ALTER TABLE public.users ALTER COLUMN profile_completed SET DEFAULT false;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.users'::regclass AND conname = 'users_faculty_allowed') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_faculty_allowed CHECK (faculty = 'Benha University');
  END IF;
END $$;
