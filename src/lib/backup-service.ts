import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, isDatabaseConfigured } from '../db/index.ts';
import {
  type BackupStorageProvider,
  resolveBackupStorageProvider,
  LocalFsStorageProvider,
} from './backup-storage.ts';

export const BACKUP_FORMAT_VERSION = 'medatlas-backup-v1';
export const DEFAULT_BACKUP_RETENTION_DAYS = 30;
export const MIN_BACKUP_KEY_LENGTH = 32;

// Advisory lock IDs to prevent overlapping backup executions or restore tests
export const BACKUP_SCHEDULER_LOCK_ID = 8847291;
export const RESTORE_TEST_LOCK_ID = 8847292;

export interface BackupMetadata {
  format: string;
  createdAt: string;
  version: string;
  tables: Record<string, number>;
  plaintextSha256: string;
}

export interface EncryptedBackupEnvelope {
  format: string;
  createdAt: string;
  algorithm: 'aes-256-gcm';
  iv: string;
  authTag: string;
  ciphertext: string;
  metadata: BackupMetadata;
}

export interface BackupPayload {
  format: string;
  createdAt: string;
  database: 'postgresql';
  tables: {
    users: unknown[];
    modules: unknown[];
    subjects: unknown[];
    lectures: unknown[];
    lectureFiles: unknown[];
    questionBanks: unknown[];
    questions: unknown[];
    examSessions: unknown[];
    questionAttempts: unknown[];
    bookmarks: unknown[];
    importBatches: unknown[];
    adminAuditLogs: unknown[];
    deletedAccounts: unknown[];
    passwordResetTokens: unknown[];
    rateLimitBuckets: unknown[];
  };
}

export interface RestoreVerificationResult {
  success: boolean;
  status: 'verified' | 'incomplete' | 'failed';
  checksumMatched: boolean;
  decryptionSucceeded: boolean;
  isolatedSchemaTested?: string;
  tableCounts: Record<string, number>;
  totalRecords: number;
  durationMs: number;
  reason?: string;
  error?: string;
}

export interface ScheduledBackupResult {
  success: boolean;
  backupId: string;
  storageProvider: string;
  isDurableStorage: boolean;
  location: string;
  metadata: BackupMetadata;
  verificationResult: RestoreVerificationResult;
  prunedCount: number;
  durationMs: number;
  error?: string;
}

/**
 * Validates and derives a 32-byte AES-256 encryption key.
 * In production, BACKUP_ENCRYPTION_KEY is mandatory (>= 32 chars) and must be separated from AUTH_SESSION_SECRET.
 */
export function deriveBackupEncryptionKey(secretOverride?: string): Buffer {
  const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const dedicatedKey = secretOverride || process.env.BACKUP_ENCRYPTION_KEY;

  if (isProduction) {
    if (!dedicatedKey || dedicatedKey.trim().length < MIN_BACKUP_KEY_LENGTH) {
      throw new Error(
        `[SECURITY ERROR] Production backup requires BACKUP_ENCRYPTION_KEY to be configured with at least ${MIN_BACKUP_KEY_LENGTH} characters. Silently falling back to AUTH_SESSION_SECRET in production is forbidden.`
      );
    }
    if (dedicatedKey === process.env.AUTH_SESSION_SECRET) {
      throw new Error(
        '[SECURITY ERROR] Production BACKUP_ENCRYPTION_KEY must NOT be identical to AUTH_SESSION_SECRET. Cryptographic key separation is required.'
      );
    }
    return crypto.createHash('sha256').update(`medatlas:backup:aes256gcm:${dedicatedKey}`).digest();
  }

  // Development and test fallback with explicit notice
  const candidate = dedicatedKey || process.env.AUTH_SESSION_SECRET || '';
  if (!candidate || candidate.trim().length < 16) {
    throw new Error(
      'Backup encryption requires BACKUP_ENCRYPTION_KEY or AUTH_SESSION_SECRET (at least 16 characters).'
    );
  }

  return crypto.createHash('sha256').update(`medatlas:backup:aes256gcm:${candidate}`).digest();
}

