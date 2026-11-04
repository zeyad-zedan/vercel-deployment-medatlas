SET lock_timeout = '5s';
ALTER TABLE public.lectures ADD COLUMN content_type text NOT NULL DEFAULT 'lecture';
ALTER TABLE public.lectures ADD CONSTRAINT lectures_content_type_allowed CHECK (content_type IN ('lecture','practical')) NOT VALID;
ALTER TABLE public.lectures VALIDATE CONSTRAINT lectures_content_type_allowed;
-- Existing IDs, question links, sessions, bookmarks and answers remain unchanged.
