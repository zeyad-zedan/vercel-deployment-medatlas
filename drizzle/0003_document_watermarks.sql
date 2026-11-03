CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  boolean_value boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_settings FROM PUBLIC, anon, authenticated;
INSERT INTO public.app_settings (key, boolean_value)
VALUES ('pdf_watermarks_enabled', false)
ON CONFLICT (key) DO NOTHING;