/**
 * Encrypts a plaintext JSON payload string using AES-256-GCM.
 */
export function encryptBackupPayload(
  payloadString: string,
  key: Buffer
): { iv: string; authTag: string; ciphertext: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(payloadString, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('base64'),
  };
}

/**
 * Validates envelope structure and decrypts AES-256-GCM ciphertext with integrity verification.
 */
export function decryptBackupPayload(
  envelope: EncryptedBackupEnvelope,
  key: Buffer
): BackupPayload {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Invalid backup envelope: payload is not an object.');
  }
  if (envelope.format !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported backup format: ${envelope.format}. Expected ${BACKUP_FORMAT_VERSION}.`);
  }
  if (envelope.algorithm !== 'aes-256-gcm') {
    throw new Error(`Unsupported encryption algorithm: ${envelope.algorithm}.`);
  }
  if (!envelope.iv || envelope.iv.length !== 24) {
    throw new Error('Invalid envelope: IV must be a 12-byte hex string (24 characters).');
  }
  if (!envelope.authTag || envelope.authTag.length !== 32) {
    throw new Error('Invalid envelope: authTag must be a 16-byte hex string (32 characters).');
  }
  if (!envelope.ciphertext || typeof envelope.ciphertext !== 'string') {
    throw new Error('Invalid envelope: ciphertext is missing or invalid.');
  }
  if (!envelope.metadata || !envelope.metadata.plaintextSha256) {
    throw new Error('Invalid envelope: metadata or plaintextSha256 is missing.');
  }

  const iv = Buffer.from(envelope.iv, 'hex');
  const authTag = Buffer.from(envelope.authTag, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);

  const plaintext = decrypted.toString('utf8');
  const computedSha256 = crypto.createHash('sha256').update(plaintext).digest('hex');

  if (computedSha256 !== envelope.metadata.plaintextSha256) {
    throw new Error('Integrity check failed: decrypted plaintext SHA-256 does not match envelope metadata.');
  }

  const parsed = JSON.parse(plaintext) as BackupPayload;

  // Validate structural integrity of tables
  const requiredTables: Array<keyof BackupPayload['tables']> = [
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

  if (!parsed.tables || typeof parsed.tables !== 'object') {
    throw new Error('Invalid backup payload: "tables" property is missing or malformed.');
  }

  for (const tableName of requiredTables) {
    if (!Array.isArray(parsed.tables[tableName])) {
      throw new Error(`Corrupted backup payload: table "${tableName}" is missing or not an array.`);
    }
  }

  return parsed;
}

/**
 * Exports all required tables from a single, consistent PostgreSQL Repeatable-Read transaction.
 * Guarantees snapshot consistency across all 15 tables.
 */
export async function createConsistentDatabaseSnapshot(): Promise<BackupPayload> {
  if (!pool || !isDatabaseConfigured()) {
    throw new Error('Database is not configured; cannot produce a consistent database snapshot.');
  }

  const client: PoolClient = await pool.connect();

  try {
    // Acquire a single consistent snapshot using Repeatable Read Read-Only transaction isolation
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const usersRes = await client.query('SELECT * FROM public.users ORDER BY id ASC');
    const modulesRes = await client.query('SELECT * FROM public.modules ORDER BY id ASC');
    const subjectsRes = await client.query('SELECT * FROM public.subjects ORDER BY id ASC');
    const lecturesRes = await client.query('SELECT * FROM public.lectures ORDER BY id ASC');
    // PDFs already stored on Telegram are backed up by reference only (data_base64 blanked server-side)
    // so the nightly backup does not pull tens of MB of base64 out of Supabase (egress).
    const lectureFilesRes = await client.query(
      `SELECT id, file_name, mime_type, file_size,
              CASE WHEN telegram_file_id IS NOT NULL AND telegram_file_id <> '' THEN '' ELSE data_base64 END AS data_base64,
              url, telegram_file_id, created_at
       FROM public.lecture_files ORDER BY id ASC`
    );
    const questionBanksRes = await client.query('SELECT * FROM public.question_banks ORDER BY id ASC');
    const questionsRes = await client.query('SELECT * FROM public.questions ORDER BY id ASC');
    const examSessionsRes = await client.query('SELECT * FROM public.exam_sessions ORDER BY id ASC');
    const questionAttemptsRes = await client.query('SELECT * FROM public.question_attempts ORDER BY id ASC');
    const bookmarksRes = await client.query('SELECT * FROM public.bookmarks ORDER BY id ASC');
    const importBatchesRes = await client.query('SELECT * FROM public.import_batches ORDER BY id ASC');
    const adminAuditLogsRes = await client.query('SELECT * FROM public.admin_audit_logs ORDER BY id ASC');
    const deletedAccountsRes = await client.query('SELECT * FROM public.deleted_accounts ORDER BY id ASC');
    const passwordResetTokensRes = await client.query('SELECT * FROM public.password_reset_tokens ORDER BY id ASC');
    const rateLimitBucketsRes = await client.query('SELECT * FROM public.rate_limit_buckets ORDER BY key ASC');

    await client.query('COMMIT');

    return {
      format: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      database: 'postgresql',
      tables: {
        users: usersRes.rows,
        modules: modulesRes.rows,
        subjects: subjectsRes.rows,
        lectures: lecturesRes.rows,
        lectureFiles: lectureFilesRes.rows,
        questionBanks: questionBanksRes.rows,
        questions: questionsRes.rows,
        examSessions: examSessionsRes.rows,
        questionAttempts: questionAttemptsRes.rows,
        bookmarks: bookmarksRes.rows,
        importBatches: importBatchesRes.rows,
        adminAuditLogs: adminAuditLogsRes.rows,
        deletedAccounts: deletedAccountsRes.rows,
        passwordResetTokens: passwordResetTokensRes.rows,
        rateLimitBuckets: rateLimitBucketsRes.rows,
      },
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Creates an encrypted backup payload from the consistent snapshot.
 */
export async function createEncryptedBackup(options?: {
  encryptionKeySecret?: string;
  snapshotOverride?: BackupPayload;
}): Promise<{ envelope: EncryptedBackupEnvelope; key: Buffer; serialized: string }> {
  const payload = options?.snapshotOverride || (await createConsistentDatabaseSnapshot());
  const serialized = JSON.stringify(payload);
  const plaintextSha256 = crypto.createHash('sha256').update(serialized).digest('hex');

  const tableCounts: Record<string, number> = {};
  for (const [tableName, rows] of Object.entries(payload.tables)) {
    tableCounts[tableName] = Array.isArray(rows) ? rows.length : 0;
  }

  const metadata: BackupMetadata = {
    format: BACKUP_FORMAT_VERSION,
    createdAt: payload.createdAt,
    version: '1.0',
    tables: tableCounts,
    plaintextSha256,
  };

  const key = deriveBackupEncryptionKey(options?.encryptionKeySecret);
  const encrypted = encryptBackupPayload(serialized, key);

  const envelope: EncryptedBackupEnvelope = {
    format: BACKUP_FORMAT_VERSION,
    createdAt: payload.createdAt,
    algorithm: 'aes-256-gcm',
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    ciphertext: encrypted.ciphertext,
    metadata,
  };

  return { envelope, key, serialized };
}

/**
 * Genuine Isolated Restore Verification:
 * Decrypts the backup, verifies the authentication tag, validates the SHA-256 hash,
 * creates a dedicated disposable PostgreSQL schema (restore_test_<timestamp>_<random>),
 * constructs all 15 tables with complete DDL constraints & foreign keys,
 * inserts the backup records in topological order, tests relational joins,
 * and ALWAYS drops the disposable schema in a finally block.
 *
 * Never alters production tables. If database is unreachable, returns status: 'incomplete'.
 */
export async function testRestoreBackup(
  backupInput: string | EncryptedBackupEnvelope,
  options?: { encryptionKeySecret?: string; poolOverride?: any }
): Promise<RestoreVerificationResult> {
  const startTime = Date.now();
  let envelope: EncryptedBackupEnvelope;

  if (typeof backupInput === 'string') {
    if (fs.existsSync(backupInput)) {
      const raw = fs.readFileSync(backupInput, 'utf8');
      envelope = JSON.parse(raw) as EncryptedBackupEnvelope;
    } else {
      envelope = JSON.parse(backupInput) as EncryptedBackupEnvelope;
    }
  } else {
    envelope = backupInput;
  }

  let payload: BackupPayload;
  try {
    const key = deriveBackupEncryptionKey(options?.encryptionKeySecret);
    payload = decryptBackupPayload(envelope, key);
  } catch (decryptionErr: any) {
    return {
      success: false,
      status: 'failed',
      checksumMatched: false,
      decryptionSucceeded: false,
      tableCounts: {},
      totalRecords: 0,
      durationMs: Date.now() - startTime,
      error: `Decryption or integrity verification failed: ${decryptionErr.message}`,
    };
  }

  const tableCounts: Record<string, number> = {};
  let totalRecords = 0;
  for (const [tableName, rows] of Object.entries(payload.tables)) {
    const count = Array.isArray(rows) ? rows.length : 0;
    tableCounts[tableName] = count;
    totalRecords += count;
  }

  const activePool = options?.poolOverride !== undefined ? options.poolOverride : pool;

  // If database is not configured or connection pool is missing, genuine restore cannot run
  if (!activePool || !isDatabaseConfigured()) {
    return {
      success: false,
      status: 'incomplete',
      checksumMatched: true,
      decryptionSucceeded: true,
      tableCounts,
      totalRecords,
      durationMs: Date.now() - startTime,
      reason: 'Database connection is not configured; genuine restore test could not be executed.',
    };
  }

  const client = await activePool.connect();
  const schemaSuffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const isolatedSchema = `restore_test_${schemaSuffix}`;

  try {
    // Acquire restore advisory lock to prevent multiple concurrent restore test runs
    const lockRes = await client.query('SELECT pg_try_advisory_lock($1::bigint)', [RESTORE_TEST_LOCK_ID]);
    const acquiredLock = Boolean(lockRes.rows[0]?.pg_try_advisory_lock);
    if (!acquiredLock) {
      return {
        success: false,
        status: 'incomplete',
        checksumMatched: true,
        decryptionSucceeded: true,
        tableCounts,
        totalRecords,
        durationMs: Date.now() - startTime,
        reason: 'Another restore verification test is currently executing; skipped to prevent lock contention.',
      };
    }

    try {
      // 1. Create disposable isolated schema
      await client.query(`CREATE SCHEMA "${isolatedSchema}"`);

      // 2. Build full relational DDL with tables, columns, primary keys, and foreign keys
      await client.query(`
        CREATE TABLE "${isolatedSchema}".modules (
          id SERIAL PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          display_order INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'published',
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE "${isolatedSchema}".users (
          id SERIAL PRIMARY KEY,
          uid TEXT NOT NULL UNIQUE,
          firebase_uid TEXT,
          email TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT,
          auth_provider TEXT NOT NULL DEFAULT 'local',
          token_version INTEGER NOT NULL DEFAULT 1,
          password_updated_at TIMESTAMP WITHOUT TIME ZONE,
          pending_recovery_at TIMESTAMP WITHOUT TIME ZONE,
          sessions_revoked_at TIMESTAMP WITHOUT TIME ZONE,
          account_status TEXT NOT NULL DEFAULT 'active',
          deleted_at TIMESTAMP WITHOUT TIME ZONE,
          role TEXT NOT NULL DEFAULT 'student',
          subscription_tier TEXT NOT NULL DEFAULT 'free_trial',
          subscription_status TEXT NOT NULL DEFAULT 'active',
          subscription_expires_at TIMESTAMP WITHOUT TIME ZONE,
          email_verified BOOLEAN NOT NULL DEFAULT FALSE,
          preferences TEXT NOT NULL DEFAULT '{}',
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE "${isolatedSchema}".deleted_accounts (
          id SERIAL PRIMARY KEY,
          uid TEXT NOT NULL UNIQUE,
          firebase_uid TEXT,
          email_hash TEXT NOT NULL,
          remote_cleanup_status TEXT NOT NULL DEFAULT 'completed',
          last_cleanup_error TEXT,
          deleted_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE "${isolatedSchema}".password_reset_tokens (
          id SERIAL PRIMARY KEY,
          user_uid TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
          consumed_at TIMESTAMP WITHOUT TIME ZONE,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE "${isolatedSchema}".rate_limit_buckets (
          key TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 1,
          reset_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
          updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE "${isolatedSchema}".subjects (
          id SERIAL PRIMARY KEY,
          module_id INTEGER REFERENCES "${isolatedSchema}".modules(id) ON DELETE CASCADE,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          display_order INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'published',
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE "${isolatedSchema}".lectures (
          id SERIAL PRIMARY KEY,
          subject_id INTEGER NOT NULL REFERENCES "${isolatedSchema}".subjects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          lecture_number INTEGER NOT NULL DEFAULT 1,
          educational_notes TEXT NOT NULL DEFAULT '',
          estimated_minutes INTEGER NOT NULL DEFAULT 30,
          pdf_url TEXT,
          status TEXT NOT NULL DEFAULT 'published',
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE "${isolatedSchema}".lecture_files (
          id SERIAL PRIMARY KEY,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL DEFAULT 'application/pdf',
          file_size INTEGER NOT NULL DEFAULT 0,
          data_base64 TEXT NOT NULL,
          url TEXT NOT NULL UNIQUE,
          telegram_file_id TEXT,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE "${isolatedSchema}".question_banks (
          id SERIAL PRIMARY KEY,
          subject_id INTEGER NOT NULL REFERENCES "${isolatedSchema}".subjects(id) ON DELETE CASCADE,
          lecture_id INTEGER NOT NULL REFERENCES "${isolatedSchema}".lectures(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          bank_type TEXT NOT NULL DEFAULT 'practice',
          time_limit_minutes INTEGER,
          is_premium BOOLEAN NOT NULL DEFAULT FALSE,
          status TEXT NOT NULL DEFAULT 'published',
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE "${isolatedSchema}".questions (
          id SERIAL PRIMARY KEY,
          subject_id INTEGER NOT NULL REFERENCES "${isolatedSchema}".subjects(id) ON DELETE CASCADE,
          lecture_id INTEGER NOT NULL REFERENCES "${isolatedSchema}".lectures(id) ON DELETE CASCADE,
          question_bank_id INTEGER REFERENCES "${isolatedSchema}".question_banks(id) ON DELETE SET NULL,
          question_text TEXT NOT NULL,
          option_a TEXT NOT NULL,
          option_b TEXT NOT NULL,
          option_c TEXT NOT NULL,
          option_d TEXT NOT NULL,
          correct_answer TEXT NOT NULL,
          explanation TEXT NOT NULL,
          explanation_a TEXT NOT NULL DEFAULT '',
          explanation_b TEXT NOT NULL DEFAULT '',
          explanation_c TEXT NOT NULL DEFAULT '',
          explanation_d TEXT NOT NULL DEFAULT '',
          difficulty TEXT NOT NULL DEFAULT 'Medium',
          tags TEXT NOT NULL DEFAULT '',
          special_tags TEXT NOT NULL DEFAULT '',
          diagram_svg TEXT NOT NULL DEFAULT '',
          page_number INTEGER,
          status TEXT NOT NULL DEFAULT 'published',
          version INTEGER NOT NULL DEFAULT 1,
          content_hash TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE "${isolatedSchema}".exam_sessions (
          id SERIAL PRIMARY KEY,
          user_uid TEXT NOT NULL,
          title TEXT NOT NULL,
          mode TEXT NOT NULL,
          subject_id INTEGER REFERENCES "${isolatedSchema}".subjects(id) ON DELETE SET NULL,
          lecture_id INTEGER REFERENCES "${isolatedSchema}".lectures(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'in_progress',
          total_questions INTEGER NOT NULL,
          correct_count INTEGER NOT NULL DEFAULT 0,
          incorrect_count INTEGER NOT NULL DEFAULT 0,
          unanswered_count INTEGER NOT NULL DEFAULT 0,
          score_percentage INTEGER NOT NULL DEFAULT 0,
          time_limit_seconds INTEGER,
          elapsed_seconds INTEGER NOT NULL DEFAULT 0,
          shuffle_options BOOLEAN NOT NULL DEFAULT FALSE,
          question_order_json TEXT NOT NULL,
          started_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMP WITHOUT TIME ZONE
        );

        CREATE TABLE "${isolatedSchema}".question_attempts (
          id SERIAL PRIMARY KEY,
          session_id INTEGER NOT NULL REFERENCES "${isolatedSchema}".exam_sessions(id) ON DELETE CASCADE,
          user_uid TEXT NOT NULL,
          question_id INTEGER REFERENCES "${isolatedSchema}".questions(id) ON DELETE SET NULL,
          subject_id INTEGER,
          lecture_id INTEGER,
          selected_option TEXT,
          correct_option_snapshot TEXT NOT NULL,
          is_correct BOOLEAN NOT NULL DEFAULT FALSE,
          question_snapshot_json TEXT NOT NULL,
          time_spent_seconds INTEGER NOT NULL DEFAULT 0,
          answered_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          CONSTRAINT "uq_${schemaSuffix}_session_question" UNIQUE(session_id, question_id)
        );

        CREATE TABLE "${isolatedSchema}".bookmarks (
          id SERIAL PRIMARY KEY,
          user_uid TEXT NOT NULL,
          question_id INTEGER NOT NULL REFERENCES "${isolatedSchema}".questions(id) ON DELETE CASCADE,
          note TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE "${isolatedSchema}".import_batches (
          id SERIAL PRIMARY KEY,
          admin_uid TEXT NOT NULL,
          file_name TEXT NOT NULL,
          file_hash TEXT NOT NULL,
          total_rows INTEGER NOT NULL,
          imported_count INTEGER NOT NULL,
          skipped_count INTEGER NOT NULL,
          failed_count INTEGER NOT NULL,
          summary_json TEXT NOT NULL DEFAULT '{}',
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE "${isolatedSchema}".admin_audit_logs (
          id SERIAL PRIMARY KEY,
          admin_uid TEXT NOT NULL,
          admin_email TEXT NOT NULL,
          action TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          details TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        );
      `);

      // 3. Insert records in foreign-key topological order using batch parameterized queries
      const insertRows = async (tableName: string, rows: any[]) => {
        if (!rows || rows.length === 0) return;
        const CHUNK_SIZE = 50;
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
          const chunk = rows.slice(i, i + CHUNK_SIZE);
          const firstRow = chunk[0];
          const keys = Object.keys(firstRow);
          if (keys.length === 0) continue;
          const quotedColumns = keys.map((k) => `"${k}"`).join(', ');

          const valueClauses: string[] = [];
          const values: any[] = [];
          let paramIdx = 1;

          for (const row of chunk) {
            const rowPlaceholders: string[] = [];
            for (const key of keys) {
              rowPlaceholders.push(`$${paramIdx++}`);
              values.push(row[key]);
            }
            valueClauses.push(`(${rowPlaceholders.join(', ')})`);
          }

          await client.query(
            `INSERT INTO "${isolatedSchema}"."${tableName}" (${quotedColumns}) VALUES ${valueClauses.join(', ')}`,
            values
          );
        }
      };

      // Topological insertion sequence
      await insertRows('modules', payload.tables.modules as any[]);
      await insertRows('users', payload.tables.users as any[]);
      await insertRows('deleted_accounts', payload.tables.deletedAccounts as any[]);
      await insertRows('password_reset_tokens', payload.tables.passwordResetTokens as any[]);
      await insertRows('rate_limit_buckets', payload.tables.rateLimitBuckets as any[]);
      await insertRows('subjects', payload.tables.subjects as any[]);
      await insertRows('lectures', payload.tables.lectures as any[]);
      await insertRows('lecture_files', payload.tables.lectureFiles as any[]);
      await insertRows('question_banks', payload.tables.questionBanks as any[]);
      await insertRows('questions', payload.tables.questions as any[]);
      await insertRows('exam_sessions', payload.tables.examSessions as any[]);
      await insertRows('question_attempts', payload.tables.questionAttempts as any[]);
      await insertRows('bookmarks', payload.tables.bookmarks as any[]);
      await insertRows('import_batches', payload.tables.importBatches as any[]);
      await insertRows('admin_audit_logs', payload.tables.adminAuditLogs as any[]);

      // 4. Verify row counts and relationships in the disposable schema
      for (const [tableKey, expectedCount] of Object.entries(envelope.metadata.tables)) {
        const sqlTable = tableKey.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
        const checkRes = await client.query(`SELECT COUNT(*)::int as cnt FROM "${isolatedSchema}"."${sqlTable}"`);
        const actualCount = checkRes.rows[0]?.cnt || 0;
        if (actualCount !== expectedCount) {
          throw new Error(
            `Restored row count mismatch in table ${sqlTable}: expected ${expectedCount}, got ${actualCount}.`
          );
        }
      }

      // 5. Test referential integrity joins
      await client.query(`
        SELECT COUNT(*) FROM "${isolatedSchema}".questions q
        JOIN "${isolatedSchema}".subjects s ON q.subject_id = s.id
        JOIN "${isolatedSchema}".lectures l ON q.lecture_id = l.id
      `);

      return {
        success: true,
        status: 'verified',
        checksumMatched: true,
        decryptionSucceeded: true,
        isolatedSchemaTested: isolatedSchema,
        tableCounts,
        totalRecords,
        durationMs: Date.now() - startTime,
      };
    } finally {
      // ALWAYS drop the isolated test schema and release advisory lock
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${isolatedSchema}" CASCADE`);
      } catch (cleanupErr) {
        console.error(`Failed to drop test schema ${isolatedSchema}:`, cleanupErr);
      }
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [RESTORE_TEST_LOCK_ID]);
    }
  } catch (err: any) {
    return {
      success: false,
      status: 'failed',
      checksumMatched: true,
      decryptionSucceeded: true,
      tableCounts,
      totalRecords,
      durationMs: Date.now() - startTime,
      error: `Isolated schema restore test failed: ${err.message}`,
    };
  } finally {
    client.release();
  }
}

/**
 * Executes a full automated scheduled backup run:
 * 1. Checks advisory lock to prevent overlapping runs.
 * 2. Creates a consistent database snapshot (Repeatable Read).
 * 3. Encrypts payload with dedicated BACKUP_ENCRYPTION_KEY.
 * 4. Uploads to durable off-site storage.
 * 5. Runs genuine restore verification against an isolated disposable schema.
 * 6. Prunes off-site backups older than retentionDays.
 * 7. Records audit log and dispatches alert webhook on failure.
 */
export async function executeScheduledBackup(options?: {
  storageProvider?: BackupStorageProvider;
  retentionDays?: number;
  encryptionKeySecret?: string;
  snapshotOverride?: BackupPayload;
}): Promise<ScheduledBackupResult> {
  const startTime = Date.now();
  const retentionDays = options?.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS;
  const storage = options?.storageProvider || (await resolveBackupStorageProvider());

  let lockClient: PoolClient | null = null;
  if (pool && isDatabaseConfigured()) {
    lockClient = await pool.connect();
    await lockClient.query('BEGIN');
    const lockRes = await lockClient.query('SELECT pg_try_advisory_xact_lock($1::bigint)', [BACKUP_SCHEDULER_LOCK_ID]);
    const acquired = Boolean(lockRes.rows[0]?.pg_try_advisory_xact_lock);
    if (!acquired) {
      await lockClient.query('ROLLBACK');
      lockClient.release();
      lockClient = null;
      throw new Error('Another backup job is currently in progress. Execution skipped to prevent overlap.');
    }
  }

  try {
    // 1. Snapshot and encrypt
    const { envelope, serialized } = await createEncryptedBackup({
      encryptionKeySecret: options?.encryptionKeySecret,
      snapshotOverride: options?.snapshotOverride,
    });

    const timestampStr = envelope.createdAt.replace(/[:.]/g, '-');
    const backupKey = `medatlas_backup_${timestampStr}.enc.json`;

    // 2. Upload to durable storage
    const uploadResult = await storage.upload({
      key: backupKey,
      data: JSON.stringify(envelope, null, 2),
      contentType: 'application/json',
    });

    // 3. Verify uploaded object
    const verified = await storage.verify(backupKey, hashSha256(JSON.stringify(envelope, null, 2)));
    if (!verified) {
      throw new Error(`Durable storage verification failed for uploaded object: ${backupKey}`);
    }

    // 4. Run genuine restore verification
    const verificationResult = await testRestoreBackup(envelope, {
      encryptionKeySecret: options?.encryptionKeySecret,
    });

    // 5. Off-site retention pruning
    let prunedCount = 0;
    try {
      const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const remoteObjects = await storage.list('medatlas_backup_');
      for (const obj of remoteObjects) {
        if (obj.lastModified.getTime() < cutoffTime) {
          await storage.delete(obj.key);
          prunedCount++;
        }
      }
    } catch (pruneErr) {
      console.warn('Backup retention pruning encounter warning:', pruneErr);
    }

    const durationMs = Date.now() - startTime;

    // Log success audit
    await recordBackupAudit('SYSTEM_BACKUP_COMPLETED', {
      backupId: backupKey,
      storageProvider: storage.name,
      isDurable: storage.isDurable,
      records: envelope.metadata.tables,
      restoreVerified: verificationResult.status,
      durationMs,
    });

    return {
      success: true,
      backupId: backupKey,
      storageProvider: storage.name,
      isDurableStorage: storage.isDurable,
      location: uploadResult.location,
      metadata: envelope.metadata,
      verificationResult,
      prunedCount,
      durationMs,
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    console.error('[CRITICAL_BACKUP_FAILURE]', err);

    await recordBackupAudit('SYSTEM_BACKUP_FAILED', {
      error: err.message,
      durationMs,
    });

    // Trigger alert webhook if configured
    if (process.env.BACKUP_ALERT_WEBHOOK_URL) {
      try {
        await fetch(process.env.BACKUP_ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'medatlas.backup.failed',
            timestamp: new Date().toISOString(),
            error: err.message,
          }),
        });
      } catch (webhookErr) {
        console.error('Failed to dispatch backup alert webhook:', webhookErr);
      }
    }

    throw err;
  } finally {
    if (lockClient) {
      try {
        await lockClient.query('COMMIT');
      } catch {
        try {
          await lockClient.query('ROLLBACK');
        } catch {}
      }
      lockClient.release();
    }
  }
}

/**
 * Logs a backup system event to the admin_audit_logs table.
 */
async function recordBackupAudit(action: string, details: Record<string, unknown>) {
  if (!pool || !isDatabaseConfigured()) return;
  try {
    await pool.query(
      `INSERT INTO public.admin_audit_logs (admin_uid, admin_email, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'system_scheduler',
        'system@medatlas.internal',
        action,
        'database_backup',
        (details.backupId as string) || 'system',
        JSON.stringify(details),
      ]
    );
  } catch (err) {
    console.error('Failed to write backup audit log:', err);
  }
}

function hashSha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
