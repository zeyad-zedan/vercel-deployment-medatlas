ALTER TABLE practical_mock.attempts
  ADD COLUMN IF NOT EXISTS skipped_ms BIGINT NOT NULL DEFAULT 0 CHECK (skipped_ms >= 0);
