ALTER TABLE practical_mock.exams
  DROP CONSTRAINT exams_stations_check,
  ADD CONSTRAINT exams_stations_check
    CHECK (jsonb_typeof(stations) = 'array' AND jsonb_array_length(stations) BETWEEN 1 AND 25);
