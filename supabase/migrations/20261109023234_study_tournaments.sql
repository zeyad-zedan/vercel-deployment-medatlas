CREATE SCHEMA gamification;
REVOKE ALL ON SCHEMA gamification FROM PUBLIC;

CREATE TABLE gamification.tournaments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  CHECK (starts_at < ends_at),
  EXCLUDE USING gist (tstzrange(starts_at, ends_at, '[)') WITH &&)
);

CREATE TABLE gamification.entries (
  tournament_id integer REFERENCES gamification.tournaments(id) ON DELETE CASCADE,
  user_uid text REFERENCES public.users(uid) ON DELETE CASCADE,
  nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 3 AND 24),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  points integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  PRIMARY KEY (tournament_id, user_uid)
);
CREATE UNIQUE INDEX tournament_nickname_unique ON gamification.entries (tournament_id, lower(nickname));
CREATE INDEX tournament_leaderboard ON gamification.entries (tournament_id, points DESC, nickname);
CREATE INDEX tournament_entry_owner ON gamification.entries (user_uid);

-- IDs are deliberately independent of attempts and question deletion so earned points stay fixed.
CREATE TABLE gamification.awards (
  tournament_id integer,
  user_uid text,
  question_id integer,
  points smallint NOT NULL CHECK (points IN (2, 3, 5)),
  PRIMARY KEY (tournament_id, user_uid, question_id),
  FOREIGN KEY (tournament_id, user_uid) REFERENCES gamification.entries ON DELETE CASCADE
);

CREATE TABLE gamification.goal_preferences (
  user_uid text PRIMARY KEY REFERENCES public.users(uid) ON DELETE CASCADE,
  target smallint NOT NULL CHECK (target IN (5, 10, 20))
);

CREATE TABLE gamification.study_days (
  user_uid text REFERENCES public.users(uid) ON DELETE CASCADE,
  study_day date,
  target smallint NOT NULL CHECK (target IN (5, 10, 20)),
  answered integer NOT NULL DEFAULT 0 CHECK (answered >= 0),
  PRIMARY KEY (user_uid, study_day)
);

CREATE TABLE gamification.daily_questions (
  user_uid text,
  study_day date,
  question_id integer,
  PRIMARY KEY (user_uid, study_day, question_id),
  FOREIGN KEY (user_uid, study_day) REFERENCES gamification.study_days ON DELETE CASCADE
);

-- Called inside the same transaction as an authoritative study answer or exam submission.
CREATE FUNCTION gamification.record_answers(
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
    WHERE t.starts_at <= recorded_at AND t.ends_at > recorded_at AND e.joined_at <= recorded_at
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
REVOKE ALL ON FUNCTION gamification.record_answers(text, integer, integer[], boolean, boolean) FROM PUBLIC;
