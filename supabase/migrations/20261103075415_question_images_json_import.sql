-- Telegram references only. Image bytes never enter PostgreSQL or Supabase Storage.
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS explanation_images jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.questions ADD CONSTRAINT questions_images_array CHECK (jsonb_typeof(images) = 'array' AND jsonb_array_length(images) <= 4);
ALTER TABLE public.questions ADD CONSTRAINT questions_explanation_images_array CHECK (jsonb_typeof(explanation_images) = 'array' AND jsonb_array_length(explanation_images) <= 4);
