-- Keep existing exams and attempts at their original timing and integer mark scale.
ALTER TABLE practical_mock.exams
  ADD COLUMN station_seconds integer NOT NULL DEFAULT 120
    CHECK (station_seconds BETWEEN 30 AND 600),
  ADD COLUMN mark_unit numeric NOT NULL DEFAULT 1
    CHECK (mark_unit IN (1, 0.25));

ALTER TABLE practical_mock.exams
  DROP CONSTRAINT exams_stations_check,
  ADD CONSTRAINT exams_stations_check CHECK (
    jsonb_typeof(stations) = 'array' AND jsonb_array_length(stations) BETWEEN 1 AND 26
  );
