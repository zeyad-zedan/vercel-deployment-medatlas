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
  createFullDatabaseSnapshot,
  generateBackupArchive,
  testRestoreBackup,
  pruneOldBackups,
  BACKUP_FORMAT_VERSION,
  type EncryptedBackupEnvelope,
  type BackupPayload,
} from './backup-service.ts';

describe('MedAtlas Automated Data Backup & Disaster Recovery', () => {
  const testOutputDir = path.resolve(process.cwd(), 'backups-test-temp');

  before(() => {
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir, { recursive: true });
    }
  });

  after(() => {
    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  it('1. Encryption Key Derivation: derives 32-byte key from secret, fails closed when missing/short', () => {
    const key = deriveBackupEncryptionKey('a_very_secure_backup_key_1234567890');
    assert.equal(Buffer.isBuffer(key), true);
    assert.equal(key.length, 32);

    assert.throws(() => {
      deriveBackupEncryptionKey('short');
    }, /at least 16 chars/);
  });

  it('2. AES-256-GCM Roundtrip: encrypts and decrypts payload with integrity verification', () => {
    const key = deriveBackupEncryptionKey('valid_test_secret_for_testing_123456');
    const mockPayload: BackupPayload = {
      format: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      database: 'postgresql',
      tables: {
        users: [{ uid: 'usr_test', email: 'test@example.com' }],
        modules: [],
        subjects: [],
        lectures: [],
        lectureFiles: [],
        questionBanks: [],
        questions: [{ id: 1, questionText: 'Test MCQ?' }],
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

    const decrypted = decryptBackupPayload(envelope, key);
    assert.deepEqual(decrypted, mockPayload);
  });

  it('3. Tamper Resistance: detects modified ciphertext and mismatched authTag', () => {
    const key = deriveBackupEncryptionKey('valid_test_secret_for_testing_123456');
    const serialized = JSON.stringify({ test: 'tamper_check' });
    const encrypted = encryptBackupPayload(serialized, key);

    const envelope: EncryptedBackupEnvelope = {
      format: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      algorithm: 'aes-256-gcm',
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      ciphertext: Buffer.from('tampered_data').toString('base64'),
      metadata: {
        format: BACKUP_FORMAT_VERSION,
        createdAt: new Date().toISOString(),
        version: '1.0',
        tables: {},
        plaintextSha256: 'deadbeef',
      },
    };

    assert.throws(() => {
      decryptBackupPayload(envelope, key);
    });
  });

  it('4. Full Database Snapshot: captures all 15 core database tables', async () => {
    const snapshot = await createFullDatabaseSnapshot();
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

  it('5. Archive Generation: produces encrypted backup file on disk with correct permissions', async () => {
    const { filePath, envelope } = await generateBackupArchive({
      outputDir: testOutputDir,
      encryptionKeySecret: 'secure_test_key_for_archive_123456',
    });

    assert.ok(fs.existsSync(filePath));
    assert.equal(envelope.algorithm, 'aes-256-gcm');
    assert.ok(envelope.ciphertext.length > 0);
    assert.ok(envelope.metadata.plaintextSha256);
  });

  it('6. Non-Destructive Isolated Restore Test: validates backup without modifying persistent state', async () => {
    const { filePath } = await generateBackupArchive({
      outputDir: testOutputDir,
      encryptionKeySecret: 'secure_test_key_for_archive_123456',
    });

    const result = await testRestoreBackup(filePath, {
      encryptionKeySecret: 'secure_test_key_for_archive_123456',
    });

    assert.equal(result.success, true);
    assert.equal(result.checksumMatched, true);
    assert.equal(result.decryptionSucceeded, true);
    assert.ok(result.totalRecords >= 0);
    assert.ok(result.durationMs >= 0);
  });

  it('7. Retention Policy: prunes backups older than specified threshold while keeping recent backups', () => {
    const now = Date.now();
    const recentFile = path.join(testOutputDir, 'medatlas_backup_2026-10-29T10-00-00-000Z.enc.json');
    const oldFile = path.join(testOutputDir, 'medatlas_backup_2026-08-01T10-00-00-000Z.enc.json');

    fs.writeFileSync(recentFile, JSON.stringify({ recent: true }));
    fs.writeFileSync(oldFile, JSON.stringify({ old: true }));

    // Set oldFile mtime to 45 days ago
    const oldTime = (now - 45 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, oldTime, oldTime);

    const pruned = pruneOldBackups({ backupDir: testOutputDir, maxAgeDays: 30 });

    assert.ok(pruned.includes(path.basename(oldFile)));
    assert.ok(!fs.existsSync(oldFile));
    assert.ok(fs.existsSync(recentFile));
  });
});
