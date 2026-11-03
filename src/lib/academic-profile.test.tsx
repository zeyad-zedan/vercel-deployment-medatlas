import 'dotenv/config';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { once } from 'node:events';
import { eq, inArray } from 'drizzle-orm';
import { AVAILABLE_FACULTIES, DEFAULT_FACULTY, validateAcademicProfile } from './academic-profile.ts';
import { AcademicProfileFields } from '../components/AcademicProfileFields.tsx';
import { CompleteProfile } from '../components/CompleteProfile.tsx';

process.env.NODE_ENV = 'test';
const enabled = /^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '');
const { db, pool, users } = await import('../db/index.ts');
const repository = await import('../db/repository.ts');
const { createServerSessionToken } = await import('../middleware/auth.ts');
const run = crypto.randomUUID().replaceAll('-', '');
const created: string[] = [];
after(async () => {
  if (enabled && created.length) await db.delete(users).where(inArray(users.uid, created));
  repository.setFirebaseProvisioningHandlerForTests(null);
  await pool.end();
});

test('profile fields offer only Benha University and support Arabic usernames', () => {
  assert.deepEqual(AVAILABLE_FACULTIES, ['Benha University']);
  assert.equal(validateAcademicProfile('  طالب طب  ', DEFAULT_FACULTY), null);
  for (const username of ['', ' ', 'a', {}, 'x'.repeat(121), 'student\nname']) {
    assert.ok(validateAcademicProfile(username, DEFAULT_FACULTY));
  }
  for (const faculty of ['', null, {}, 'Other University']) {
    assert.ok(validateAcademicProfile('Student', faculty));
  }
  const html = renderToStaticMarkup(<AcademicProfileFields idPrefix="test" username="Student" faculty={DEFAULT_FACULTY} onUsernameChange={() => {}} onFacultyChange={() => {}} />);
  assert.match(html, /Username/);
  assert.match(html, /Faculty/);
  assert.equal((html.match(/<option /g) || []).length, 1);
  assert.match(html, /Benha University/);
  assert.match(renderToStaticMarkup(<CompleteProfile onCompleted={() => {}} onLogout={async () => {}} />), /Save and continue/);
});

test('migration preserves legacy identities and defaults only new accounts to onboarding', { skip: !enabled }, async () => {
  const schema = `academic_migration_${run}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.users (id serial primary key, uid text, display_name text)`);
    await client.query(`INSERT INTO ${schema}.users(uid,display_name) VALUES ('existing-uid','Existing Student')`);
    const sql = fs.readFileSync('supabase/migrations/20261103190330_user_academic_profiles.sql', 'utf8').replaceAll('public.users', `${schema}.users`);
    await client.query(sql);
    const legacy = (await client.query(`SELECT * FROM ${schema}.users`)).rows[0];
    assert.deepEqual(legacy, { id: 1, uid: 'existing-uid', display_name: 'Existing Student', faculty: DEFAULT_FACULTY, profile_completed: true });
    const fresh = (await client.query(`INSERT INTO ${schema}.users(uid,display_name) VALUES ('new-uid','New Student') RETURNING *`)).rows[0];
    assert.equal(fresh.profile_completed, false);
    await assert.rejects(client.query(`UPDATE ${schema}.users SET faculty='Other University'`), error => (error as any).code === '23514');
  } finally {
    // Rollback also removes the isolated migration fixture.
    await client.query('ROLLBACK');
    client.release();
  }
});

test('email registration, Google onboarding, profile validation and backup preserve account state', { skip: !enabled }, async () => {
  repository.setFirebaseProvisioningHandlerForTests(async () => false);
  await repository.ensureSeededDatabase();
  const local = await repository.registerEmailPasswordUser(`academic-${run}@example.invalid`, 'AcademicTests_2026!', '  Student One  ', DEFAULT_FACULTY);
  created.push(local.uid);
  assert.equal(local.displayName, 'Student One');
  assert.equal(local.faculty, DEFAULT_FACULTY);
  assert.equal(local.profileCompleted, true);
  const uid = `academic-google-${run}`;
  const google = await repository.getOrCreateUser(uid, `${uid}@example.invalid`, 'Google Suggested Name', { authType: 'firebase', emailVerified: true });
  created.push(uid);
  assert.equal(google.profileCompleted, false);
  assert.equal(google.faculty, DEFAULT_FACULTY);
  const app = (await import('../../server.ts')).default;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const token = createServerSessionToken({ uid, email: google.email, name: google.displayName, tokenVersion: google.tokenVersion, emailVerified: true });
  const update = async (body: object) => fetch(`${base}/api/auth/profile`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/api/auth/profile`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: '{}' })).status, 401);
    for (const body of [{ displayName: {} }, { displayName: 'a' }, { displayName: 'x'.repeat(121) }, { displayName: 'Student', faculty: 'Other University' }]) {
      assert.equal((await update(body)).status, 400);
    }
    assert.equal((await repository.getAuthenticatedUserByUid(uid))?.profileCompleted, false);
    const response = await update({ displayName: '  طالب بنها  ', faculty: DEFAULT_FACULTY, role: 'admin', tokenVersion: 99 });
    assert.equal(response.status, 200);
    const { user } = await response.json();
    assert.equal(user.displayName, 'طالب بنها');
    assert.equal(user.profileCompleted, true);
    assert.equal(user.faculty, DEFAULT_FACULTY);
    assert.equal(user.role, 'student');
    assert.equal(user.tokenVersion, google.tokenVersion);
    assert.equal(user.sessionsRevokedAt, google.sessionsRevokedAt);
    assert.equal(user.passwordHash, undefined);
    const again = await repository.getOrCreateUser(uid, google.email, 'Google Suggested Name', { authType: 'firebase', emailVerified: true });
    assert.equal(again.displayName, 'طالب بنها');
    assert.equal(again.profileCompleted, true);
    const [storedLocal] = await db.select().from(users).where(eq(users.uid, local.uid));
    assert.equal(storedLocal.displayName, 'Student One');
    const { createEncryptedBackup, testRestoreBackup, decryptBackupPayload } = await import('./backup-service.ts');
    const backup = await createEncryptedBackup();
    const payload = decryptBackupPayload(backup.envelope, backup.key);
    const saved = payload.tables.users.find((row: any) => row.uid === uid) as any;
    assert.equal(saved.faculty, DEFAULT_FACULTY);
    assert.equal(saved.profile_completed, true);
    assert.equal((await testRestoreBackup(backup.envelope)).status, 'verified');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
