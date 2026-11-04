SET lock_timeout='5s';
ALTER TABLE public.short_answer_attempts ADD COLUMN excluded_from_quiz_progress boolean NOT NULL DEFAULT false;
ALTER TABLE public.question_attempts ADD COLUMN grading_status text;
ALTER TABLE public.questions ADD COLUMN short_answer_id integer REFERENCES public.short_answer_questions(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX questions_short_answer_id_unique ON public.questions(short_answer_id);
ALTER TABLE public.questions ADD COLUMN short_answer_max_marks integer NOT NULL DEFAULT 1 CHECK(short_answer_max_marks BETWEEN 1 AND 100);
-- Add quiz entries without replacing any existing question, answer or bookmark IDs.
INSERT INTO public.questions(subject_id,lecture_id,question_bank_id,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty,tags,images,status,content_hash,short_answer_id,short_answer_max_marks)
SELECT l.subject_id,sa.lecture_id,(SELECT id FROM public.question_banks WHERE lecture_id=sa.lecture_id ORDER BY id LIMIT 1),
 sa.definition->>'question_text','','','','','A','','Medium',
 COALESCE((SELECT string_agg(tag,', ') FROM jsonb_array_elements_text(COALESCE(sa.definition->'tags','[]'::jsonb)) tag),''),
 COALESCE(sa.definition->'images','[]'::jsonb),sa.status,'short-answer:'||sa.id,sa.id,sa.max_score
FROM public.short_answer_questions sa JOIN public.lectures l ON l.id=sa.lecture_id
ON CONFLICT(short_answer_id) DO NOTHING;
