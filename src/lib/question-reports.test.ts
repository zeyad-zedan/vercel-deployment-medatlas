import 'dotenv/config';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

process.env.NODE_ENV = 'test';
const { db, pool, users, questions, questionReports, adminAuditLogs, examSessions } = await import('../db/index.ts');
const repository = await import('../db/repository.ts');
const enabled = /^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '');
after(async () => { await pool.end(); });

test('question reports deduplicate, restrict admin access, preserve snapshots, and resolve idempotently', { skip: !enabled }, async () => {
  await repository.ensureSeededDatabase();
  const marker = crypto.randomUUID();
  const studentUid = `report-student-${marker}`;
  const adminUid = `report-admin-${marker}`;
  let questionId: number | undefined;
  try {
    await db.insert(users).values([
      { uid: studentUid, email: `${studentUid}@example.invalid`, displayName: 'Report test student' },
      { uid: adminUid, email: `${adminUid}@example.invalid`, displayName: 'Report test admin', role: 'admin' },
    ]);
    const [base] = await db.select().from(questions).where(eq(questions.status, 'published')).limit(1);
    assert.ok(base);
    const [question] = await db.insert(questions).values({ ...base, id: undefined,
      questionText: 'Temporary report test ' + marker, contentHash: marker }).returning({ id: questions.id });
    questionId = question.id;
    await Promise.all(Array.from({ length: 4 }, () => repository.reportQuestionForStudent(studentUid, question.id, 'wrong_answer')));
    await repository.reportQuestionForStudent(studentUid, question.id, 'outside_syllabus');
    const stored = await db.select().from(questionReports).where(eq(questionReports.userUid, studentUid));
    assert.equal(stored.length, 2);
    await assert.rejects(repository.reportQuestionForStudent(studentUid, question.id, 'other'), error => (error as any).statusCode === 400 || (error as any).status === 400);
    await assert.rejects(repository.getQuestionReportsForAdmin(studentUid));
    const list = await repository.getQuestionReportsForAdmin(adminUid);
    assert.ok(list.reports.some(report => report.questionText === 'Temporary report test ' + marker));
    const reportId = stored[0].id;
    const actor = { uid: adminUid, email: `${adminUid}@example.invalid` };
    await repository.resolveQuestionReportAdmin(actor, reportId);
    await repository.resolveQuestionReportAdmin(actor, reportId);
    const audit = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.adminUid, adminUid));
    assert.equal(audit.length, 1);
    const { createEncryptedBackup, testRestoreBackup } = await import('./backup-service.ts');
    const { envelope } = await createEncryptedBackup();
    assert.ok(envelope.metadata.tables.questionReports >= 2);
    const restore = await testRestoreBackup(envelope);
    assert.equal(restore.status, 'verified');
    await db.update(questions).set({ status: 'archived' }).where(eq(questions.id, question.id));
    await assert.rejects(repository.reportQuestionForStudent(adminUid, question.id, 'wrong_answer'));
    await db.insert(examSessions).values({ userUid: studentUid, title: 'Archived question review', mode: 'study',
      totalQuestions: 1, questionOrderJson: JSON.stringify([{ questionId: question.id }]) });
    assert.equal((await repository.reportQuestionForStudent(studentUid, question.id, 'wrong_answer')).reported, true);
    await db.delete(questions).where(eq(questions.id, question.id));
    questionId = undefined;
    const [retained] = await db.select().from(questionReports).where(eq(questionReports.id, reportId));
    assert.equal(retained.questionId, null);
    assert.equal(retained.questionText, 'Temporary report test ' + marker);
    for (const role of ['anon', 'authenticated']) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(client.query('SELECT * FROM public.question_reports'), error => (error as any).code === '42501');
      } finally { await client.query('ROLLBACK'); client.release(); }
    }
  } finally {
    await db.delete(questionReports).where(eq(questionReports.userUid, studentUid));
    await db.delete(adminAuditLogs).where(eq(adminAuditLogs.adminUid, adminUid));
    await db.delete(examSessions).where(eq(examSessions.userUid, studentUid));
    if (questionId) await db.delete(questions).where(eq(questions.id, questionId));
    await db.delete(users).where(eq(users.uid, studentUid));
    await db.delete(users).where(eq(users.uid, adminUid));
  }
});
