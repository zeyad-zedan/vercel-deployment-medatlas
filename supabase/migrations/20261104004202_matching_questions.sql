-- Additive, nullable columns: existing MCQs, sessions and bookmarks are untouched.
SET lock_timeout = '5s';
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS matching jsonb;
ALTER TABLE public.question_attempts ADD COLUMN IF NOT EXISTS matching_choice_id text;
ALTER TABLE public.questions ADD CONSTRAINT questions_matching_object CHECK (matching IS NULL OR jsonb_typeof(matching) = 'object') NOT VALID;
