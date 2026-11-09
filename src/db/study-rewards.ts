import { pool } from './index.ts';
import type { PoolClient } from 'pg';
import { dailyGoalTargets, type DailyGoal, type DailyGoalTarget, type Tournament, type TournamentBoard, type TournamentRank } from '../lib/study-rewards.ts';

export class StudyRewardsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

async function withStudentRewardsLock<T>(uid: string, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('study-rewards:' || $1, 0))", [uid]);
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getDailyGoal(uid: string, runner: Pick<typeof pool, 'query'> = pool): Promise<DailyGoal> {
  const { rows: [goal] } = await runner.query<DailyGoal>(`
    WITH local_day AS (
      SELECT (statement_timestamp() AT TIME ZONE 'Africa/Cairo')::date AS today
    ), completed AS (
      SELECT study_day, study_day - (row_number() OVER (ORDER BY study_day))::int AS run
      FROM gamification.study_days WHERE user_uid = $1 AND answered >= target
    ), streaks AS (
      SELECT count(*)::int AS length, max(study_day) AS last_day FROM completed GROUP BY run
    )
    SELECT coalesce(d.target, p.target, 10)::int AS target,
      coalesce(p.target, 10)::int AS "nextTarget", coalesce(d.answered, 0) AS answered,
      coalesce((SELECT max(length) FROM streaks WHERE last_day >= today - 1), 0) AS "currentStreak",
      coalesce((SELECT max(length) FROM streaks), 0) AS "bestStreak",
      (today + 1)::timestamp AT TIME ZONE 'Africa/Cairo' AS "resetsAt"
    FROM local_day
    LEFT JOIN gamification.study_days d ON d.user_uid = $1 AND d.study_day = today
    LEFT JOIN gamification.goal_preferences p ON p.user_uid = $1
  `, [uid]);
  return goal;
}

export async function setDailyGoal(uid: string, target: unknown) {
  if (!dailyGoalTargets.includes(target as DailyGoalTarget)) {
    throw new StudyRewardsError('Choose a goal of 5, 10, or 20 questions.');
  }
  return withStudentRewardsLock(uid, async client => {
    await client.query(`
      INSERT INTO gamification.goal_preferences (user_uid, target) VALUES ($1, $2)
      ON CONFLICT (user_uid) DO UPDATE SET target = excluded.target
    `, [uid, target]);
    return getDailyGoal(uid, client);
  });
}

const tournamentFields = `id, title, starts_at AS "startsAt", ends_at AS "endsAt",
  CASE WHEN starts_at > statement_timestamp() THEN 'upcoming'
       WHEN ends_at <= statement_timestamp() THEN 'completed' ELSE 'active' END AS status`;

export async function getTournamentBoard(uid: string, tournamentId?: number): Promise<TournamentBoard> {
  const { rows: tournaments } = await pool.query<Tournament>(`
    SELECT ${tournamentFields} FROM gamification.tournaments
    ORDER BY CASE WHEN id = $1 THEN -1
                  WHEN starts_at <= statement_timestamp() AND ends_at > statement_timestamp() THEN 0
                  WHEN starts_at > statement_timestamp() THEN 1 ELSE 2 END,
             CASE WHEN starts_at > statement_timestamp() THEN starts_at END,
             starts_at DESC LIMIT 12
  `, [tournamentId ?? null]);
  const tournament = tournamentId ? tournaments.find(event => event.id === tournamentId) : tournaments[0];
  if (tournamentId && !tournament) throw new StudyRewardsError('Tournament not found.', 404);
  if (!tournament) return { tournaments, tournament: null, leaders: [], ownRank: null, participantCount: 0 };

  const { rows: [board] } = await pool.query<Pick<TournamentBoard, 'leaders' | 'ownRank' | 'participantCount'>>(`
    WITH member AS (
      SELECT nickname, points FROM gamification.entries WHERE tournament_id = $1 AND user_uid = $2
    ), top_entries AS (
      SELECT nickname, points FROM gamification.entries
      WHERE tournament_id = $1 AND EXISTS (SELECT 1 FROM member)
      ORDER BY points DESC, nickname LIMIT 25
    ), leaders AS (
      SELECT rank() OVER (ORDER BY points DESC)::int AS rank, nickname, points FROM top_entries
    ), own AS (
      SELECT (1 + (SELECT count(*) FROM gamification.entries ahead
                    WHERE ahead.tournament_id = $1 AND ahead.points > entry.points))::int AS rank,
             nickname, points
      FROM member entry
    )
    SELECT coalesce((SELECT jsonb_agg(to_jsonb(leaders) ORDER BY rank, nickname) FROM leaders), '[]') AS leaders,
      (SELECT to_jsonb(own) FROM own) AS "ownRank",
      CASE WHEN EXISTS (SELECT 1 FROM member)
        THEN (SELECT count(*)::int FROM gamification.entries WHERE tournament_id = $1)
        ELSE 0 END AS "participantCount"
  `, [tournament.id, uid]);
  return { tournaments, tournament, ...board };
}

export async function joinTournament(uid: string, id: number, value: unknown) {
  const nickname = typeof value === 'string' ? value.normalize('NFKC').trim().replace(/ +/g, ' ') : '';
  if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} _-]{2,23}$/u.test(nickname)) {
    throw new StudyRewardsError('Use 3–24 letters, numbers, spaces, hyphens, or underscores for your nickname.');
  }
  try {
    await withStudentRewardsLock(uid, async client => {
      const result = await client.query(`
        INSERT INTO gamification.entries (tournament_id, user_uid, nickname)
        SELECT id, $2, $3 FROM gamification.tournaments WHERE id = $1 AND ends_at > clock_timestamp()
        ON CONFLICT (tournament_id, user_uid) DO NOTHING
      `, [id, uid, nickname]);
      if (!result.rowCount) {
        const existing = await client.query('SELECT 1 FROM gamification.entries WHERE tournament_id = $1 AND user_uid = $2', [id, uid]);
        if (!existing.rowCount) throw new StudyRewardsError('This tournament is closed for entry.', 409);
      }
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new StudyRewardsError('That nickname is taken. Try another one.', 409);
    throw error;
  }
  return getTournamentBoard(uid, id);
}

const cairoInput = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export async function createTournament(value: unknown) {
  const input = value as { title?: unknown; startsAt?: unknown; endsAt?: unknown } | null;
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (title.length < 3 || title.length > 80) throw new StudyRewardsError('Enter a tournament name with 3–80 characters.');
  const { startsAt, endsAt } = input ?? {};
  if (typeof startsAt !== 'string' || typeof endsAt !== 'string' ||
      !cairoInput.test(startsAt) || !cairoInput.test(endsAt) || startsAt >= endsAt) {
    throw new StudyRewardsError('Choose an end time after the start time.');
  }
  try {
    const { rows } = await pool.query<{ id: number }>(`
      INSERT INTO gamification.tournaments (title, starts_at, ends_at)
      SELECT $1, $2::timestamp AT TIME ZONE 'Africa/Cairo', $3::timestamp AT TIME ZONE 'Africa/Cairo'
      WHERE $3::timestamp AT TIME ZONE 'Africa/Cairo' > statement_timestamp()
      RETURNING id
    `, [title, startsAt, endsAt]);
    if (!rows.length) throw new StudyRewardsError('Choose an end time in the future.');
    return rows[0];
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === '23P01') throw new StudyRewardsError('These dates overlap with another tournament.', 409);
    if (code === '22007' || code === '22008' || code === '23514') throw new StudyRewardsError('Choose valid Cairo start and end times.');
    throw error;
  }
}
