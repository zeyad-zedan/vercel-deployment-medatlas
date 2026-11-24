-- Add safe status-based tournament cancellation, exclude cancelled events from overlap & scoring,
-- and harden gamification schema privileges and Row Level Security.

ALTER TABLE gamification.tournaments
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

DO $$
DECLARE
  excl_name text;
BEGIN
  FOR excl_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'gamification.tournaments'::regclass
      AND contype = 'x'
  LOOP
    EXECUTE format('ALTER TABLE gamification.tournaments DROP CONSTRAINT %I', excl_name);
  END LOOP;
END
$$;

ALTER TABLE gamification.tournaments
  ADD CONSTRAINT tournaments_active_window_excl
  EXCLUDE USING gist (tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (cancelled_at IS NULL);

CREATE OR REPLACE FUNCTION gamification.record_answers(
  student text, session_id integer, question_ids integer[], count_for_goal boolean, award_tournament_points boolean
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
AS $$
DECLARE
  recorded_at timestamptz;
  today date;
  new_answers integer;
  remaining integer;
  eligible_ids integer[];
BEGIN
  -- Historical sessions may predate their local account record.
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE uid = student) THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('study-rewards:' || student, 0));
  recorded_at := clock_timestamp();
  today := (recorded_at AT TIME ZONE 'Africa/Cairo')::date;

  SELECT array_agg(a.question_id) INTO eligible_ids
  FROM public.question_attempts a
  WHERE a.session_id = record_answers.session_id AND a.user_uid = student
    AND a.question_id = ANY(question_ids) AND a.selected_option IS NOT NULL;

  IF eligible_ids IS NULL THEN RETURN; END IF;

  IF count_for_goal THEN
    INSERT INTO gamification.study_days (user_uid, study_day, target)
    VALUES (student, today, COALESCE((SELECT target FROM gamification.goal_preferences WHERE user_uid = student), 10))
    ON CONFLICT DO NOTHING;

    SELECT target - answered INTO remaining FROM gamification.study_days
    WHERE user_uid = student AND study_day = today;

    IF remaining > 0 THEN
      INSERT INTO gamification.daily_questions (user_uid, study_day, question_id)
      SELECT student, today, id FROM unnest(eligible_ids) AS ids(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM gamification.daily_questions
        WHERE user_uid = student AND study_day = today AND question_id = ids.id
      )
      ORDER BY id LIMIT remaining
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS new_answers = ROW_COUNT;

      IF new_answers > 0 THEN
        UPDATE gamification.study_days SET answered = answered + new_answers
        WHERE user_uid = student AND study_day = today;
      END IF;
    END IF;
  END IF;

  IF NOT award_tournament_points THEN RETURN; END IF;

  WITH earned AS (
    INSERT INTO gamification.awards (tournament_id, user_uid, question_id, points)
    SELECT t.id, student, q.id,
      CASE lower(q.difficulty) WHEN 'easy' THEN 2 WHEN 'hard' THEN 5 ELSE 3 END
    FROM gamification.tournaments t
    JOIN gamification.entries e ON e.tournament_id = t.id AND e.user_uid = student
    JOIN public.question_attempts a ON a.session_id = record_answers.session_id
      AND a.user_uid = student AND a.question_id = ANY(eligible_ids)
    JOIN public.questions q ON q.id = a.question_id
    WHERE t.cancelled_at IS NULL
      AND t.starts_at <= recorded_at AND t.ends_at > recorded_at AND e.joined_at <= recorded_at
      AND a.is_correct AND (a.grading_status IS NULL OR a.grading_status = 'graded')
    ON CONFLICT DO NOTHING
    RETURNING tournament_id, points
  ), totals AS (
    SELECT tournament_id, sum(points)::integer AS points FROM earned GROUP BY tournament_id
  )
  UPDATE gamification.entries e SET points = e.points + totals.points
  FROM totals WHERE e.tournament_id = totals.tournament_id AND e.user_uid = student;
END;
$$;

ALTER TABLE gamification.tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE gamification.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE gamification.awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE gamification.goal_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE gamification.study_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE gamification.daily_questions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA gamification FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA gamification FROM PUBLIC;
REVOKE ALL ON FUNCTION gamification.record_answers(text, integer, integer[], boolean, boolean) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA gamification FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA gamification FROM anon;
    REVOKE ALL ON FUNCTION gamification.record_answers(text, integer, integer[], boolean, boolean) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA gamification FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA gamification FROM authenticated;
    REVOKE ALL ON FUNCTION gamification.record_answers(text, integer, integer[], boolean, boolean) FROM authenticated;
  END IF;
END
$$;
