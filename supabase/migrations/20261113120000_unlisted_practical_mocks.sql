ALTER TABLE practical_mock.exams
  ADD COLUMN IF NOT EXISTS unlisted boolean NOT NULL DEFAULT false;
