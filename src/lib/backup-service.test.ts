import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.AUTH_SESSION_SECRET = 'test_secret_for_backup_encryption_minimum_32_characters_long';

import {
  deriveBackupEncryptionKey,
  encryptBackupPayload,
  decryptBackupPayload,
  createConsistentDatabaseSnapshot,
  createEncryptedBackup,
  testRestoreBackup,
  executeScheduledBackup,
  BACKUP_FORMAT_VERSION,
  MIN_BACKUP_KEY_LENGTH,
  BACKUP_SCHEDULER_LOCK_ID,
  type EncryptedBackupEnvelope,
  type BackupPayload,
} from './backup-service.ts';
import {
  LocalFsStorageProvider,
  type BackupStorageProvider,
} from './backup-storage.ts';
import { pool } from '../db/index.ts';

describe('MedAtlas Automated Data Backup & Disaster Recovery (Production Hardened)', () => {
  const testOutputDir = path.resolve(process.cwd(), 'backups-test-temp');
  const validDedicatedKey = 'production_backup_secret_minimum_32_chars_long!';

  before(async () => {
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir, { recursive: true });
    }
    if (pool) {
      try {
        await pool.query('SELECT pg_advisory_unlock_all()');
      } catch {}
    }
  });

  after(() => {
    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  it('1. Production Key Separation: requires dedicated BACKUP_ENCRYPTION_KEY (>=32 chars) and forbids AUTH_SESSION_SECRET reuse', () => {
    const origEnv = process.env.NODE_ENV;
    const origKey = process.env.BACKUP_ENCRYPTION_KEY;
    const origSecret = process.env.AUTH_SESSION_SECRET;

    try {
      process.env.NODE_ENV = 'production';

      // Missing BACKUP_ENCRYPTION_KEY in production must throw
      delete process.env.BACKUP_ENCRYPTION_KEY;
      assert.throws(() => {
        deriveBackupEncryptionKey();
      }, /Production backup requires BACKUP_ENCRYPTION_KEY/);

      // Short BACKUP_ENCRYPTION_KEY (< 32 chars) in production must throw
      process.env.BACKUP_ENCRYPTION_KEY = 'too_short_key_123';
      assert.throws(() => {
        deriveBackupEncryptionKey();
      }, /at least 32 characters/);

      // Reusing AUTH_SESSION_SECRET in production must throw
      process.env.AUTH_SESSION_SECRET = 'reused_secret_value_for_testing_session_secret_32chars!';
      process.env.BACKUP_ENCRYPTION_KEY = 'reused_secret_value_for_testing_session_secret_32chars!';
      assert.throws(() => {
        deriveBackupEncryptionKey();
      }, /must NOT be identical to AUTH_SESSION_SECRET/);

      // Dedicated strong key in production succeeds
      process.env.BACKUP_ENCRYPTION_KEY = validDedicatedKey;
      const key = deriveBackupEncryptionKey();
      assert.equal(Buffer.isBuffer(key), true);
      assert.equal(key.length, 32);
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.BACKUP_ENCRYPTION_KEY = origKey;
      process.env.AUTH_SESSION_SECRET = origSecret;
    }
  });

  it('2. Consistent Database Snapshot: queries all 15 core tables within single Repeatable Read transaction', async () => {
    const snapshot = await createConsistentDatabaseSnapshot();
    assert.equal(snapshot.format, BACKUP_FORMAT_VERSION);
    assert.equal(snapshot.database, 'postgresql');
    assert.ok(snapshot.createdAt);

    const requiredTables = [
      'users',
      'modules',
      'subjects',
      'lectures',
      'lectureFiles',
      'questionBanks',
      'questions',
      'examSessions',
      'questionAttempts',
      'bookmarks',
      'importBatches',
      'adminAuditLogs',
      'deletedAccounts',
      'passwordResetTokens',
      'rateLimitBuckets',
    ];

    for (const table of requiredTables) {
      assert.ok(
        table in snapshot.tables,
        `Expected table ${table} in database snapshot`
      );
      assert.ok(
        Array.isArray((snapshot.tables as Record<string, unknown>)[table]),
        `Expected ${table} to be an array`
      );
    }
  });

  it('3. Envelope & Tamper Detection: validates AES-256-GCM authTag and plaintext SHA-256 integrity', () => {
    const key = deriveBackupEncryptionKey(validDedicatedKey);
    const mockPayload: BackupPayload = {
      format: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      database: 'postgresql',
      tables: {
        users: [{ uid: 'usr_test_1', email: 'student@example.com' }],
        modules: [],
        subjects: [],
        lectures: [],
        lectureFiles: [],
        questionBanks: [],
        questions: [{ id: 1, questionText: 'Cardiology MCQ' }],
        examSessions: [],
        questionAttempts: [],
        bookmarks: [],
        importBatches: [],
        adminAuditLogs: [],
        deletedAccounts: [],
        passwordResetTokens: [],
        rateLimitBuckets: [],
      },
    };

    const serialized = JSON.stringify(mockPayload);
    const plaintextSha256 = crypto.createHash('sha256').update(serialized).digest('hex');
    const encrypted = encryptBackupPayload(serialized, key);

    const envelope: EncryptedBackupEnvelope = {
      format: BACKUP_FORMAT_VERSION,
      createdAt: mockPayload.createdAt,
      algorithm: 'aes-256-gcm',
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      ciphertext: encrypted.ciphertext,
      metadata: {
        format: BACKUP_FORMAT_VERSION,
        createdAt: mockPayload.createdAt,
        version: '1.0',
        tables: { users: 1, questions: 1 },
        plaintextSha256,
      },
    };

    // Valid decryption succeeds
    const decrypted = decryptBackupPayload(envelope, key);
    assert.deepEqual(decrypted, mockPayload);

    // Tampered ciphertext fails
    const tamperedEnvelope = { ...envelope, ciphertext: Buffer.from('corrupted_bytes').toString('base64') };
    assert.throws(() => {
      decryptBackupPayload(tamperedEnvelope, key);
    });

    // Incorrect key fails authentication tag verification
    const wrongKey = crypto.randomBytes(32);
    assert.throws(() => {
      decryptBackupPayload(envelope, wrongKey);
    });

    // Tampered SHA-256 checksum fails
    const alteredMetadataEnvelope = {
      ...envelope,
      metadata: { ...envelope.metadata, plaintextSha256: 'deadbeef00000000000000000000000000000000000000000000000000000000' },
    };
    assert.throws(() => {
      decryptBackupPayload(alteredMetadataEnvelope, key);
    }, /plaintext SHA-256 does not match/);
  });

  it('4. Genuine Isolated Restore Verification: constructs isolated schema, restores tables, and cleans up cleanly', { timeout: 120_000 }, async () => {
    const { envelope } = await createEncryptedBackup({
      encryptionKeySecret: validDedicatedKey,
    });

    const result = await testRestoreBackup(envelope, {
      encryptionKeySecret: validDedicatedKey,
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'verified');
    assert.equal(result.checksumMatched, true);
    assert.equal(result.decryptionSucceeded, true);
    assert.ok(result.isolatedSchemaTested?.startsWith('restore_test_'));
    assert.ok(result.totalRecords >= 0);

    // Verify the disposable schema was automatically dropped
    if (pool && result.isolatedSchemaTested) {
      const checkSchema = await pool.query(
        'SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1',
        [result.isolatedSchemaTested]
      );
      assert.equal(checkSchema.rows.length, 0, 'Disposable restore schema was not cleaned up');
    }
  });

  it('5. Incomplete Restore Reporting: reports incomplete (not passing) when database is unreachable', async () => {
    // Generate valid envelope
    const { envelope } = await createEncryptedBackup({
      encryptionKeySecret: validDedicatedKey,
    });

    const result = await testRestoreBackup(envelope, {
      encryptionKeySecret: validDedicatedKey,
      poolOverride: null,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'incomplete');
    assert.ok(result.reason?.includes('Database connection is not configured'));
  });

  it('6. Durable Storage Provider: uploads, verifies, and prunes off-site objects', async () => {
    const testStorage = new LocalFsStorageProvider(testOutputDir);
    const mockBackupKey = 'medatlas_backup_2026-10-29T12-00-00-000Z.enc.json';
    const testData = JSON.stringify({ test: 'durable_backup_data' });

    const uploadRes = await testStorage.upload({
      key: mockBackupKey,
      data: testData,
    });

    assert.ok(uploadRes.location);

    // Verify uploaded object
    const verified = await testStorage.verify(
      mockBackupKey,
      crypto.createHash('sha256').update(testData).digest('hex')
    );
    assert.equal(verified, true);

    // Verify non-existent object fails verification
    const nonExistentVerified = await testStorage.verify('missing_file.enc.json');
    assert.equal(nonExistentVerified, false);

    // List objects
    const list = await testStorage.list();
    assert.ok(list.some((o) => o.key === mockBackupKey));

    // Delete object
    await testStorage.delete(mockBackupKey);
    const listAfterDelete = await testStorage.list();
    assert.ok(!listAfterDelete.some((o) => o.key === mockBackupKey));
  });

  it('7. Scheduled Backup Automation: creates snapshot, uploads, verifies restore, and logs audit', { timeout: 120_000 }, async () => {
    const testStorage = new LocalFsStorageProvider(testOutputDir);

    const result = await executeScheduledBackup({
      storageProvider: testStorage,
      encryptionKeySecret: validDedicatedKey,
      retentionDays: 30,
    });

    assert.equal(result.success, true);
    assert.ok(result.backupId.startsWith('medatlas_backup_'));
    assert.equal(result.storageProvider, 'local-filesystem');
    assert.ok(result.durationMs > 0);
    assert.equal(result.verificationResult.status, 'verified');

    // Verify admin audit log entry was written
    if (pool) {
      const auditRes = await pool.query(
        "SELECT * FROM public.admin_audit_logs WHERE action = 'SYSTEM_BACKUP_COMPLETED' ORDER BY id DESC LIMIT 1"
      );
      assert.ok(auditRes.rows.length > 0);
      const details = JSON.parse(auditRes.rows[0].details);
      assert.equal(details.backupId, result.backupId);
    }
  });

  it('8. Concurrency Guard: prevents overlapping backup executions', async () => {
    if (!pool) return;

    // Simulate an active backup by acquiring the advisory transaction lock
    const client = await pool.connect();
    await client.query('BEGIN');
    const lockRes = await client.query('SELECT pg_try_advisory_xact_lock($1::bigint)', [BACKUP_SCHEDULER_LOCK_ID]);
    assert.equal(lockRes.rows[0]?.pg_try_advisory_xact_lock, true);

    try {
      const testStorage = new LocalFsStorageProvider(testOutputDir);
      await assert.rejects(
        async () => {
          await executeScheduledBackup({
            storageProvider: testStorage,
            encryptionKeySecret: validDedicatedKey,
          });
        },
        /Another backup job is currently in progress/
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
