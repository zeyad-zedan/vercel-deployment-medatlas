import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import express from 'express';
import { tournamentsEnabled } from './study-rewards.ts';

process.env.NODE_ENV = 'test';
if (!process.env.BACKUP_ENCRYPTION_KEY) {
  process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString('hex');
}

const local = /^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '');
const { pool } = await import('../db/index.ts');
const rewards = await import('../db/study-rewards.ts');
const repo = await import('../db/repository.ts');
after(() => pool.end());

function cairoOffsetInput(minutesFromNow: number): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Africa/Cairo',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(Date.now() + minutesFromNow * 60_000)).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

test('feature flag remains disabled for production safety', () => {
  assert.equal(tournamentsEnabled, false);
});

test('study goals, tournament scoring, concurrency, boundaries, resets, and backup/restore integrity', { skip: !local }, async () => {
  const uid = `rewards-${randomUUID()}`;
  const peer = `${uid}-peer`;
  const third = `${uid}-third`;
  const outsider = `${uid}-outsider`;
  const extraUsers = Array.from({ length: 26 }, (_, i) => `${uid}-crowd-${i}`);
  const allUsers = [uid, peer, third, outsider, ...extraUsers];
  let subjectId: number | undefined;
  const createdTournamentIds: number[] = [];

  try {
    await pool.query(`INSERT INTO public.users (uid,email,display_name)
      SELECT uid,uid || '@example.invalid','Rewards test' FROM unnest($1::text[]) AS ids(uid)`, [allUsers]);
    const subject = await pool.query<{ id: number }>(
      "INSERT INTO public.subjects (slug,title,description) VALUES ($1,$2,'Test fixture') RETURNING id",
      [uid, 'Rewards fixture']
    );
    subjectId = subject.rows[0].id;
    const lecture = await pool.query<{ id: number }>(
      "INSERT INTO public.lectures (subject_id,title,description) VALUES ($1,$2,'Test fixture') RETURNING id",
      [subjectId, 'Rewards lecture']
    );
    const lectureId = lecture.rows[0].id;

    // Include Easy (2), Medium (3), Hard (5) twice => 2 + 3 + 5 + 2 + 3 + 5 = 20
    const { rows: questions } = await pool.query<{ id: number }>(`
      INSERT INTO public.questions (subject_id,lecture_id,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty,content_hash)
      SELECT $1,$2,'Rewards fixture ' || n,'Yes','No','Other','Unknown','A','Explanation',difficulty,$3 || n
      FROM unnest(ARRAY['Easy','Medium','Hard','Easy','Medium','Hard']) WITH ORDINALITY AS items(difficulty,n)
      RETURNING id
    `, [subjectId, lectureId, uid]);
    repo.invalidateCatalogCache();

    // Verify RLS is enabled on all gamification tables
    const { rows: rlsRows } = await pool.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'gamification' AND c.relkind = 'r'
      ORDER BY c.relname
    `);
    assert.equal(rlsRows.length, 6);
    assert.ok(rlsRows.every(row => row.relrowsecurity === true), 'Every gamification table must have RLS enabled');

    // 1. Upcoming tournament boundary: cannot earn points before start
    const upcoming = await rewards.createTournament({
      title: 'Upcoming Boundary Test',
      startsAt: cairoOffsetInput(60),
      endsAt: cairoOffsetInput(180),
    });
    createdTournamentIds.push(upcoming.id);
    await rewards.joinTournament(uid, upcoming.id, 'Early Bird');

    // 2. Active tournament
    const { rows: [tournament] } = await pool.query<{ id: number }>(`
      INSERT INTO gamification.tournaments (title,starts_at,ends_at)
      VALUES ('Rewards test',now()-interval '2 minutes',now()+interval '20 minutes') RETURNING id
    `);
    createdTournamentIds.push(tournament.id);

    await rewards.setDailyGoal(uid, 5);
    await pool.query(`
      INSERT INTO gamification.study_days (user_uid,study_day,target,answered)
      SELECT $1,(now() AT TIME ZONE 'Africa/Cairo')::date - n,5,5
      FROM unnest(ARRAY[1,2,5,6,7,8]) AS offsets(n)
    `, [uid]);

    const start = (mode: 'study' | 'exam' | 'custom', student = uid) => repo.createPracticeOrExamSession(student, {
      mode, lectureIds: [lectureId], shuffleOptions: false, shuffleQuestions: false,
    });
    const answer = (sessionId: number, questionId: number, correct: boolean, student = uid) =>
      repo.saveSessionQuestionAnswer(student, sessionId, questionId, correct ? 'A' : 'B', true, 0, true);

    // 3. Submission BEFORE joining must not award points
    const first = (await start('study')).session;
    assert.deepEqual((await rewards.getDailyGoal(uid)).currentStreak, 2);
    await answer(first.id, questions[0].id, true);
    assert.equal((await rewards.getTournamentBoard(uid, tournament.id)).ownRank, null);
    // Even direct scoring call before joining awards 0
    await pool.query('SELECT gamification.record_answers($1, $2, ARRAY[$3]::int[], false, true)', [uid, first.id, questions[0].id]);

    // 4. Nickname validation, normalization, case-insensitive uniqueness, idempotent re-join, concurrent join race
    await assert.rejects(rewards.joinTournament(uid, tournament.id, 'ab'), /3–24/);
    await assert.rejects(rewards.joinTournament(uid, tournament.id, '!invalid!'), /3–24/);
    await rewards.joinTournament(uid, tournament.id, '  Test   Atlas ');
    await assert.rejects(rewards.joinTournament(peer, tournament.id, 'test atlas'), /nickname is taken/);
    // Idempotent re-join for already-joined user returns existing nickname without error
    const rejoined = await rewards.joinTournament(uid, tournament.id, 'Different Name');
    assert.equal(rejoined.ownRank?.nickname, 'Test Atlas');
    // Concurrent race for same nickname: exactly one wins
    const raceResults = await Promise.allSettled([
      rewards.joinTournament(peer, tournament.id, 'RaceWinner'),
      rewards.joinTournament(third, tournament.id, 'racewinner'),
    ]);
    assert.equal(raceResults.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(raceResults.filter(r => r.status === 'rejected').length, 1);
    const loser = raceResults[0].status === 'rejected' ? peer : third;
    await rewards.joinTournament(loser, tournament.id, 'Test Nile');

    await repo.completeExamSession(uid, first.id);
    assert.equal((await rewards.getTournamentBoard(uid, tournament.id)).ownRank?.points, 0);

    // 5. While tournamentsEnabled === false, normal quiz answers update daily goal but award 0 tournament points
    const practice = (await start('custom')).session;
    await Promise.all([answer(practice.id, questions[0].id, true), answer(practice.id, questions[0].id, true)]);
    await answer(practice.id, questions[1].id, false); // incorrect answer
    const afterWrong = await rewards.getDailyGoal(uid);
    assert.equal(afterWrong.answered, 2);
    assert.equal((await rewards.getTournamentBoard(uid, tournament.id)).ownRank?.points, 0);
    assert.equal((await rewards.setDailyGoal(uid, 20)).target, 5);
    assert.equal((await rewards.getDailyGoal(uid)).nextTarget, 20);

    // 6. Test enabled scoring branch directly: incorrect answer rejected, Easy(2) awarded once even under concurrency
    await Promise.all([
      pool.query('SELECT gamification.record_answers($1, $2, $3::int[], false, true)', [uid, practice.id, [questions[0].id, questions[1].id]]),
      pool.query('SELECT gamification.record_answers($1, $2, $3::int[], false, true)', [uid, practice.id, [questions[0].id, questions[1].id]]),
    ]);
    assert.equal((await rewards.getTournamentBoard(uid, tournament.id)).ownRank?.points, 2, 'Easy=2, wrong=0, concurrent duplicate=0');
    // Upcoming tournament must still have 0 points
    assert.equal((await rewards.getTournamentBoard(uid, upcoming.id)).ownRank?.points, 0, 'Upcoming tournament must not award points');

    // 7. Exam session: draft does not count until completion; all 6 questions (Easy 2 + Med 3 + Hard 5 + NULL 3 + Easy 2 + Hard 5 = 20)
    const exam = (await start('exam')).session;
    const finalAnswers = Object.fromEntries(questions.map(question => [question.id, 'A'] as const));
    await repo.saveSessionQuestionAnswer(uid, exam.id, questions[1].id, 'A', false, 0, true);
    assert.equal((await rewards.getDailyGoal(uid)).answered, 2);
    await repo.completeExamSession(uid, exam.id, finalAnswers);
    await repo.completeExamSession(uid, exam.id, finalAnswers);
    const afterExam = await rewards.getDailyGoal(uid);
    assert.equal(afterExam.answered, 5);
    assert.equal(afterExam.currentStreak, 3);
    assert.equal(afterExam.bestStreak, 4);
    assert.equal((await rewards.getTournamentBoard(uid, tournament.id)).ownRank?.points, 2, 'Disabled flag keeps exam from adding tournament points');

    // Now invoke scoring branch for uid (already has q0=2, so remaining 5 add 18 => total 20), peer (20), third (2)
    await pool.query('SELECT gamification.record_answers($1, $2, $3::int[], false, true)', [uid, exam.id, questions.map(q => q.id)]);
    const peerExam = (await start('exam', peer)).session;
    await repo.completeExamSession(peer, peerExam.id, finalAnswers);
    await pool.query('SELECT gamification.record_answers($1, $2, $3::int[], false, true)', [peer, peerExam.id, questions.map(q => q.id)]);
    const thirdStudy = (await start('study', third)).session;
    await answer(thirdStudy.id, questions[0].id, true, third);
    await pool.query('SELECT gamification.record_answers($1, $2, ARRAY[$3]::int[], false, true)', [third, thirdStudy.id, questions[0].id]);

    // 8. Ties & competition ranking (1, 1, 3) + Top 25 cap with personal rank outside Top 25
    const boardBeforeCrowd = await rewards.getTournamentBoard(uid, tournament.id);
    assert.deepEqual(boardBeforeCrowd.leaders.map(entry => entry.rank), [1, 1, 3]);
    for (let i = 0; i < extraUsers.length; i++) {
      await rewards.joinTournament(extraUsers[i], tournament.id, `CrowdUser${String(i + 1).padStart(2, '0')}`);
    }
    const boardWithCrowd = await rewards.getTournamentBoard(extraUsers[25], tournament.id);
    assert.equal(boardWithCrowd.leaders.length, 25, 'Leaderboard must cap at Top 25');
    assert.equal(boardWithCrowd.participantCount, 29);
    assert.equal(boardWithCrowd.ownRank?.rank, 4, 'All 0-point crowd users tie at rank 4');

    // 9. Non-participant privacy vs Admin spectator view
    const locked = await rewards.getTournamentBoard(outsider, tournament.id);
    assert.deepEqual(locked.leaders, []);
    assert.equal(locked.ownRank, null);
    assert.equal(locked.participantCount, 0);

    const adminSpectator = await rewards.getTournamentBoard(outsider, tournament.id, { isAdmin: true });
    assert.equal(adminSpectator.ownRank, null);
    assert.equal(adminSpectator.leaders.length, 25);
    assert.equal(adminSpectator.participantCount, 29);

    // 10. Reset lecture progress + repeat question: preserves bookmarks, preserves points, awards no extra points
    await repo.toggleBookmarkForStudent(uid, questions[0].id, undefined, true);
    await repo.resetLectureProgress(uid, lectureId);
    const replay = (await start('study')).session;
    await answer(replay.id, questions[0].id, true);
    await pool.query('SELECT gamification.record_answers($1, $2, ARRAY[$3]::int[], false, true)', [uid, replay.id, questions[0].id]);
    assert.equal(replay.questions.find((q: { id: number }) => q.id === questions[0].id)?.isBookmarked, true);
    assert.equal((await rewards.getDailyGoal(uid)).answered, 5);
    assert.equal((await rewards.getTournamentBoard(uid, tournament.id)).ownRank?.points, 20);

    // 11. Finished tournament behavior
    await pool.query("UPDATE gamification.tournaments SET ends_at=now()-interval '2 seconds' WHERE id=$1", [tournament.id]);
    const finished = await rewards.getTournamentBoard(uid, tournament.id);
    assert.equal(finished.tournament?.status, 'completed');
    assert.equal(finished.leaders.length, 25);
    assert.deepEqual((await rewards.getTournamentBoard(outsider, tournament.id)).leaders, []);
    await assert.rejects(rewards.joinTournament(outsider, tournament.id, 'Too Late'), /closed for entry/);
    // Cannot edit or cancel a completed tournament
    await assert.rejects(rewards.updateTournament(tournament.id, {
      title: 'Tamper Completed',
      startsAt: cairoOffsetInput(300),
      endsAt: cairoOffsetInput(400),
    }), /Only upcoming tournaments can be edited/);
    await assert.rejects(rewards.cancelTournament(tournament.id), /Completed tournaments cannot be cancelled/);

    // 12. Edit upcoming tournament + overlap prevention + cancellation + replacement slot
    const edited = await rewards.updateTournament(upcoming.id, {
      title: 'Updated Upcoming Event',
      startsAt: cairoOffsetInput(90),
      endsAt: cairoOffsetInput(210),
    });
    assert.equal(edited.title, 'Updated Upcoming Event');
    assert.equal(edited.status, 'upcoming');

    // Overlapping tournament rejected
    await assert.rejects(rewards.createTournament({
      title: 'Overlapping Event',
      startsAt: cairoOffsetInput(120),
      endsAt: cairoOffsetInput(240),
    }), /overlap/);

    // Cancel upcoming tournament -> releases time window and rejects joins & edits
    const cancelled = await rewards.cancelTournament(upcoming.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.cancelledAt);
    await assert.rejects(rewards.cancelTournament(upcoming.id), /already cancelled/);
    await assert.rejects(rewards.updateTournament(upcoming.id, {
      title: 'Edit Cancelled',
      startsAt: cairoOffsetInput(120),
      endsAt: cairoOffsetInput(240),
    }), /Cancelled tournaments cannot be edited/);
    await assert.rejects(rewards.joinTournament(outsider, upcoming.id, 'LateJoin'), /closed for entry/);

    // Replacement tournament in the previously blocked window now succeeds
    const replacement = await rewards.createTournament({
      title: 'Replacement Live Event',
      startsAt: cairoOffsetInput(120),
      endsAt: cairoOffsetInput(240),
    });
    createdTournamentIds.push(replacement.id);
    // Move replacement to active (after finished tournament ended), verify editing active is rejected, verify cancelling active stops scoring
    await pool.query("UPDATE gamification.tournaments SET starts_at=now()-interval '500 milliseconds' WHERE id=$1", [replacement.id]);
    await assert.rejects(rewards.updateTournament(replacement.id, {
      title: 'Tamper Active',
      startsAt: cairoOffsetInput(300),
      endsAt: cairoOffsetInput(400),
    }), /Only upcoming tournaments can be edited/);
    await rewards.joinTournament(uid, replacement.id, 'CancelCheck');
    await rewards.cancelTournament(replacement.id);
    await pool.query('SELECT gamification.record_answers($1, $2, ARRAY[$3]::int[], false, true)', [uid, replay.id, questions[0].id]);
    assert.equal((await rewards.getTournamentBoard(uid, replacement.id)).ownRank?.points, 0, 'Cancelled tournament must not award points');

    // 13. Backup/restore integrity including cancelled_at, entries, awards, and daily questions
    const { createEncryptedBackup, testRestoreBackup } = await import('./backup-service.ts');
    const restored = await testRestoreBackup((await createEncryptedBackup()).envelope);
    assert.equal(restored.status, 'verified', restored.error ?? restored.reason);
    assert.ok(restored.tableCounts.tournaments >= 3);
    assert.ok(restored.tableCounts.tournamentAwards >= 12);
    assert.ok(restored.tableCounts.dailyQuestions >= 10);
  } finally {
    if (createdTournamentIds.length) {
      await pool.query('DELETE FROM gamification.tournaments WHERE id=ANY($1::int[])', [createdTournamentIds]);
    }
    await pool.query('DELETE FROM public.bookmarks WHERE user_uid=ANY($1)', [allUsers]);
    await pool.query('DELETE FROM public.exam_sessions WHERE user_uid=ANY($1)', [allUsers]);
    await pool.query('DELETE FROM public.users WHERE uid=ANY($1)', [allUsers]);
    if (subjectId) await pool.query('DELETE FROM public.subjects WHERE id=$1', [subjectId]);
    repo.invalidateCatalogCache();
  }
});

test('HTTP API enforces disabled flag on main app, plus auth, admin, lifecycle, privacy, and rate limiting on enabled router', { skip: !local }, async () => {
  const { app, createTournamentsRouter } = await import('../../server.ts');
  const { createServerSessionToken } = await import('../middleware/auth.ts');

  const marker = randomUUID();
  const studentUid = `tourney-student-${marker}`;
  const adminUid = `tourney-admin-${marker}`;
  const createdIds: number[] = [];

  await pool.query(
    "INSERT INTO public.users (uid,email,display_name,role) VALUES ($1,$2,'Student','student'),($3,$4,'Admin','admin')",
    [studentUid, `${studentUid}@example.invalid`, adminUid, `${adminUid}@example.invalid`]
  );

  const studentToken = createServerSessionToken({ uid: studentUid, email: `${studentUid}@example.invalid`, emailVerified: true });
  const adminToken = createServerSessionToken({ uid: adminUid, email: `${adminUid}@example.invalid`, emailVerified: true });

  // 1. Verify main app keeps tournament routes disabled (404) while tournamentsEnabled === false
  const mainServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => mainServer.once('listening', resolve));
  const mainOrigin = `http://127.0.0.1:${(mainServer.address() as any).port}`;

  // 2. Mount isolated enabled router with low rate-limit thresholds to test HTTP behavior & 429 enforcement
  const testApp = express();
  testApp.use(express.json());
  testApp.use(createTournamentsRouter({ readMaxRequests: 20, joinMaxRequests: 3, adminMaxRequests: 15 }));
  const enabledServer = testApp.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => enabledServer.once('listening', resolve));
  const enabledOrigin = `http://127.0.0.1:${(enabledServer.address() as any).port}`;

  const req = async (origin: string, method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(origin + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  try {
    // Main app disabled checks
    assert.equal((await req(mainOrigin, 'GET', '/api/tournaments', studentToken)).status, 404);
    assert.equal((await req(mainOrigin, 'POST', '/api/tournaments/1/join', studentToken, { nickname: 'BlockedUser' })).status, 404);
    assert.equal((await req(mainOrigin, 'GET', '/api/admin/tournaments', adminToken)).status, 404);
    assert.equal((await req(mainOrigin, 'POST', '/api/admin/tournaments', adminToken, { title: 'Blocked' })).status, 404);
    // Daily study goal still works on main app while tournaments are disabled
    const goalRes = await req(mainOrigin, 'GET', '/api/study-goal', studentToken);
    assert.equal(goalRes.status, 200);
    assert.equal(goalRes.data.target, 10);

    // Unauthenticated requests rejected (401)
    assert.equal((await req(enabledOrigin, 'GET', '/api/tournaments')).status, 401);
    assert.equal((await req(enabledOrigin, 'POST', '/api/tournaments/1/join', undefined, { nickname: 'AnonUser' })).status, 401);
    assert.equal((await req(enabledOrigin, 'POST', '/api/admin/tournaments', undefined, { title: 'AnonAdmin' })).status, 401);

    // Student cannot call admin endpoints (403)
    assert.equal((await req(enabledOrigin, 'GET', '/api/admin/tournaments', studentToken)).status, 403);
    assert.equal((await req(enabledOrigin, 'POST', '/api/admin/tournaments', studentToken, {
      title: 'Forbidden',
      startsAt: cairoOffsetInput(600),
      endsAt: cairoOffsetInput(700),
    })).status, 403);

    // Admin creates upcoming tournament
    const created = await req(enabledOrigin, 'POST', '/api/admin/tournaments', adminToken, {
      title: 'HTTP Lifecycle Cup',
      startsAt: cairoOffsetInput(600),
      endsAt: cairoOffsetInput(720),
    });
    assert.equal(created.status, 201);
    const tid = created.data.id as number;
    createdIds.push(tid);

    // Student cannot edit or cancel (403)
    assert.equal((await req(enabledOrigin, 'PATCH', `/api/admin/tournaments/${tid}`, studentToken, {
      title: 'Hijacked',
      startsAt: cairoOffsetInput(610),
      endsAt: cairoOffsetInput(730),
    })).status, 403);
    assert.equal((await req(enabledOrigin, 'POST', `/api/admin/tournaments/${tid}/cancel`, studentToken)).status, 403);

    // Invalid IDs rejected (400)
    assert.equal((await req(enabledOrigin, 'GET', '/api/tournaments?id=abc', studentToken)).status, 400);
    assert.equal((await req(enabledOrigin, 'PATCH', '/api/admin/tournaments/0', adminToken, {})).status, 400);

    // Admin edits upcoming tournament
    const edited = await req(enabledOrigin, 'PATCH', `/api/admin/tournaments/${tid}`, adminToken, {
      title: 'HTTP Lifecycle Cup v2',
      startsAt: cairoOffsetInput(630),
      endsAt: cairoOffsetInput(750),
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.title, 'HTTP Lifecycle Cup v2');

    // Admin lists all tournaments
    const listRes = await req(enabledOrigin, 'GET', '/api/admin/tournaments', adminToken);
    assert.equal(listRes.status, 200);
    assert.ok(listRes.data.tournaments.some((t: any) => t.id === tid));

    // Student joins via HTTP (attempt 1: invalid nickname -> 400; attempt 2: valid -> 200)
    assert.equal((await req(enabledOrigin, 'POST', `/api/tournaments/${tid}/join`, studentToken, { nickname: 'x' })).status, 400);
    const joined = await req(enabledOrigin, 'POST', `/api/tournaments/${tid}/join`, studentToken, { nickname: 'HttpAtlas' });
    assert.equal(joined.status, 200);
    assert.equal(joined.data.ownRank.nickname, 'HttpAtlas');

    // Admin views standings without participating
    const adminBoard = await req(enabledOrigin, 'GET', `/api/tournaments?id=${tid}`, adminToken);
    assert.equal(adminBoard.status, 200);
    assert.equal(adminBoard.data.ownRank, null);
    assert.equal(adminBoard.data.participantCount, 1);
    assert.equal(adminBoard.data.leaders[0].nickname, 'HttpAtlas');

    // Join rate limit enforcement (limit = 3; attempts 1 & 2 used, attempt 3 ok, attempt 4 -> 429)
    await req(enabledOrigin, 'POST', `/api/tournaments/${tid}/join`, studentToken, { nickname: 'HttpAtlas' });
    const throttled = await req(enabledOrigin, 'POST', `/api/tournaments/${tid}/join`, studentToken, { nickname: 'HttpAtlas' });
    assert.equal(throttled.status, 429);

    // Admin cancels tournament
    const cancelled = await req(enabledOrigin, 'POST', `/api/admin/tournaments/${tid}/cancel`, adminToken);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.status, 'cancelled');

    // Admin audit logs recorded create, update, cancel
    const { rows: audits } = await pool.query<{ action: string }>(
      "SELECT action FROM public.admin_audit_logs WHERE admin_uid = $1 AND target_type = 'tournament' ORDER BY id ASC",
      [adminUid]
    );
    assert.deepEqual(audits.map(a => a.action), ['tournament_create', 'tournament_update', 'tournament_cancel']);
  } finally {
    await new Promise<void>((resolve, reject) => mainServer.close(err => err ? reject(err) : resolve()));
    await new Promise<void>((resolve, reject) => enabledServer.close(err => err ? reject(err) : resolve()));
    if (createdIds.length) {
      await pool.query('DELETE FROM gamification.tournaments WHERE id=ANY($1::int[])', [createdIds]);
    }
    await pool.query('DELETE FROM public.admin_audit_logs WHERE admin_uid = $1', [adminUid]);
    await pool.query('DELETE FROM public.rate_limit_buckets WHERE key LIKE $1 OR key LIKE $2', [`%${studentUid}%`, `%${adminUid}%`]);
    await pool.query('DELETE FROM public.users WHERE uid=ANY($1)', [[studentUid, adminUid]]);
  }
});
