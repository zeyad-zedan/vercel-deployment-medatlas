import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { tournamentsEnabled } from './study-rewards.ts';

const local = /^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '');
const { pool } = await import('../db/index.ts');
const rewards = await import('../db/study-rewards.ts');
const repo = await import('../db/repository.ts');
after(() => pool.end());

test('study goals and bookmarks survive retries, exam submissions and resets while the tournament flag controls scoring', { skip: !local }, async () => {
  const uid = `rewards-${randomUUID()}`;
  const peer = `${uid}-peer`;
  let subjectId: number | undefined;
  let tournamentId: number | undefined;
  try {
    await pool.query(`INSERT INTO public.users (uid,email,display_name)
      SELECT uid,uid || '@example.invalid','Rewards test' FROM unnest($1::text[]) AS ids(uid)`, [[uid, peer]]);
    const subject = await pool.query<{ id: number }>("INSERT INTO public.subjects (slug,title,description) VALUES ($1,$2,'Test fixture') RETURNING id", [uid, 'Rewards fixture']);
    subjectId = subject.rows[0].id;
    const lecture = await pool.query<{ id: number }>("INSERT INTO public.lectures (subject_id,title,description) VALUES ($1,$2,'Test fixture') RETURNING id", [subjectId, 'Rewards lecture']);
    const lectureId = lecture.rows[0].id;
    const { rows: questions } = await pool.query<{ id: number }>(`
      INSERT INTO public.questions (subject_id,lecture_id,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty,content_hash)
      SELECT $1,$2,'Rewards fixture ' || n,'Yes','No','Other','Unknown','A','Explanation',difficulty,$3 || n
      FROM unnest(ARRAY['Easy','Medium','Hard','Easy','Medium','Hard']) WITH ORDINALITY AS items(difficulty,n)
      RETURNING id
    `, [subjectId, lectureId, uid]);
    repo.invalidateCatalogCache();
    const { rows: [tournament] } = await pool.query<{ id: number }>(`
      INSERT INTO gamification.tournaments (title,starts_at,ends_at)
      VALUES ('Rewards test',now()-interval '1 minute',now()+interval '1 minute') RETURNING id
    `);
    tournamentId = tournament.id;
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
    const first = (await start('study')).session;
    assert.deepEqual((await rewards.getDailyGoal(uid)).currentStreak, 2);
    await answer(first.id, questions[0].id, true);
    assert.equal((await rewards.getTournamentBoard(uid, tournament.id)).ownRank, null);
    await rewards.joinTournament(uid, tournament.id, 'Test Atlas');
    await assert.rejects(rewards.joinTournament(peer, tournament.id, 'test atlas'), /nickname is taken/);
    await rewards.joinTournament(peer, tournament.id, 'Test Nile');
    await repo.completeExamSession(uid, first.id);
    assert.equal((await rewards.getTournamentBoard(uid, tournament.id)).ownRank?.points, 0);

    const practice = (await start('custom')).session;
    await Promise.all([answer(practice.id, questions[0].id, true), answer(practice.id, questions[0].id, true)]);
    await answer(practice.id, questions[1].id, false);
    const afterWrong = await rewards.getDailyGoal(uid);
    assert.equal(afterWrong.answered, 2);
    assert.equal((await rewards.getTournamentBoard(uid, tournament.id)).ownRank?.points, tournamentsEnabled ? 2 : 0);
    assert.equal((await rewards.setDailyGoal(uid, 20)).target, 5);
    assert.equal((await rewards.getDailyGoal(uid)).nextTarget, 20);

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
    assert.equal((await rewards.getTournamentBoard(uid, tournament.id)).ownRank?.points, tournamentsEnabled ? 20 : 0);
    const peerExam = (await start('exam', peer)).session;
    await repo.completeExamSession(peer, peerExam.id, finalAnswers);
    if (!tournamentsEnabled) {
      assert.equal((await rewards.getTournamentBoard(peer, tournament.id)).ownRank?.points, 0);
      // Seed existing standings via the scoring branch. A later study answer must preserve them.
      for (const [student, sessionId] of [[uid, exam.id], [peer, peerExam.id]] as const) {
        await pool.query('SELECT gamification.record_answers($1, $2, $3::int[], false, true)',
          [student, sessionId, questions.map(question => question.id)]);
      }
    }
    assert.deepEqual((await rewards.getTournamentBoard(uid, tournament.id)).leaders.map(entry => entry.rank), [1, 1]);
    const locked = await rewards.getTournamentBoard(`${uid}-outsider`, tournament.id);
    assert.deepEqual(locked.leaders, []);
    assert.equal(locked.ownRank, null);
    assert.equal(locked.participantCount, 0);

    await repo.toggleBookmarkForStudent(uid, questions[0].id, undefined, true);
    await repo.resetLectureProgress(uid, lectureId);
    const replay = (await start('study')).session;
    await answer(replay.id, questions[0].id, true);
    assert.equal(replay.questions.find((q: { id: number }) => q.id === questions[0].id)?.isBookmarked, true);
    assert.equal((await rewards.getDailyGoal(uid)).answered, 5);
    assert.equal((await rewards.getTournamentBoard(uid, tournament.id)).ownRank?.points, 20);
    assert.equal((await rewards.getTournamentBoard(peer, tournament.id)).ownRank?.points, 20);

    await pool.query("UPDATE gamification.tournaments SET ends_at=now()-interval '1 second' WHERE id=$1", [tournament.id]);
    const finished = await rewards.getTournamentBoard(uid, tournament.id);
    assert.equal(finished.tournament?.status, 'completed');
    assert.equal(finished.leaders.length, 2);
    assert.deepEqual((await rewards.getTournamentBoard(`${uid}-outsider`, tournament.id)).leaders, []);
    await assert.rejects(rewards.joinTournament('late-student', tournament.id, 'Too Late'), /closed for entry/);
    const { createEncryptedBackup, testRestoreBackup } = await import('./backup-service.ts');
    const restored = await testRestoreBackup((await createEncryptedBackup()).envelope);
    assert.equal(restored.status, 'verified', restored.error ?? restored.reason);
    assert.ok(restored.tableCounts.tournamentAwards >= 12);
    assert.ok(restored.tableCounts.dailyQuestions >= 10);
  } finally {
    if (tournamentId) await pool.query('DELETE FROM gamification.tournaments WHERE id=$1', [tournamentId]);
    await pool.query('DELETE FROM public.bookmarks WHERE user_uid=ANY($1)', [[uid, peer]]);
    await pool.query('DELETE FROM public.exam_sessions WHERE user_uid=ANY($1)', [[uid, peer]]);
    await pool.query('DELETE FROM public.users WHERE uid=ANY($1)', [[uid, peer]]);
    if (subjectId) await pool.query('DELETE FROM public.subjects WHERE id=$1', [subjectId]);
    repo.invalidateCatalogCache();
  }
});
