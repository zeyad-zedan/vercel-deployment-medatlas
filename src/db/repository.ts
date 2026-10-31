import crypto from 'node:crypto';
import { eq, and, or, desc, asc, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './index.ts';
import {
  users,
  modules,
  subjects,
  lectures,
  questionBanks,
  questions,
  examSessions,
  questionAttempts,
  bookmarks,
  importBatches,
  adminAuditLogs,
  passwordResetTokens,
  deletedAccounts,
  lectureFiles,
} from './schema.ts';
import {
  computeContentHash,
  createOptionPermutation,
  formatQuestionForClient,
  resolveCanonicalOption,
  scoreExamSession,
  selectPracticeQuestions,
  computeTopicPerformance,
  parseAndValidateCsvQuestions,
  parseSpecialTags,
  sanitizeSvgDiagram,
  OPTION_KEYS,
} from '../lib/mcq-engine.ts';
import type {
  OptionKey,
  OptionPermutation,
  DifficultyLevel,
  ContentStatus,
  CanonicalQuestion,
} from '../lib/mcq-engine.ts';
import {
  hashPassword,
  hashPasswordAsync,
  verifyPassword,
  verifyPasswordAsync,
  validatePasswordBounds,
  DUMMY_SCRYPT_HASH,
  RECOVERY_TOKEN_TTL_MS,
  generateRecoveryToken,
  hashRecoveryToken,
  hashEmailForTombstone,
  recordUserSessionRevocation,
} from '../middleware/auth.ts';
import { adminAuth } from '../lib/firebase-admin.ts';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };
import { seedMedicalCurriculumIfEmpty } from './seed-curriculum.ts';

export const OWNER_ADMIN_EMAIL = 'zeyadzedan098@gmail.com';
export const EXAM_SUBMISSION_GRACE_SECONDS = 15;
export const GENERIC_PASSWORD_RECOVERY_MESSAGE =
  'If an eligible account exists for that email address, password recovery instructions have been dispatched.';

const ADMIN_BOOTSTRAP_ADVISORY_LOCK_ID = 84729103;

/**
 * Authoritative Authentication & Credential Architecture:
 * 1. PostgreSQL `users.passwordHash` (scrypt-salted) is the authoritative password credential for
 *    all MedAtlas email/password logins (`authenticateEmailUser`).
 * 2. Accounts with a Firebase identity (`authProvider` in `'firebase' | 'both' | 'linked'` or explicit
 *    `users.firebaseUid`) have their Firebase UID stored in `users.firebaseUid` (never inferred solely
 *    from whether `uid` starts with `'usr_'`).
 * 3. Authenticated password changes (`changeAuthenticatedUserPassword`) and password linking
 *    (`linkPasswordToAuthenticatedAccount`) synchronize credentials to Firebase Auth before committing
 *    when the account has a linked Firebase identity, and record `passwordUpdatedAt` + `sessionsRevokedAt`.
 * 4. `authenticateEmailUser` NEVER falls back to Firebase password verification during normal logins
 *    (preventing any stale Firebase password from overwriting a newer local password). Synchronization
 *    from Firebase is permitted ONLY when an explicit, unconsumed `pendingRecoveryAt` window is active
 *    (`pendingRecoveryAt > passwordUpdatedAt` and within `RECOVERY_TOKEN_TTL_MS`), and if a user resets
 *    their password on Firebase's hosted page during that window, the old local password is immediately
 *    rejected and invalidated.
 */

/**
 * Error class representing messages that are safe to return to the client
 * with an explicit HTTP status code. Unexpected internal errors do not use this class
 * and are masked with a generic message at the HTTP boundary.
 */
export class ClientSafeError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ClientSafeError';
    this.statusCode = statusCode;
  }
}

function assertTestEnvironmentForOverride(hookName: string, handler: unknown): void {
  if (process.env.NODE_ENV !== 'test' && handler !== null) {
    throw new Error(
      `Security violation: ${hookName} is forbidden outside test environment and cannot be activated in production.`
    );
  }
}

export function isOwnerAdminEmail(email: string): boolean {
  return email.toLowerCase().trim() === OWNER_ADMIN_EMAIL;
}

/**
 * Resolves the explicit Firebase UID for an account strictly from explicit database fields
 * (`user.firebaseUid` or `user.authProvider === 'firebase' && user.uid`).
 * NEVER relies on UID prefix guessing (such as `usr_` or `fb_`).
 */
export function resolveUserFirebaseUid(user?: {
  uid: string;
  firebaseUid?: string | null;
  authProvider?: string | null;
} | null): string | null {
  if (!user) return null;
  if (
    user.firebaseUid &&
    typeof user.firebaseUid === 'string' &&
    user.firebaseUid.trim().length > 0
  ) {
    return user.firebaseUid.trim();
  }
  if (
    user.authProvider === 'firebase' &&
    typeof user.uid === 'string' &&
    user.uid.trim().length > 0
  ) {
    return user.uid.trim();
  }
  return null;
}

let specialTagsColumnEnsured = false;

export async function ensureSeededDatabase() {
  if (!specialTagsColumnEnsured) {
    try {
      await db.execute(
        sql`ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS special_tags TEXT NOT NULL DEFAULT ''`
      );
      specialTagsColumnEnsured = true;
    } catch {
      // Non-fatal if running against mock or read-only DB
    }
  }
  await seedMedicalCurriculumIfEmpty();
}

export function sanitizeUserForClient<T extends { passwordHash?: string | null }>(
  user: T
): Omit<T, 'passwordHash'> & { hasPassword: boolean } {
  const { passwordHash, ...safeUser } = user;
  return {
    ...safeUser,
    hasPassword: Boolean(passwordHash && passwordHash.length > 0),
  };
}

/**
 * Verifies in PostgreSQL that the acting user is currently an active, non-deleted administrator.
 */
export async function assertActiveAdminInDb(adminUid: string) {
  if (!adminUid || typeof adminUid !== 'string') {
    throw new ClientSafeError('Forbidden: Administrator privileges required.', 403);
  }
  const rows = await db
    .select()
    .from(users)
    .where(or(eq(users.uid, adminUid), eq(users.firebaseUid, adminUid)));
  const actor = rows[0];
  if (
    !actor ||
    actor.accountStatus !== 'active' ||
    actor.deletedAt !== null ||
    actor.role !== 'admin'
  ) {
    throw new ClientSafeError('Forbidden: Administrator privileges required.', 403);
  }
  return actor;
}

/**
 * Looks up an already-existing active user by UID (or mapped firebaseUid) without creating or
 * resurrecting accounts, and NEVER auto-promotes local or unverified accounts to administrator.
 */
export async function getAuthenticatedUserByUid(uid: string) {
  const tombstones = await db
    .select()
    .from(deletedAccounts)
    .where(or(eq(deletedAccounts.uid, uid), eq(deletedAccounts.firebaseUid, uid)));

  if (tombstones.length > 0) {
    throw new ClientSafeError('Unauthorized: This account has been deleted.', 401);
  }

  const rows = await db
    .select()
    .from(users)
    .where(or(eq(users.uid, uid), eq(users.firebaseUid, uid)));
  const user = rows[0];
  if (!user || user.accountStatus !== 'active' || user.deletedAt !== null) {
    return null;
  }

  return user;
}

/**
 * Synchronizes or provisions a user authenticated via a verified Firebase ID token,
 * or returns the existing database profile for a local session user.
 * - Never resurrects deleted accounts and never overwrites an existing user's UID or bound email.
 * - Rejects conflicting Firebase UIDs if another account already owns the email address.
 * - Provisions the initial owner administrator ONLY when backed by a verified Firebase Authentication
 *   identity (`authType === 'firebase' && emailVerified === true`), serialized under a PostgreSQL
 *   transaction advisory lock so concurrent first-admin requests cannot race.
 */
export async function getOrCreateUser(
  uid: string,
  email: string,
  displayName?: string,
  options?: {
    authType?: 'local' | 'firebase';
    emailVerified?: boolean;
    allowCreate?: boolean;
  }
) {
  try {
    await ensureSeededDatabase();
    const normalizedEmail = email.toLowerCase().trim();
    const isVerifiedFirebaseIdentity =
      options?.authType === 'firebase' && options?.emailVerified === true;
    const isOwner = isOwnerAdminEmail(normalizedEmail);
    const defaultName =
      displayName?.trim() || normalizedEmail.split('@')[0] || 'Medical Student';

    // 1. Check permanent UID / firebaseUid tombstones first so deleted identities can never be resurrected
    const tombstoneRows = await db
      .select()
      .from(deletedAccounts)
      .where(or(eq(deletedAccounts.uid, uid), eq(deletedAccounts.firebaseUid, uid)));

    if (tombstoneRows.length > 0) {
      throw new ClientSafeError('Unauthorized: This account has been deleted.', 401);
    }

    // 2. Check existing user by primary UID or mapped firebaseUid
    const existingByIdentity = await db
      .select()
      .from(users)
      .where(or(eq(users.uid, uid), eq(users.firebaseUid, uid)));

    if (existingByIdentity.length > 0) {
      const user = existingByIdentity[0];
      if (user.deletedAt !== null || user.accountStatus === 'deleted') {
        throw new ClientSafeError(
          'Unauthorized: This account has been deactivated or deleted.',
          401
        );
      }
      if (user.accountStatus !== 'active') {
        throw new ClientSafeError(
          'Forbidden: This account is suspended or inactive.',
          403
        );
      }
      // Prevent silent account or administrator reassignment if email changed on provider
      if (user.email.toLowerCase().trim() !== normalizedEmail) {
        throw new ClientSafeError(
          'Conflict: Authenticated email address does not match the email bound to this account.',
          409
        );
      }

      // Only promote an existing verified Firebase owner account if it was not yet marked admin
      if (
        isOwner &&
        user.role !== 'admin' &&
        isVerifiedFirebaseIdentity &&
        user.authProvider !== 'local' &&
        user.emailVerified === true
      ) {
        return await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${ADMIN_BOOTSTRAP_ADVISORY_LOCK_ID})`
          );
          const [promotedOwner] = await tx
            .update(users)
            .set({
              role: 'admin',
              firebaseUid: user.firebaseUid || uid,
              updatedAt: new Date(),
            })
            .where(eq(users.uid, user.uid))
            .returning();
          return promotedOwner;
        });
      }
      return user;
    }

    // Local session tokens must correspond to an already-registered database row;
    // never auto-create a user unless authenticated via an authoritative provider flow (e.g. verified Firebase ID token).
    if (
      options?.authType !== 'firebase' ||
      options?.allowCreate === false
    ) {
      throw new ClientSafeError('Unauthorized: Account no longer exists.', 401);
    }

    // 3. For Firebase-authenticated users, strictly require emailVerified === true
    if (options?.emailVerified !== true) {
      throw new ClientSafeError(
        'Forbidden: A verified email address is required to create or access an account.',
        403
      );
    }

    // 4. Serialize creation & initial admin bootstrap inside a PostgreSQL transaction with an advisory lock
    return await db.transaction(async (tx) => {
      if (isOwner) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${ADMIN_BOOTSTRAP_ADVISORY_LOCK_ID})`
        );
      }

      // Re-check UID inside transaction in case of concurrent requests from the same verified user
      const concurrentByIdentity = await tx
        .select()
        .from(users)
        .where(or(eq(users.uid, uid), eq(users.firebaseUid, uid)));
      if (concurrentByIdentity.length > 0) {
        return concurrentByIdentity[0];
      }

      // Check if another account already owns this email address. Never overwrite an existing account's UID!
      const existingByEmail = await tx
        .select()
        .from(users)
        .where(eq(users.email, normalizedEmail));

      if (existingByEmail.length > 0) {
        const existingUser = existingByEmail[0];
        if (existingUser.uid !== uid && existingUser.firebaseUid !== uid) {
          throw new ClientSafeError(
            'An account with this email address already exists under a different sign-in method. Please sign in using your original credentials.',
            409
          );
        }
        return existingUser;
      }

      // Also check if this email was previously deleted and belongs to an un-re-registered tombstone
      // where the presenting Firebase UID was the shadow identity of the deleted account
      const emailTombstones = await tx
        .select()
        .from(deletedAccounts)
        .where(eq(deletedAccounts.emailHash, hashEmailForTombstone(normalizedEmail)));

      if (
        emailTombstones.some(
          (t) => t.uid === uid || (t.firebaseUid !== null && t.firebaseUid === uid)
        )
      ) {
        throw new ClientSafeError('Unauthorized: This account has been deleted.', 401);
      }

      // Grant initial owner admin role ONLY to the verified Firebase owner identity
      const initialRole =
        isVerifiedFirebaseIdentity && isOwner ? 'admin' : 'student';

      const [created] = await tx
        .insert(users)
        .values({
          uid,
          firebaseUid: uid,
          email: normalizedEmail,
          displayName: defaultName,
          authProvider: 'firebase',
          role: initialRole,
          subscriptionTier: 'free_trial',
          subscriptionStatus: 'active',
          accountStatus: 'active',
          tokenVersion: 1,
          emailVerified: true,
        })
        .returning();

      return created;
    });
  } catch (error: any) {
    if (error instanceof ClientSafeError) throw error;
    if (error?.code === '23505') {
      throw new ClientSafeError(
        'An account with this email address already exists.',
        409
      );
    }
    console.error('Database error in getOrCreateUser:', error);
    throw new Error('Failed to synchronize user profile.', { cause: error });
  }
}

/**
 * Registers a brand-new local email/password user.
 * Security guarantees:
 * 1. NEVER grants administrator privileges during local registration, even if email matches OWNER_ADMIN_EMAIL.
 * 2. NEVER marks a newly registered local account as emailVerified = true without email verification.
 * 3. NEVER attaches a password to an existing user account (whether local or provider-based).
 * 4. NEVER deletes historical UID tombstones from `deleted_accounts`, preserving deleted-UID protection
 *    even when the same email address is registered again under a brand-new local UID.
 * 5. Enforces strict password bounds (8–128 chars, <= 512 bytes) and hashes asynchronously before DB lookup.
 */
export async function registerEmailPasswordUser(
  email: string,
  password: string,
  displayName: string
) {
  try {
    await ensureSeededDatabase();
    if (typeof email !== 'string') {
      throw new ClientSafeError('Please provide a valid email address.', 400);
    }
    const normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail || !normalizedEmail.includes('@') || normalizedEmail.length > 254) {
      throw new ClientSafeError('Please provide a valid email address.', 400);
    }

    const pwdCheck = validatePasswordBounds(password, {
      fieldName: 'Password',
      requireMinLength: true,
    });
    if (!pwdCheck.valid) {
      throw new ClientSafeError(pwdCheck.error!, 400);
    }

    if (typeof displayName !== 'string' || displayName.trim().length < 2) {
      throw new ClientSafeError(
        'Please enter your full name or display name (at least 2 characters).',
        400
      );
    }
    if (displayName.trim().length > 120) {
      throw new ClientSafeError(
        'Display name must not exceed 120 characters.',
        400
      );
    }

    // Perform async scrypt hashing BEFORE querying the database so response timing is uniform
    // whether the email already exists or not.
    const passwordHash = await hashPasswordAsync(password);
    const now = new Date();

    const existing = await db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail));

    if (existing.length > 0) {
      // Uniform conflict error: never attach a password to an existing account or disclose provider/status
      throw new ClientSafeError(
        'An account with this email address already exists. Please sign in instead.',
        409
      );
    }

    const uid = `usr_${computeContentHash(`${normalizedEmail}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`)}`;

    const created = await db.transaction(async (tx) => {
      const concurrentExisting = await tx
        .select()
        .from(users)
        .where(eq(users.email, normalizedEmail));
      if (concurrentExisting.length > 0) {
        throw new ClientSafeError(
          'An account with this email address already exists. Please sign in instead.',
          409
        );
      }

      // IMPORTANT: Do NOT delete historical rows in `deleted_accounts`!
      // Preserving tombstones ensures that any old deleted UID or shadow Firebase UID for this email
      // remains permanently blocked even after the email is re-registered under a new `uid`.

      const [inserted] = await tx
        .insert(users)
        .values({
          uid,
          firebaseUid: null,
          email: normalizedEmail,
          displayName: displayName.trim(),
          passwordHash,
          passwordUpdatedAt: now,
          pendingRecoveryAt: null,
          sessionsRevokedAt: null,
          authProvider: 'local',
          role: 'student',
          subscriptionTier: 'free_trial',
          subscriptionStatus: 'active',
          accountStatus: 'active',
          tokenVersion: 1,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return inserted;
    });

    // Best-effort asynchronous provisioning in Firebase Auth so the account is ready for Firebase password reset,
    // recording the mapped firebaseUid on the user row if obtained.
    ensureUserExistsInFirebaseAuth(normalizedEmail, displayName.trim(), created.uid).catch(
      () => {}
    );

    return created;
  } catch (error: any) {
    if (error instanceof ClientSafeError) throw error;
    if (error?.code === '23505') {
      throw new ClientSafeError(
        'An account with this email address already exists. Please sign in instead.',
        409
      );
    }
    console.error('Error registering user:', error);
    throw new Error('Failed to register account. Please try again.', { cause: error });
  }
}

/**
 * Looks up an active user by email without ever mutating roles or promoting unverified users.
 */
export async function findUserByEmail(email: string) {
  try {
    await ensureSeededDatabase();
    const normalizedEmail = email.toLowerCase().trim();
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail));
    const user = rows[0] || null;
    if (!user || user.accountStatus !== 'active' || user.deletedAt !== null) {
      return null;
    }
    return user;
  } catch (error) {
    console.error('Error finding user by email:', error);
    throw new Error('Database lookup failed.', { cause: error });
  }
}

export const DEFAULT_TRUSTED_RECOVERY_ORIGINS = [
  'https://medatlas.ai.studio',
  'https://ais-dev-5mhsafvm6orewiuxge6ast-323922691346.europe-west1.run.app',
  'https://ais-pre-5mhsafvm6orewiuxge6ast-323922691346.europe-west1.run.app',
];

/**
 * Strictly validates a single origin string:
 * - Rejects whitespace, credentials (`user:pass@`), non-root paths, query strings (`?`), and fragments (`#`).
 * - Requires `https:` in production and for all non-localhost origins.
 * - Permits `http://localhost:<port>` and `http://127.0.0.1:<port>` ONLY when `allowHttpLocalhost === true`.
 */
function parseAndValidateOriginStrict(
  rawOrigin: string,
  options: { allowHttpLocalhost: boolean }
): string {
  if (typeof rawOrigin !== 'string') {
    throw new ClientSafeError('Invalid password recovery origin URL.', 400);
  }
  const trimmed = rawOrigin.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new ClientSafeError('Invalid password recovery origin URL.', 400);
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    throw new ClientSafeError(
      'Recovery origin must not contain paths, query strings, or fragments.',
      400
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ClientSafeError('Invalid password recovery origin URL.', 400);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ClientSafeError('Invalid password recovery origin protocol.', 400);
  }
  if (parsed.username || parsed.password) {
    throw new ClientSafeError('Credentials are not permitted in recovery origin.', 400);
  }
  if (
    (parsed.pathname && parsed.pathname !== '/') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ClientSafeError(
      'Recovery origin must not contain paths, query strings, or fragments.',
      400
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';

  if (parsed.protocol === 'http:') {
    if (!options.allowHttpLocalhost || !isLocalhost) {
      throw new ClientSafeError(
        'HTTPS is required for password recovery origins.',
        400
      );
    }
  }

  return parsed.origin;
}

/**
 * Validates and normalizes the recovery origin used to construct password-reset links.
 * Security policy:
 * - Uses an exact allowlist of approved origins (`DEFAULT_TRUSTED_RECOVERY_ORIGINS` + validated `APP_URL` +
 *   validated `ALLOWED_RECOVERY_ORIGINS`).
 * - Does NOT trust arbitrary `*.ai.studio` or `*.run.app` subdomains.
 * - Requires HTTPS for every production origin, including `APP_URL` and `ALLOWED_RECOVERY_ORIGINS`.
 * - Permits localhost HTTP only in non-production environments.
 */
export function validateTrustedRecoveryOrigin(
  candidateOrigin?: string | null,
  envOverrides?: {
    nodeEnv?: string;
    appUrl?: string;
    allowedRecoveryOrigins?: string;
  }
): string {
  const effectiveNodeEnv = envOverrides?.nodeEnv ?? process.env.NODE_ENV;
  const isProduction = effectiveNodeEnv === 'production';
  const allowHttpLocalhost = !isProduction;

  const allowedOrigins = new Set<string>(DEFAULT_TRUSTED_RECOVERY_ORIGINS);

  if (allowHttpLocalhost) {
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://127.0.0.1:3000');
    allowedOrigins.add('http://localhost:5173');
    allowedOrigins.add('http://127.0.0.1:5173');
  }

  let validatedAppUrlOrigin: string | null = null;
  const rawAppUrl = (envOverrides?.appUrl ?? process.env.APP_URL ?? '').trim();
  if (rawAppUrl && rawAppUrl !== 'MY_APP_URL') {
    const parsedAppOrigin = parseAndValidateOriginStrict(rawAppUrl, {
      allowHttpLocalhost,
    });
    allowedOrigins.add(parsedAppOrigin);
    validatedAppUrlOrigin = parsedAppOrigin;
  }

  const rawExtraOrigins =
    envOverrides?.allowedRecoveryOrigins ?? process.env.ALLOWED_RECOVERY_ORIGINS ?? '';
  if (rawExtraOrigins.trim().length > 0) {
    for (const entry of rawExtraOrigins.split(',')) {
      const trimmedEntry = entry.trim();
      if (!trimmedEntry) continue;
      const parsedExtra = parseAndValidateOriginStrict(trimmedEntry, {
        allowHttpLocalhost,
      });
      allowedOrigins.add(parsedExtra);
    }
  }

  const defaultCanonicalOrigin = validatedAppUrlOrigin || 'https://medatlas.ai.studio';

  if (
    candidateOrigin === undefined ||
    candidateOrigin === null ||
    (typeof candidateOrigin === 'string' && candidateOrigin.trim() === '')
  ) {
    return defaultCanonicalOrigin;
  }

  const normalizedCandidate = parseAndValidateOriginStrict(candidateOrigin, {
    allowHttpLocalhost,
  });

  if (!allowedOrigins.has(normalizedCandidate)) {
    throw new ClientSafeError(
      'Untrusted password recovery origin rejected.',
      400
    );
  }

  return normalizedCandidate;
}

/**
 * Extracts a clean `oobCode` or recovery `token` whether the user supplied a raw token string
 * or pasted a full password-reset URL from their email (e.g. `https://.../?mode=resetPassword&oobCode=...`).
 */
export function extractRecoveryCodeFromInput(rawInput: string): string {
  if (typeof rawInput !== 'string') return '';
  const trimmed = rawInput.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      const fromQuery =
        parsed.searchParams.get('oobCode')?.trim() ||
        parsed.searchParams.get('resetToken')?.trim() ||
        parsed.searchParams.get('token')?.trim() ||
        '';
      if (fromQuery) return fromQuery;
    } catch {
      return '';
    }
  }

  if (trimmed.includes('oobCode=') || trimmed.includes('token=')) {
    try {
      const searchPart = trimmed.includes('?')
        ? trimmed.slice(trimmed.indexOf('?') + 1)
        : trimmed;
      const params = new URLSearchParams(searchPart);
      const extracted =
        params.get('oobCode')?.trim() ||
        params.get('resetToken')?.trim() ||
        params.get('token')?.trim() ||
        '';
      if (extracted) return extracted;
    } catch {
      // fall through to raw token
    }
  }

  return trimmed;
}

export interface LocalEmailDeliveryPayload {
  to: string;
  displayName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export type LocalEmailTransportFn = (
  payload: LocalEmailDeliveryPayload
) => Promise<void>;

export type FirebaseProvisioningResult =
  | boolean
  | { provisioned: boolean; firebaseUid?: string };

export type FirebaseProvisioningHandlerForTests = (
  email: string,
  displayName?: string
) => Promise<FirebaseProvisioningResult>;

export type FirebaseEmailDispatchHandlerForTests = (
  email: string,
  continueUrl?: string
) => Promise<boolean>;

export type FirebasePasswordUpdateHandlerForTests = (params: {
  uid: string;
  firebaseUid?: string | null;
  email: string;
  currentPassword?: string;
  newPassword: string;
}) => Promise<boolean>;

export type FirebasePasswordVerifyHandlerForTests = (
  email: string,
  password: string
) => Promise<{ valid: boolean; firebaseUid?: string; definiteRejection?: boolean } | boolean>;

export type FirebaseAccountDeletionHandlerForTests = (params: {
  uid: string;
  firebaseUid?: string | null;
  email?: string;
}) => Promise<{ deleted: boolean; errorCode?: string }>;

let customFirebaseProvisioningForTests: FirebaseProvisioningHandlerForTests | null = null;
let customFirebaseEmailDispatchForTests: FirebaseEmailDispatchHandlerForTests | null = null;
let customFirebasePasswordUpdateForTests: FirebasePasswordUpdateHandlerForTests | null = null;
let customFirebasePasswordVerifyForTests: FirebasePasswordVerifyHandlerForTests | null = null;
let customFirebaseAccountDeletionForTests: FirebaseAccountDeletionHandlerForTests | null = null;

export function setFirebaseProvisioningHandlerForTests(
  handler: FirebaseProvisioningHandlerForTests | null
): void {
  assertTestEnvironmentForOverride('setFirebaseProvisioningHandlerForTests', handler);
  customFirebaseProvisioningForTests = handler;
}

export function setFirebaseEmailDispatchHandlerForTests(
  handler: FirebaseEmailDispatchHandlerForTests | null
): void {
  assertTestEnvironmentForOverride('setFirebaseEmailDispatchHandlerForTests', handler);
  customFirebaseEmailDispatchForTests = handler;
}

export function setFirebasePasswordUpdateHandlerForTests(
  handler: FirebasePasswordUpdateHandlerForTests | null
): void {
  assertTestEnvironmentForOverride('setFirebasePasswordUpdateHandlerForTests', handler);
  customFirebasePasswordUpdateForTests = handler;
}

export function setFirebasePasswordVerifyHandlerForTests(
  handler: FirebasePasswordVerifyHandlerForTests | null
): void {
  assertTestEnvironmentForOverride('setFirebasePasswordVerifyHandlerForTests', handler);
  customFirebasePasswordVerifyForTests = handler;
}

export function setFirebaseAccountDeletionHandlerForTests(
  handler: FirebaseAccountDeletionHandlerForTests | null
): void {
  assertTestEnvironmentForOverride('setFirebaseAccountDeletionHandlerForTests', handler);
  customFirebaseAccountDeletionForTests = handler;
}

let simulateDbFailureAfterProviderSyncForTests:
  | ((uid: string) => Promise<void>)
  | null = null;

export function setSimulateDbFailureAfterProviderSyncForTests(
  handler: ((uid: string) => Promise<void>) | null
): void {
  assertTestEnvironmentForOverride('setSimulateDbFailureAfterProviderSyncForTests', handler);
  simulateDbFailureAfterProviderSyncForTests = handler;
}

/**
 * Dispatches a password-reset email using the configured Firebase Authentication project
 * (Identity Toolkit accounts:sendOobCode API).
 * Security requirement: Does NOT silently strip `continueUrl` or fall back to an untrusted flow
 * if the continueUrl is rejected by Firebase.
 */
export async function dispatchFirebasePasswordResetEmail(
  email: string,
  continueUrl?: string
): Promise<boolean> {
  if (process.env.NODE_ENV === 'test' && customFirebaseEmailDispatchForTests) {
    return customFirebaseEmailDispatchForTests(email, continueUrl);
  }

  const apiKey = firebaseConfig?.apiKey?.trim();
  if (!apiKey) return false;

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const payload: Record<string, string> = {
      requestType: 'PASSWORD_RESET',
      email: normalizedEmail,
    };
    if (continueUrl) {
      payload.continueUrl = continueUrl;
    }

    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    if (res.ok) return true;

    const errorBody: any = await res.json().catch(() => null);
    console.error('Firebase Auth sendOobCode rejected:', {
      status: res.status,
      code: errorBody?.error?.message || 'UNKNOWN_ERROR',
    });
    return false;
  } catch (err: any) {
    console.error('Firebase Auth sendOobCode network error:', {
      message: err?.message,
    });
    return false;
  }
}

/**
 * Ensures an active user account exists in Firebase Authentication so that Firebase's
 * built-in password reset infrastructure (Identity Toolkit) can deliver reset emails,
 * and persists the discovered `firebaseUid` onto the PostgreSQL `users` record when available.
 */
export async function ensureUserExistsInFirebaseAuth(
  email: string,
  displayName?: string,
  localUserUid?: string
): Promise<boolean> {
  if (process.env.NODE_ENV === 'test' && customFirebaseProvisioningForTests) {
    const result = await customFirebaseProvisioningForTests(email, displayName);
    if (typeof result === 'object' && result !== null) {
      if (result.provisioned && result.firebaseUid && localUserUid) {
        await db
          .update(users)
          .set({ firebaseUid: result.firebaseUid })
          .where(and(eq(users.uid, localUserUid), isNull(users.firebaseUid)))
          .catch(() => {});
      }
      return result.provisioned;
    }
    return Boolean(result);
  }

  const normalizedEmail = email.toLowerCase().trim();

  const persistFirebaseUid = async (discoveredFbUid?: string) => {
    if (!discoveredFbUid || typeof discoveredFbUid !== 'string') return;
    if (localUserUid) {
      await db
        .update(users)
        .set({ firebaseUid: discoveredFbUid })
        .where(and(eq(users.uid, localUserUid), isNull(users.firebaseUid)))
        .catch(() => {});
    } else {
      await db
        .update(users)
        .set({ firebaseUid: discoveredFbUid })
        .where(and(eq(users.email, normalizedEmail), isNull(users.firebaseUid)))
        .catch(() => {});
    }
  };

  // 1. Try Firebase Admin SDK if available
  try {
    const existing = await adminAuth.getUserByEmail(normalizedEmail);
    if (existing?.uid) {
      await persistFirebaseUid(existing.uid);
      return true;
    }
  } catch (err: any) {
    const code = String(err?.code || '');
    if (code === 'auth/user-not-found') {
      try {
        const createdFb = await adminAuth.createUser({
          email: normalizedEmail,
          displayName: displayName || undefined,
          emailVerified: false,
        });
        await persistFirebaseUid(createdFb.uid);
        return true;
      } catch (createErr: any) {
        if (createErr?.code === 'auth/email-already-exists') return true;
        console.error('Firebase Admin createUser error:', {
          code: createErr?.code,
          message: createErr?.message,
        });
      }
    }
  }

  // 2. Identity Toolkit API fallback via apiKey if Admin SDK lacks IAM permissions
  const apiKey = firebaseConfig?.apiKey?.trim();
  if (!apiKey) {
    console.error('Firebase Auth provisioning failed: apiKey is missing from config');
    return false;
  }

  try {
    const tempPassword = `Tmp_${crypto.randomBytes(16).toString('hex')}!Aa1`;
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: normalizedEmail,
          password: tempPassword,
          returnSecureToken: false,
        }),
      }
    );
    const body: any = await res.json().catch(() => null);
    if (res.ok) {
      if (typeof body?.localId === 'string') {
        await persistFirebaseUid(body.localId);
      }
      return true;
    }
    if (body?.error?.message === 'EMAIL_EXISTS') {
      return true;
    }
    console.error('Identity Toolkit accounts:signUp rejected:', {
      status: res.status,
      code: body?.error?.message || 'UNKNOWN_ERROR',
    });
    return false;
  } catch (err: any) {
    console.error('Failed to provision user in Firebase Auth:', {
      message: err?.message,
    });
    return false;
  }
}

/**
 * Verifies user credentials against Firebase Authentication (Identity Toolkit).
 * Returns structured status so callers can distinguish a valid login, a definitive invalid-password
 * response, or a network/provider error, and captures `localId` (`firebaseUid`) when present.
 */
export async function verifyPasswordWithFirebaseDetailed(
  email: string,
  password: string
): Promise<{
  valid: boolean;
  firebaseUid?: string;
  definiteRejection: boolean;
}> {
  if (process.env.NODE_ENV === 'test' && customFirebasePasswordVerifyForTests) {
    const customRes = await customFirebasePasswordVerifyForTests(email, password);
    if (typeof customRes === 'boolean') {
      return { valid: customRes, definiteRejection: !customRes };
    }
    return {
      valid: customRes.valid,
      firebaseUid: customRes.firebaseUid,
      definiteRejection: customRes.definiteRejection ?? !customRes.valid,
    };
  }

  const apiKey = firebaseConfig?.apiKey?.trim();
  if (!apiKey || !password) {
    return { valid: false, definiteRejection: false };
  }

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.toLowerCase().trim(),
          password,
          returnSecureToken: false,
        }),
      }
    );
    const body: any = await res.json().catch(() => null);
    if (res.ok) {
      return {
        valid: true,
        firebaseUid: typeof body?.localId === 'string' ? body.localId : undefined,
        definiteRejection: false,
      };
    }
    const errCode = String(body?.error?.message || '');
    const isDefiniteRejection =
      errCode === 'INVALID_PASSWORD' ||
      errCode === 'INVALID_LOGIN_CREDENTIALS' ||
      errCode === 'USER_DISABLED';
    return {
      valid: false,
      definiteRejection: isDefiniteRejection,
    };
  } catch {
    return { valid: false, definiteRejection: false };
  }
}

export async function verifyPasswordWithFirebase(
  email: string,
  password: string
): Promise<boolean> {
  const res = await verifyPasswordWithFirebaseDetailed(email, password);
  return res.valid;
}

/**
 * Synchronizes a user's new password to Firebase Authentication when the account has a linked
 * or provisioned Firebase identity (`firebaseUid` or `authProvider` in `'firebase' | 'both' | 'linked'`).
 * - Tries Firebase Admin SDK `adminAuth.updateUser` first.
 * - Falls back to Identity Toolkit `accounts:signInWithPassword` (using `currentPassword`) + `accounts:update`
 *   when `currentPassword` is available and Admin SDK lacks IAM permissions.
 */
async function syncPasswordToFirebaseProvider(params: {
  uid: string;
  firebaseUid?: string | null;
  authProvider?: string | null;
  email: string;
  currentPassword?: string;
  newPassword: string;
  requireSuccess: boolean;
}): Promise<boolean> {
  const targetFbUid = resolveUserFirebaseUid({
    uid: params.uid,
    firebaseUid: params.firebaseUid,
    authProvider: params.authProvider,
  });

  if (!targetFbUid && !params.requireSuccess) {
    return true;
  }

  if (process.env.NODE_ENV === 'test' && customFirebasePasswordUpdateForTests) {
    return customFirebasePasswordUpdateForTests(params);
  }

  // 1. Try Firebase Admin SDK if we have a target Firebase UID or can look up by email
  try {
    const resolvedUid =
      targetFbUid || (await adminAuth.getUserByEmail(params.email))?.uid;
    if (resolvedUid) {
      await adminAuth.updateUser(resolvedUid, { password: params.newPassword });
      try {
        await adminAuth.revokeRefreshTokens(resolvedUid);
      } catch {
        // best-effort token revocation
      }
      return true;
    }
  } catch (adminErr: any) {
    const code = String(adminErr?.code || '');
    if (code === 'auth/user-not-found' && !params.requireSuccess) {
      return true;
    }
  }

  // 2. If currentPassword is known, use Identity Toolkit signInWithPassword -> accounts:update
  const apiKey = firebaseConfig?.apiKey?.trim();
  if (apiKey && params.currentPassword) {
    try {
      const signInRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: params.email.toLowerCase().trim(),
            password: params.currentPassword,
            returnSecureToken: true,
          }),
        }
      );
      if (signInRes.ok) {
        const signInBody: any = await signInRes.json().catch(() => null);
        const idToken = signInBody?.idToken;
        if (idToken) {
          const updateRes = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${encodeURIComponent(apiKey)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                idToken,
                password: params.newPassword,
                returnSecureToken: false,
              }),
            }
          );
          if (updateRes.ok) {
            return true;
          }
        }
      } else {
        const errBody: any = await signInRes.json().catch(() => null);
        const errMsg = String(errBody?.error?.message || '');
        // If the user has no password credential or does not exist in Firebase, no stale Firebase password exists
        if (errMsg === 'EMAIL_NOT_FOUND' || errMsg === 'INVALID_PASSWORD' || errMsg === 'INVALID_LOGIN_CREDENTIALS') {
          if (!params.requireSuccess) return true;
        }
      }
    } catch {
      // fall through
    }
  }

  if (process.env.NODE_ENV === 'test' && !customFirebasePasswordUpdateForTests) {
    return true;
  }

  return !params.requireSuccess;
}

/**
 * Authenticates an email/password user against the authoritative PostgreSQL `passwordHash`.
 * Security guarantees:
 * 1. Validates password bounds (max 128 chars / 512 bytes) before any scrypt work.
 * 2. Performs constant-time dummy scrypt verification when an email is not found.
 * 3. NEVER allows a stale Firebase password to overwrite a newer local password (`changeAuthenticatedUserPassword`
 *    clears `pendingRecoveryAt = null` and updates `passwordUpdatedAt`).
 * 4. Permits Firebase recovery synchronization ONLY when an explicit, unconsumed `pendingRecoveryAt`
 *    window is active (`pendingRecoveryAt > passwordUpdatedAt` and within `RECOVERY_TOKEN_TTL_MS`).
 *    During an active `pendingRecoveryAt` window, if the user already reset their password on Firebase's
 *    hosted page, the old local password is immediately rejected and invalidated.
 */
export async function authenticateEmailUser(email: string, password: string) {
  if (typeof email !== 'string' || typeof password !== 'string') {
    return null;
  }
  const pwdCheck = validatePasswordBounds(password, {
    fieldName: 'Password',
    requireMinLength: false,
  });
  if (!pwdCheck.valid) {
    throw new ClientSafeError(pwdCheck.error!, 400);
  }

  const normalizedEmail = email.toLowerCase().trim();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return null;
  }

  // Check tombstones and existing user
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizedEmail));
  const user = rows[0] || null;

  if (!user || user.deletedAt !== null || user.accountStatus === 'deleted') {
    await verifyPasswordAsync(password, DUMMY_SCRYPT_HASH);
    return null;
  }

  // Check if this user's UID or firebaseUid is in deleted_accounts
  const tombstones = await db
    .select()
    .from(deletedAccounts)
    .where(
      user.firebaseUid
        ? or(
            eq(deletedAccounts.uid, user.uid),
            eq(deletedAccounts.firebaseUid, user.firebaseUid)
          )
        : eq(deletedAccounts.uid, user.uid)
    );
  if (tombstones.length > 0) {
    await verifyPasswordAsync(password, DUMMY_SCRYPT_HASH);
    return null;
  }

  const nowMs = Date.now();
  const pendingRecoveryMs = user.pendingRecoveryAt
    ? new Date(user.pendingRecoveryAt).getTime()
    : null;
  const passwordUpdatedMs = user.passwordUpdatedAt
    ? new Date(user.passwordUpdatedAt).getTime()
    : 0;

  // A Firebase hosted-UI recovery window is active ONLY if a recovery email was requested within
  // RECOVERY_TOKEN_TTL_MS (15 minutes) AND no newer password update has occurred since then.
  const hasActiveRecoveryWindow =
    pendingRecoveryMs !== null &&
    nowMs - pendingRecoveryMs <= RECOVERY_TOKEN_TTL_MS &&
    pendingRecoveryMs > passwordUpdatedMs;

  const matchesLocal = Boolean(
    user.passwordHash && (await verifyPasswordAsync(password, user.passwordHash))
  );

  if (matchesLocal) {
    // If a recovery window is currently active, check whether the user already completed a reset
    // on Firebase's hosted page (which would mean Firebase now rejects the old password).
    if (hasActiveRecoveryWindow) {
      const fbCheck = await verifyPasswordWithFirebaseDetailed(user.email, password);
      if (fbCheck.definiteRejection) {
        const now = new Date();
        await db
          .update(users)
          .set({
            passwordHash: null,
            sessionsRevokedAt: now,
            tokenVersion: sql`${users.tokenVersion} + 1`,
            updatedAt: now,
          })
          .where(eq(users.uid, user.uid));
        recordUserSessionRevocation(user.uid, now.getTime());
        if (user.firebaseUid) {
          recordUserSessionRevocation(user.firebaseUid, now.getTime());
        }
        return null;
      }
    }

    if (user.accountStatus !== 'active') {
      throw new ClientSafeError('This account is suspended or inactive.', 403);
    }
    return user;
  }

  // Local hash did NOT match.
  // ONLY consult Firebase if `hasActiveRecoveryWindow` is true (never after a local password change
  // or during normal operation without an active recovery request!).
  if (hasActiveRecoveryWindow) {
    const fbCheck = await verifyPasswordWithFirebaseDetailed(user.email, password);
    if (fbCheck.valid) {
      // Ensure any returned firebaseUid is not a tombstoned identity from a previously deleted account
      if (fbCheck.firebaseUid) {
        const fbTombstones = await db
          .select()
          .from(deletedAccounts)
          .where(
            or(
              eq(deletedAccounts.uid, fbCheck.firebaseUid),
              eq(deletedAccounts.firebaseUid, fbCheck.firebaseUid)
            )
          );
        if (fbTombstones.length > 0) {
          return null;
        }
      }

      if (user.accountStatus !== 'active') {
        throw new ClientSafeError('This account is suspended or inactive.', 403);
      }

      const newHash = await hashPasswordAsync(password);
      const now = new Date();
      const nextProvider =
        user.authProvider === 'local' || user.authProvider === 'firebase'
          ? 'both'
          : user.authProvider;

      const [updated] = await db
        .update(users)
        .set({
          passwordHash: newHash,
          firebaseUid: fbCheck.firebaseUid || user.firebaseUid || null,
          authProvider: nextProvider,
          passwordUpdatedAt: now,
          pendingRecoveryAt: null,
          sessionsRevokedAt: now,
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(users.uid, user.uid))
        .returning();

      recordUserSessionRevocation(user.uid, now.getTime());
      if (updated.firebaseUid) {
        recordUserSessionRevocation(updated.firebaseUid, now.getTime());
      }
      return updated;
    }
  }

  return null;
}

export interface FirebaseOobHandlerForTests {
  verifyOnly: (oobCode: string) => Promise<{ email: string }>;
  consume: (oobCode: string, newPassword: string) => Promise<{ email: string }>;
}

let customFirebaseOobHandlerForTests: FirebaseOobHandlerForTests | null = null;

export function setFirebaseOobHandlerForTests(
  handler: FirebaseOobHandlerForTests | null
): void {
  assertTestEnvironmentForOverride('setFirebaseOobHandlerForTests', handler);
  customFirebaseOobHandlerForTests = handler;
}

/**
 * Phase 1: Verifies a Firebase Authentication password-reset oobCode with Identity Toolkit
 * WITHOUT consuming it yet, so we can validate PostgreSQL account state before mutating Firebase.
 */
async function verifyFirebaseOobCodeWithoutConsuming(
  oobCode: string
): Promise<string> {
  if (process.env.NODE_ENV === 'test' && customFirebaseOobHandlerForTests) {
    const res = await customFirebaseOobHandlerForTests.verifyOnly(oobCode);
    return res.email.toLowerCase().trim();
  }

  const apiKey = firebaseConfig?.apiKey?.trim();
  if (!apiKey) {
    throw new ClientSafeError(
      'Invalid, expired, or already used password recovery token.',
      400
    );
  }

  let res: Response;
  try {
    res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oobCode }),
      }
    );
  } catch {
    throw new ClientSafeError(
      'Failed to verify password recovery code with authentication provider.',
      503
    );
  }

  if (!res.ok) {
    const errBody: any = await res.json().catch(() => null);
    const errCode = String(errBody?.error?.message || '');
    if (res.status >= 500 || errCode === 'INTERNAL_ERROR') {
      throw new ClientSafeError(
        'Password recovery verification service is temporarily unavailable. Please try again shortly.',
        503
      );
    }
    throw new ClientSafeError(
      'Invalid, expired, or already used password recovery token.',
      400
    );
  }

  const data = (await res.json()) as { email?: string; requestType?: string };
  if (
    !data?.email ||
    typeof data.email !== 'string' ||
    (data.requestType && data.requestType !== 'PASSWORD_RESET')
  ) {
    throw new ClientSafeError(
      'Invalid, expired, or already used password recovery token.',
      400
    );
  }

  return data.email.toLowerCase().trim();
}

/**
 * Phase 2: Consumes a verified Firebase Authentication password-reset oobCode and sets the new password.
 */
async function consumeFirebaseOobCode(
  oobCode: string,
  newPassword: string
): Promise<string> {
  if (process.env.NODE_ENV === 'test' && customFirebaseOobHandlerForTests) {
    const res = await customFirebaseOobHandlerForTests.consume(oobCode, newPassword);
    return res.email.toLowerCase().trim();
  }

  const apiKey = firebaseConfig?.apiKey?.trim();
  if (!apiKey) {
    throw new ClientSafeError(
      'Invalid, expired, or already used password recovery token.',
      400
    );
  }

  let res: Response;
  try {
    res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oobCode,
          newPassword,
        }),
      }
    );
  } catch {
    throw new ClientSafeError(
      'Failed to complete password reset with authentication provider.',
      503
    );
  }

  if (!res.ok) {
    const errBody: any = await res.json().catch(() => null);
    const errCode = String(errBody?.error?.message || '');
    if (res.status >= 500 || errCode === 'INTERNAL_ERROR') {
      throw new ClientSafeError(
        'Password recovery service is temporarily unavailable. Please try again shortly.',
        503
      );
    }
    throw new ClientSafeError(
      'Invalid, expired, or already used password recovery token.',
      400
    );
  }

  const data = (await res.json()) as { email?: string };
  if (!data?.email || typeof data.email !== 'string') {
    throw new ClientSafeError(
      'Invalid, expired, or already used password recovery token.',
      400
    );
  }

  return data.email.toLowerCase().trim();
}

/**
 * Initiates a coherent password recovery flow using Firebase Authentication's built-in
 * password reset link service (Identity Toolkit `accounts:sendOobCode`):
 * - Guarantees generic confirmation message preventing account enumeration across all states.
 * - Strictly validates the recovery origin against the exact allowlist.
 * - Records `pendingRecoveryAt` on the user row when a recovery email is dispatched so that
 *   both in-app `oobCode` completion and hosted Firebase reset completion are tracked and synchronized.
 */
export async function requestPasswordRecoveryToken(
  email: string,
  options?: {
    origin?: string | null;
    returnTokenForTesting?: boolean;
    enforceDeliveryConfigInTest?: boolean;
    triggerFirebaseEmail?: boolean;
    localEmailTransport?: LocalEmailTransportFn;
  }
): Promise<{
  accepted: true;
  message: string;
  expiresInMinutes: number;
  deliveryChannel?:
    | 'firebase'
    | 'firebase_provisioning_failure'
    | 'firebase_send_failure'
    | 'local_token'
    | 'noop';
  _testRecoveryToken?: string;
}> {
  try {
    const normalizedEmail = String(email || '').toLowerCase().trim();
    if (!normalizedEmail || !normalizedEmail.includes('@') || normalizedEmail.length > 254) {
      throw new ClientSafeError('Please provide a valid email address.', 400);
    }

    // Always validate recovery origin up front so untrusted origins are rejected immediately
    const trustedOrigin = validateTrustedRecoveryOrigin(options?.origin);

    const user = await findUserByEmail(normalizedEmail);
    if (!user) {
      return {
        accepted: true,
        message: GENERIC_PASSWORD_RECOVERY_MESSAGE,
        expiresInMinutes: 15,
        deliveryChannel: 'noop',
      };
    }

    const now = new Date();

    // 1. If explicit custom localEmailTransport is provided (for deterministic unit testing of local tokens),
    // execute the single-use database token lifecycle.
    if (options?.localEmailTransport) {
      if (process.env.NODE_ENV === 'production') {
        throw new ClientSafeError(
          'Custom email transport is forbidden in production.',
          400
        );
      }
      const { rawToken, tokenHash, expiresAt } = generateRecoveryToken();

      const insertedTokenId = await db.transaction(async (tx) => {
        await tx
          .update(passwordResetTokens)
          .set({ consumedAt: now })
          .where(
            and(
              eq(passwordResetTokens.userUid, user.uid),
              isNull(passwordResetTokens.consumedAt)
            )
          );

        const [inserted] = await tx
          .insert(passwordResetTokens)
          .values({
            userUid: user.uid,
            tokenHash,
            expiresAt,
          })
          .returning({ id: passwordResetTokens.id });

        return inserted.id;
      });

      const resetUrl = `${trustedOrigin}/?mode=resetPassword&token=${encodeURIComponent(rawToken)}`;
      try {
        await options.localEmailTransport({
          to: user.email,
          displayName: user.displayName,
          resetUrl,
          expiresInMinutes: 15,
        });
      } catch (deliveryErr) {
        await db
          .update(passwordResetTokens)
          .set({ consumedAt: new Date() })
          .where(eq(passwordResetTokens.id, insertedTokenId));
        throw deliveryErr;
      }

      const response: {
        accepted: true;
        message: string;
        expiresInMinutes: number;
        deliveryChannel: 'local_token';
        _testRecoveryToken?: string;
      } = {
        accepted: true,
        message: GENERIC_PASSWORD_RECOVERY_MESSAGE,
        expiresInMinutes: 15,
        deliveryChannel: 'local_token',
      };

      if (options?.returnTokenForTesting && process.env.NODE_ENV === 'test') {
        response._testRecoveryToken = rawToken;
      }

      return response;
    }

    // 2. Production & Standard Path: Firebase Authentication Built-in Password Reset
    // Invalidate any historical unconsumed DB tokens so only fresh requests are active
    await db
      .update(passwordResetTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(passwordResetTokens.userUid, user.uid),
          isNull(passwordResetTokens.consumedAt)
        )
      );

    // Ensure the user exists in Firebase Auth and record their firebaseUid if discovered
    const provisioned = await ensureUserExistsInFirebaseAuth(
      user.email,
      user.displayName,
      user.uid
    );
    if (!provisioned) {
      console.error('Password recovery: Firebase user provisioning failed for user', {
        uid: user.uid,
        authProvider: user.authProvider,
      });
    }

    const shouldTriggerFirebase =
      options?.triggerFirebaseEmail ?? process.env.NODE_ENV !== 'test';

    let emailDispatched = true;
    if (shouldTriggerFirebase) {
      if (!provisioned) {
        emailDispatched = false;
      } else {
        const resetActionUrl = `${trustedOrigin}/?mode=resetPassword`;
        const sent = await dispatchFirebasePasswordResetEmail(user.email, resetActionUrl);
        if (!sent) {
          console.error(
            'Password recovery: Firebase password reset email dispatch failed for user',
            {
              uid: user.uid,
              authProvider: user.authProvider,
            }
          );
          emailDispatched = false;
        }
      }
    }

    if (shouldTriggerFirebase && provisioned && emailDispatched) {
      await db
        .update(users)
        .set({ pendingRecoveryAt: now })
        .where(eq(users.uid, user.uid));
    }

    const deliveryChannel: 'firebase' | 'firebase_provisioning_failure' | 'firebase_send_failure' =
      !provisioned
        ? 'firebase_provisioning_failure'
        : !emailDispatched
        ? 'firebase_send_failure'
        : 'firebase';

    const response: {
      accepted: true;
      message: string;
      expiresInMinutes: number;
      deliveryChannel: 'firebase' | 'firebase_provisioning_failure' | 'firebase_send_failure';
      _testRecoveryToken?: string;
    } = {
      accepted: true,
      message: GENERIC_PASSWORD_RECOVERY_MESSAGE,
      expiresInMinutes: 15,
      deliveryChannel,
    };

    if (options?.returnTokenForTesting && process.env.NODE_ENV === 'test') {
      response._testRecoveryToken = `test_fb_oob_${crypto.randomBytes(16).toString('hex')}`;
    }

    return response;
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error requesting password recovery token:', error);
    throw new Error('Failed to process password recovery request.', { cause: error });
  }
}

/**
 * Verifies and atomically consumes a single-use password recovery token (or verified Firebase Auth oobCode
 * or full reset URL), updates the user's password hash, synchronizes linked credentials so stale local
 * passwords cannot remain active, and increments tokenVersion + updates `sessionsRevokedAt` to invalidate
 * all prior sessions.
 */
export async function confirmPasswordRecoveryToken(
  rawTokenOrUrl: string,
  newPassword: string,
  options?: { simulateDbFailureAfterConsumeForTests?: () => Promise<void> }
) {
  try {
    const cleanedToken = extractRecoveryCodeFromInput(String(rawTokenOrUrl || ''));
    if (!cleanedToken || cleanedToken.length < 20 || cleanedToken.length > 1024) {
      throw new ClientSafeError(
        'Invalid or expired password recovery token.',
        400
      );
    }

    const pwdCheck = validatePasswordBounds(newPassword, {
      fieldName: 'New password',
      requireMinLength: true,
    });
    if (!pwdCheck.valid) {
      throw new ClientSafeError(pwdCheck.error!, 400);
    }

    const tokenHash = hashRecoveryToken(cleanedToken);
    const now = new Date();
    const newPasswordHash = await hashPasswordAsync(newPassword);

    // Check if the token matches a SHA-256 hashed single-use token in PostgreSQL
    const existingTokenRows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash));

    if (existingTokenRows.length > 0 || /^[a-f0-9]{64}$/i.test(cleanedToken)) {
      // 1. Look up the token record and user to inspect target identity
      const tokenRecord = existingTokenRows[0] || (
        await db
          .select()
          .from(passwordResetTokens)
          .where(eq(passwordResetTokens.tokenHash, tokenHash))
      )[0];

      if (
        !tokenRecord ||
        tokenRecord.consumedAt !== null ||
        new Date(tokenRecord.expiresAt).getTime() <= now.getTime()
      ) {
        throw new ClientSafeError(
          'Invalid, expired, or already used password recovery token.',
          400
        );
      }

      const preUserRows = await db
        .select()
        .from(users)
        .where(eq(users.uid, tokenRecord.userUid));
      const targetUser = preUserRows[0];
      if (!targetUser || targetUser.accountStatus !== 'active' || targetUser.deletedAt !== null) {
        throw new ClientSafeError('Account is no longer active.', 400);
      }

      // 2. If the user has a linked Firebase identity, synchronize to Firebase provider FIRST.
      // Must requireSuccess: true so we NEVER report success or update PostgreSQL if Firebase sync fails!
      const targetFbUid = resolveUserFirebaseUid(targetUser);
      let providerSynced = false;
      if (targetFbUid) {
        providerSynced = await syncPasswordToFirebaseProvider({
          uid: targetUser.uid,
          firebaseUid: targetFbUid,
          authProvider: targetUser.authProvider,
          email: targetUser.email,
          newPassword,
          requireSuccess: true,
        });

        if (!providerSynced) {
          throw new ClientSafeError(
            'Unable to synchronize password reset with authentication provider. Please try again shortly.',
            503
          );
        }
      }

      // 3. Atomically consume the token and update PostgreSQL credentials
      let updatedUser: (typeof users.$inferSelect) | undefined;
      try {
        updatedUser = await db.transaction(async (tx) => {
          const consumedRows = await tx
            .update(passwordResetTokens)
            .set({ consumedAt: now })
            .where(
              and(
                eq(passwordResetTokens.id, tokenRecord.id),
                isNull(passwordResetTokens.consumedAt)
              )
            )
            .returning();

          if (consumedRows.length === 0) {
            throw new ClientSafeError(
              'Invalid, expired, or already used password recovery token.',
              400
            );
          }

          // Invalidate any other outstanding recovery tokens for this user
          await tx
            .update(passwordResetTokens)
            .set({ consumedAt: now })
            .where(
              and(
                eq(passwordResetTokens.userUid, tokenRecord.userUid),
                isNull(passwordResetTokens.consumedAt)
              )
            );

          const nextProvider =
            targetUser.authProvider === 'firebase' || targetUser.authProvider === 'local'
              ? 'both'
              : targetUser.authProvider;

          const [updated] = await tx
            .update(users)
            .set({
              passwordHash: newPasswordHash,
              authProvider: nextProvider,
              passwordUpdatedAt: now,
              pendingRecoveryAt: null,
              sessionsRevokedAt: now,
              tokenVersion: sql`${users.tokenVersion} + 1`,
              updatedAt: now,
            })
            .where(eq(users.uid, targetUser.uid))
            .returning();

          return updated;
        });
      } catch (dbErr: any) {
        if (targetFbUid && providerSynced) {
          // Compensating defensive invalidation: Firebase was updated to newPassword, but DB commit failed.
          // Invalidate local passwordHash and mark pendingRecoveryAt so old password cannot authenticate.
          try {
            await db
              .update(users)
              .set({
                passwordHash: null,
                pendingRecoveryAt: now,
                sessionsRevokedAt: now,
                tokenVersion: sql`${users.tokenVersion} + 1`,
                updatedAt: now,
              })
              .where(eq(users.uid, targetUser.uid));
            recordUserSessionRevocation(targetUser.uid, now.getTime());
            recordUserSessionRevocation(targetFbUid, now.getTime());
          } catch (defensiveErr) {
            console.error('Defensive invalidation after DB reset failure failed:', defensiveErr);
          }
        }
        throw dbErr;
      }

      recordUserSessionRevocation(updatedUser.uid, now.getTime());
      if (updatedUser.firebaseUid) {
        recordUserSessionRevocation(updatedUser.firebaseUid, now.getTime());
      }

      return sanitizeUserForClient(updatedUser);
    }

    // Otherwise handle as a Firebase Authentication oobCode using a safe 2-phase check:
    // Phase 1: Verify the oobCode with Firebase WITHOUT consuming it yet
    const verifiedEmail = await verifyFirebaseOobCodeWithoutConsuming(cleanedToken);

    // Pre-check PostgreSQL account state and tombstones BEFORE mutating Firebase credentials
    const preCheckUsers = await db
      .select()
      .from(users)
      .where(eq(users.email, verifiedEmail));
    const preCheckTarget = preCheckUsers[0];
    if (
      !preCheckTarget ||
      preCheckTarget.accountStatus !== 'active' ||
      preCheckTarget.deletedAt !== null
    ) {
      throw new ClientSafeError('Account is no longer active.', 400);
    }

    const preCheckTombstones = await db
      .select()
      .from(deletedAccounts)
      .where(
        preCheckTarget.firebaseUid
          ? or(
              eq(deletedAccounts.uid, preCheckTarget.uid),
              eq(deletedAccounts.firebaseUid, preCheckTarget.firebaseUid)
            )
          : eq(deletedAccounts.uid, preCheckTarget.uid)
      );
    if (preCheckTombstones.length > 0) {
      throw new ClientSafeError('Account is no longer active.', 400);
    }

    // Mark `pendingRecoveryAt` before consuming the Firebase OOB code so that even if a catastrophic
    // database commit failure occurs after Firebase consumes the code, the account is explicitly marked
    // in a pending-recovery state (invalidating the old local password and allowing reconciliation).
    await db
      .update(users)
      .set({ pendingRecoveryAt: now })
      .where(eq(users.uid, preCheckTarget.uid));

    // Phase 2: Lock the PostgreSQL user row, consume the Firebase oobCode, and atomically update local passwordHash
    const updatedFirebaseUser = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT uid FROM users WHERE uid = ${preCheckTarget.uid} FOR UPDATE`
      );

      const userRows = await tx
        .select()
        .from(users)
        .where(eq(users.uid, preCheckTarget.uid));
      const targetUser = userRows[0];

      if (!targetUser || targetUser.accountStatus !== 'active' || targetUser.deletedAt !== null) {
        throw new ClientSafeError('Account is no longer active.', 400);
      }

      const consumedEmail = await consumeFirebaseOobCode(cleanedToken, newPassword);
      if (consumedEmail !== verifiedEmail) {
        throw new ClientSafeError('Password recovery email mismatch.', 400);
      }

      if (
        process.env.NODE_ENV === 'test' &&
        options?.simulateDbFailureAfterConsumeForTests
      ) {
        await options.simulateDbFailureAfterConsumeForTests();
      }

      await tx
        .update(passwordResetTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(passwordResetTokens.userUid, targetUser.uid),
            isNull(passwordResetTokens.consumedAt)
          )
        );

      const nextProvider =
        targetUser.authProvider === 'firebase' || targetUser.authProvider === 'local'
          ? 'both'
          : targetUser.authProvider;

      const [updated] = await tx
        .update(users)
        .set({
          passwordHash: newPasswordHash,
          authProvider: nextProvider,
          passwordUpdatedAt: now,
          pendingRecoveryAt: null,
          sessionsRevokedAt: now,
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(users.uid, targetUser.uid))
        .returning();

      return updated;
    });

    recordUserSessionRevocation(updatedFirebaseUser.uid, now.getTime());
    const targetRevokeFbUid = resolveUserFirebaseUid(updatedFirebaseUser);
    if (targetRevokeFbUid) {
      recordUserSessionRevocation(targetRevokeFbUid, now.getTime());
      try {
        await adminAuth.revokeRefreshTokens(targetRevokeFbUid);
      } catch {
        // Ignore if admin SDK lacks IAM permission in local environment
      }
    }

    return sanitizeUserForClient(updatedFirebaseUser);
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error confirming password recovery token:', error);
    throw new Error('Failed to reset password.', { cause: error });
  }
}

/**
 * Allows an authenticated user to change their existing password after verifying their current password.
 * Security guarantees:
 * 1. Validates both `currentPassword` and `newPassword` bounds (max 128 chars / 512 bytes) before scrypt.
 * 2. Synchronizes the password change to Firebase Auth when the account has a linked/provisioned Firebase
 *    identity (`firebaseUid` or `authProvider !== 'local'`). If a required provider update fails, aborts
 *    and throws a safe error without leaving divergent credentials.
 * 3. Updates `passwordUpdatedAt = now`, clears `pendingRecoveryAt = null`, sets `sessionsRevokedAt = now`,
 *    and increments `tokenVersion` so old sessions and old provider credentials can NEVER authenticate again.
 */
export async function changeAuthenticatedUserPassword(
  uid: string,
  currentPassword: string,
  newPassword: string
) {
  try {
    const currCheck = validatePasswordBounds(currentPassword, {
      fieldName: 'Current password',
      requireMinLength: false,
    });
    if (!currCheck.valid) {
      throw new ClientSafeError(currCheck.error!, 400);
    }

    const newCheck = validatePasswordBounds(newPassword, {
      fieldName: 'New password',
      requireMinLength: true,
    });
    if (!newCheck.valid) {
      throw new ClientSafeError(newCheck.error!, 400);
    }

    const rows = await db
      .select()
      .from(users)
      .where(or(eq(users.uid, uid), eq(users.firebaseUid, uid)));
    const user = rows[0];
    if (!user || user.accountStatus !== 'active' || user.deletedAt !== null) {
      throw new ClientSafeError('Account not found.', 404);
    }
    if (!user.passwordHash) {
      throw new ClientSafeError(
        'This account does not have a local password set yet. Use the link-password endpoint instead.',
        400
      );
    }
    if (!(await verifyPasswordAsync(currentPassword, user.passwordHash))) {
      throw new ClientSafeError('Current password is incorrect.', 401);
    }

    const targetFbUid = resolveUserFirebaseUid(user);
    const hasFirebaseIdentity = Boolean(targetFbUid);

    if (hasFirebaseIdentity) {
      const providerSynced = await syncPasswordToFirebaseProvider({
        uid: user.uid,
        firebaseUid: targetFbUid,
        authProvider: user.authProvider,
        email: user.email,
        currentPassword,
        newPassword,
        requireSuccess: true,
      });

      if (!providerSynced) {
        throw new ClientSafeError(
          'Unable to synchronize password update with authentication provider. Your password was not changed; please try again shortly.',
          503
        );
      }
    }

    const newPasswordHash = await hashPasswordAsync(newPassword);
    const now = new Date();

    let updated: (typeof users.$inferSelect) | undefined;
    try {
      if (
        process.env.NODE_ENV === 'test' &&
        simulateDbFailureAfterProviderSyncForTests
      ) {
        await simulateDbFailureAfterProviderSyncForTests(user.uid);
      }

      const [res] = await db
        .update(users)
        .set({
          passwordHash: newPasswordHash,
          passwordUpdatedAt: now,
          pendingRecoveryAt: null,
          sessionsRevokedAt: now,
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(users.uid, user.uid))
        .returning();

      updated = res;
    } catch (dbError: any) {
      console.error('Database update failed after Firebase password sync:', dbError);

      if (hasFirebaseIdentity) {
        // Safe compensating action: attempt to revert Firebase back to currentPassword
        let compensated = false;
        try {
          compensated = await syncPasswordToFirebaseProvider({
            uid: user.uid,
            firebaseUid: targetFbUid,
            authProvider: user.authProvider,
            email: user.email,
            currentPassword: newPassword, // Firebase is currently at newPassword
            newPassword: currentPassword, // Revert back to currentPassword
            requireSuccess: false,
          });
        } catch (compErr) {
          console.error('Firebase compensating rollback threw:', compErr);
        }

        if (compensated) {
          // Both Firebase and PostgreSQL are confirmed back at currentPassword.
          throw new ClientSafeError(
            'Database error prevented updating password. Provider update was safely reverted; your existing password remains active.',
            500
          );
        }

        // Compensating rollback on Firebase could not be completed or confirmed.
        // Firebase now holds newPassword while PostgreSQL holds the old password.
        // CRITICAL DEFENSIVE GUARD: Ensure the old local password cannot authenticate.
        // Set pendingRecoveryAt and invalidate local passwordHash so old password is never accepted.
        try {
          await db
            .update(users)
            .set({
              passwordHash: null,
              pendingRecoveryAt: now,
              sessionsRevokedAt: now,
              tokenVersion: sql`${users.tokenVersion} + 1`,
              updatedAt: now,
            })
            .where(eq(users.uid, user.uid));
        } catch (invalErr) {
          console.error('Failed to invalidate local password hash on DB failure:', invalErr);
        }

        recordUserSessionRevocation(user.uid, now.getTime());
        if (targetFbUid) {
          recordUserSessionRevocation(targetFbUid, now.getTime());
        }

        throw new ClientSafeError(
          'Database error occurred during password update. For your security, existing sessions and local credentials have been invalidated. Please sign in with your new password or reset your password.',
          500
        );
      }

      throw new ClientSafeError(
        'Database error prevented updating password. Please try again.',
        500
      );
    }

    if (!updated) {
      throw new ClientSafeError('Account not found.', 404);
    }

    recordUserSessionRevocation(user.uid, now.getTime());
    if (targetFbUid) {
      recordUserSessionRevocation(targetFbUid, now.getTime());
    }
    return updated;
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error changing password:', error);
    throw new Error('Failed to change password.', { cause: error });
  }
}

/**
 * Allows an already-authenticated provider user (without a local password) to attach a local password
 * after proving account ownership via an authenticated session.
 */
export async function linkPasswordToAuthenticatedAccount(
  uid: string,
  newPassword: string
) {
  try {
    const pwdCheck = validatePasswordBounds(newPassword, {
      fieldName: 'Password',
      requireMinLength: true,
    });
    if (!pwdCheck.valid) {
      throw new ClientSafeError(pwdCheck.error!, 400);
    }

    const rows = await db
      .select()
      .from(users)
      .where(or(eq(users.uid, uid), eq(users.firebaseUid, uid)));
    const user = rows[0];
    if (!user || user.accountStatus !== 'active' || user.deletedAt !== null) {
      throw new ClientSafeError('Account not found.', 404);
    }
    if (user.passwordHash) {
      throw new ClientSafeError(
        'A password is already configured for this account. Use change-password with your current password.',
        409
      );
    }

    const targetFbUid = resolveUserFirebaseUid(user);
    // Best-effort sync to Firebase Auth if Admin SDK is available; if a custom test handler is active, honor it
    const synced = await syncPasswordToFirebaseProvider({
      uid: user.uid,
      firebaseUid: targetFbUid,
      authProvider: user.authProvider,
      email: user.email,
      newPassword,
      requireSuccess: Boolean(
        process.env.NODE_ENV === 'test' && customFirebasePasswordUpdateForTests
      ),
    });
    if (!synced) {
      throw new ClientSafeError(
        'Unable to link password with authentication provider. Please try again shortly.',
        503
      );
    }

    const newPasswordHash = await hashPasswordAsync(newPassword);
    const now = new Date();
    const [updated] = await db
      .update(users)
      .set({
        passwordHash: newPasswordHash,
        firebaseUid: targetFbUid,
        authProvider: 'both',
        passwordUpdatedAt: now,
        pendingRecoveryAt: null,
        sessionsRevokedAt: now,
        tokenVersion: sql`${users.tokenVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(users.uid, user.uid))
      .returning();

    recordUserSessionRevocation(user.uid, now.getTime());
    if (updated.firebaseUid) {
      recordUserSessionRevocation(updated.firebaseUid, now.getTime());
    }
    return updated;
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error linking password to account:', error);
    throw new Error('Failed to link password to account.', { cause: error });
  }
}

/**
 * Increments a user's tokenVersion, sets the dedicated `sessionsRevokedAt` timestamp in PostgreSQL,
 * records an in-memory revocation watermark, and revokes Firebase refresh tokens best-effort to
 * immediately invalidate both local and Firebase sessions.
 */
export async function revokeUserSessions(uid: string) {
  const now = new Date();
  const rows = await db
    .select()
    .from(users)
    .where(or(eq(users.uid, uid), eq(users.firebaseUid, uid)));
  const user = rows[0];
  const primaryUid = user?.uid || uid;
  const fbUid = resolveUserFirebaseUid(user);

  await db
    .update(users)
    .set({
      sessionsRevokedAt: now,
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: now,
    })
    .where(eq(users.uid, primaryUid));

  recordUserSessionRevocation(primaryUid, now.getTime());
  if (fbUid) {
    recordUserSessionRevocation(fbUid, now.getTime());
    try {
      await adminAuth.revokeRefreshTokens(fbUid);
    } catch {
      // Ignore if user does not exist in Firebase Auth or admin credentials are not configured for revocation
    }
  }
}

/**
 * Updates ordinary user profile fields (`displayName` and `preferences`).
 * IMPORTANT: Does NOT touch `sessionsRevokedAt` or `tokenVersion`, so profile edits never
 * unintentionally invalidate active local or Firebase sessions.
 */
export async function updateUserProfile(
  uid: string,
  updates: { displayName?: string; preferences?: Record<string, unknown> }
) {
  try {
    const setData: Partial<typeof users.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (updates.displayName && updates.displayName.trim()) {
      setData.displayName = updates.displayName.trim().slice(0, 120);
    }
    if (updates.preferences) {
      setData.preferences = JSON.stringify(updates.preferences);
    }
    // Notice role, subscriptionTier, tokenVersion, and sessionsRevokedAt are NEVER modified here
    const [updated] = await db
      .update(users)
      .set(setData)
      .where(or(eq(users.uid, uid), eq(users.firebaseUid, uid)))
      .returning();
    if (!updated) {
      throw new ClientSafeError('User account not found.', 404);
    }
    return updated;
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error updating user profile:', error);
    throw new Error('Failed to update user profile.', { cause: error });
  }
}

/**
 * Attempts to delete or disable a user's Firebase Authentication account.
 * Returns `{ status: 'completed' | 'pending_retry' | 'not_applicable', errorCode?: string }`.
 */
async function cleanupFirebaseIdentityOnDeletion(params: {
  uid: string;
  firebaseUid?: string | null;
  authProvider?: string | null;
  email?: string;
}): Promise<{
  status: 'completed' | 'pending_retry' | 'not_applicable';
  resolvedFirebaseUid?: string | null;
  errorCode?: string;
}> {
  const candidateFbUid = resolveUserFirebaseUid({
    uid: params.uid,
    firebaseUid: params.firebaseUid,
    authProvider: params.authProvider,
  });

  if (process.env.NODE_ENV === 'test' && customFirebaseAccountDeletionForTests) {
    const testRes = await customFirebaseAccountDeletionForTests({
      uid: params.uid,
      firebaseUid: candidateFbUid,
      email: params.email,
    });
    return {
      status: testRes.deleted ? 'completed' : 'pending_retry',
      resolvedFirebaseUid: candidateFbUid,
      errorCode: testRes.errorCode,
    };
  }

  let resolvedFbUid = candidateFbUid;
  if (!resolvedFbUid && params.email && params.authProvider !== 'local') {
    try {
      const found = await adminAuth.getUserByEmail(params.email.toLowerCase().trim());
      if (found?.uid) {
        resolvedFbUid = found.uid;
      }
    } catch (lookupErr: any) {
      if (lookupErr?.code === 'auth/user-not-found') {
        return { status: 'not_applicable', resolvedFirebaseUid: null };
      }
    }
  }

  if (!resolvedFbUid) {
    const isPureLocal = params.authProvider === 'local' && !params.firebaseUid;
    return {
      status: isPureLocal ? 'not_applicable' : 'pending_retry',
      resolvedFirebaseUid: null,
    };
  }

  try {
    await adminAuth.deleteUser(resolvedFbUid);
    return { status: 'completed', resolvedFirebaseUid: resolvedFbUid };
  } catch (delErr: any) {
    const delCode = String(delErr?.code || '');
    if (delCode === 'auth/user-not-found') {
      return { status: 'completed', resolvedFirebaseUid: resolvedFbUid };
    }
    try {
      await adminAuth.updateUser(resolvedFbUid, { disabled: true });
      await adminAuth.revokeRefreshTokens(resolvedFbUid);
      return { status: 'completed', resolvedFirebaseUid: resolvedFbUid };
    } catch (disableErr: any) {
      const errCode = String(disableErr?.code || delCode || 'FIREBASE_CLEANUP_FAILED');
      console.error('Firebase identity deletion/disable deferred for reconciliation:', {
        uid: params.uid,
        firebaseUid: resolvedFbUid,
        code: errCode,
      });
      return {
        status: 'pending_retry',
        resolvedFirebaseUid: resolvedFbUid,
        errorCode: errCode.slice(0, 120),
      };
    }
  }
}

/**
 * Retries remote Firebase identity deletion/disabling for any tombstoned accounts marked `pending_retry`.
 */
export async function reconcilePendingDeletedAccounts(): Promise<{
  attempted: number;
  reconciled: number;
  stillPending: number;
}> {
  const pendingRows = await db
    .select()
    .from(deletedAccounts)
    .where(eq(deletedAccounts.remoteCleanupStatus, 'pending_retry'));

  let reconciled = 0;
  let stillPending = 0;

  for (const row of pendingRows) {
    const res = await cleanupFirebaseIdentityOnDeletion({
      uid: row.uid,
      firebaseUid: row.firebaseUid,
    });
    if (res.status === 'completed' || res.status === 'not_applicable') {
      await db
        .update(deletedAccounts)
        .set({
          remoteCleanupStatus: 'completed',
          lastCleanupError: null,
        })
        .where(eq(deletedAccounts.id, row.id));
      reconciled++;
    } else {
      await db
        .update(deletedAccounts)
        .set({
          lastCleanupError: res.errorCode || 'RETRY_FAILED',
        })
        .where(eq(deletedAccounts.id, row.id));
      stillPending++;
    }
  }

  return {
    attempted: pendingRows.length,
    reconciled,
    stillPending,
  };
}

/**
 * Deletes a user account atomically inside a database transaction, records permanent tombstones
 * in `deleted_accounts` for both the primary `uid` and any linked/shadow `firebaseUid` so existing
 * tokens and stale provider identities are permanently rejected (even if the email is later
 * re-registered under a new account), and deletes/disables the Firebase user with reconciliation tracking.
 */
export async function deleteUserAccount(uid: string) {
  try {
    const now = new Date();
    const existingRows = await db
      .select()
      .from(users)
      .where(or(eq(users.uid, uid), eq(users.firebaseUid, uid)));
    const user = existingRows[0];
    const primaryUid = user?.uid || uid;
    const initialFbUid = resolveUserFirebaseUid(user);

    const remoteCleanup = await cleanupFirebaseIdentityOnDeletion({
      uid: primaryUid,
      firebaseUid: initialFbUid,
      authProvider: user?.authProvider,
      email: user?.email,
    });
    const resolvedFbUid = remoteCleanup.resolvedFirebaseUid || initialFbUid;

    await db.transaction(async (tx) => {
      const emailHash = user
        ? hashEmailForTombstone(user.email)
        : hashEmailForTombstone(primaryUid);

      await tx
        .insert(deletedAccounts)
        .values({
          uid: primaryUid,
          firebaseUid: resolvedFbUid,
          emailHash,
          remoteCleanupStatus: remoteCleanup.status,
          lastCleanupError: remoteCleanup.errorCode || null,
          deletedAt: now,
        })
        .onConflictDoUpdate({
          target: deletedAccounts.uid,
          set: {
            firebaseUid: resolvedFbUid,
            emailHash,
            remoteCleanupStatus: remoteCleanup.status,
            lastCleanupError: remoteCleanup.errorCode || null,
            deletedAt: now,
          },
        });

      // If the user also had a distinct shadow or linked Firebase UID, insert a dedicated tombstone
      // row keyed by `uid = resolvedFbUid` so direct lookups by that Firebase UID are permanently blocked.
      if (resolvedFbUid && resolvedFbUid !== primaryUid) {
        await tx
          .insert(deletedAccounts)
          .values({
            uid: resolvedFbUid,
            firebaseUid: resolvedFbUid,
            emailHash,
            remoteCleanupStatus: remoteCleanup.status,
            lastCleanupError: remoteCleanup.errorCode || null,
            deletedAt: now,
          })
          .onConflictDoUpdate({
            target: deletedAccounts.uid,
            set: {
              firebaseUid: resolvedFbUid,
              emailHash,
              remoteCleanupStatus: remoteCleanup.status,
              lastCleanupError: remoteCleanup.errorCode || null,
              deletedAt: now,
            },
          });
      }

      await tx
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.userUid, primaryUid));
      await tx.delete(bookmarks).where(eq(bookmarks.userUid, primaryUid));
      await tx
        .delete(questionAttempts)
        .where(eq(questionAttempts.userUid, primaryUid));
      await tx.delete(examSessions).where(eq(examSessions.userUid, primaryUid));
      await tx.delete(users).where(eq(users.uid, primaryUid));
    });

    recordUserSessionRevocation(primaryUid, now.getTime());
    if (resolvedFbUid) {
      recordUserSessionRevocation(resolvedFbUid, now.getTime());
    }

    return {
      deleted: true,
      remoteCleanupStatus: remoteCleanup.status,
    };
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error deleting user account:', error);
    throw new Error('Failed to delete account records.', { cause: error });
  }
}

/**
 * Returns published subjects, lectures, and question counts for the public & student interfaces.
 * Draft and archived items are strictly filtered out at the database query level.
 */
export async function getPublishedCatalog(userUid?: string) {
  try {
    await ensureSeededDatabase();
    const pubModules = await db
      .select()
      .from(modules)
      .where(eq(modules.status, 'published'))
      .orderBy(asc(modules.displayOrder), asc(modules.id));

    const pubSubjects = await db
      .select()
      .from(subjects)
      .where(eq(subjects.status, 'published'))
      .orderBy(asc(subjects.displayOrder), asc(subjects.id));

    const pubLectures = await db
      .select()
      .from(lectures)
      .where(eq(lectures.status, 'published'))
      .orderBy(asc(lectures.lectureNumber), asc(lectures.id));

    const pubQuestions = await db
      .select()
      .from(questions)
      .where(eq(questions.status, 'published'));

    const pubBanks = await db
      .select()
      .from(questionBanks)
      .where(eq(questionBanks.status, 'published'));

    const subjSet = new Set(pubSubjects.map((s) => s.id));
    const visibleLectures = pubLectures.filter((l) => subjSet.has(l.subjectId));
    const lectSet = new Set(visibleLectures.map((l) => l.id));
    const visibleQuestions = pubQuestions.filter(
      (q) => subjSet.has(q.subjectId) && lectSet.has(q.lectureId)
    );

    // Fetch user attempts if authenticated to compute live progress & accuracy without double-counting
    const userAttempts = userUid
      ? await db
          .select()
          .from(questionAttempts)
          .where(
            and(
              eq(questionAttempts.userUid, userUid),
              sql`${questionAttempts.selectedOption} IS NOT NULL`
            )
          )
          .orderBy(desc(questionAttempts.answeredAt))
      : [];

    // Map each questionId to its latest attempt correctness
    const latestAttemptByQ = new Map<number, boolean>();
    for (const a of userAttempts) {
      if (a.questionId !== null && !latestAttemptByQ.has(a.questionId)) {
        latestAttemptByQ.set(a.questionId, a.isCorrect);
      }
    }

    const questionCountByLecture = new Map<number, number>();
    const questionCountBySubject = new Map<number, number>();
    const attemptedCountByLecture = new Map<number, number>();
    const correctCountByLecture = new Map<number, number>();
    const incorrectCountByLecture = new Map<number, number>();
    const attemptedCountBySubject = new Map<number, number>();
    const correctCountBySubject = new Map<number, number>();
    const incorrectCountBySubject = new Map<number, number>();

    const difficultyCountByLecture = new Map<
      number,
      { Easy: number; Medium: number; Hard: number }
    >();
    const specialTagCountByLecture = new Map<number, Record<string, number>>();
    const specialTagGlobalCounts = new Map<string, { label: string; count: number }>();

    for (const q of visibleQuestions) {
      questionCountByLecture.set(
        q.lectureId,
        (questionCountByLecture.get(q.lectureId) || 0) + 1
      );
      questionCountBySubject.set(
        q.subjectId,
        (questionCountBySubject.get(q.subjectId) || 0) + 1
      );

      const diffCounts = difficultyCountByLecture.get(q.lectureId) || {
        Easy: 0,
        Medium: 0,
        Hard: 0,
      };
      if (q.difficulty === 'Easy' || q.difficulty === 'Medium' || q.difficulty === 'Hard') {
        diffCounts[q.difficulty]++;
      }
      difficultyCountByLecture.set(q.lectureId, diffCounts);

      const qSpecTags = parseSpecialTags(q.specialTags);
      if (qSpecTags.length > 0) {
        const lectSpec = specialTagCountByLecture.get(q.lectureId) || {};
        for (const st of qSpecTags) {
          const normKey = st.toLowerCase();
          const globalEntry = specialTagGlobalCounts.get(normKey);
          const canonicalLabel = globalEntry ? globalEntry.label : st;
          lectSpec[canonicalLabel] = (lectSpec[canonicalLabel] || 0) + 1;
          specialTagGlobalCounts.set(normKey, {
            label: canonicalLabel,
            count: (globalEntry?.count || 0) + 1,
          });
        }
        specialTagCountByLecture.set(q.lectureId, lectSpec);
      }

      if (latestAttemptByQ.has(q.id)) {
        const isCorrect = latestAttemptByQ.get(q.id) === true;
        attemptedCountByLecture.set(
          q.lectureId,
          (attemptedCountByLecture.get(q.lectureId) || 0) + 1
        );
        attemptedCountBySubject.set(
          q.subjectId,
          (attemptedCountBySubject.get(q.subjectId) || 0) + 1
        );
        if (isCorrect) {
          correctCountByLecture.set(
            q.lectureId,
            (correctCountByLecture.get(q.lectureId) || 0) + 1
          );
          correctCountBySubject.set(
            q.subjectId,
            (correctCountBySubject.get(q.subjectId) || 0) + 1
          );
        } else {
          incorrectCountByLecture.set(
            q.lectureId,
            (incorrectCountByLecture.get(q.lectureId) || 0) + 1
          );
          incorrectCountBySubject.set(
            q.subjectId,
            (incorrectCountBySubject.get(q.subjectId) || 0) + 1
          );
        }
      }
    }

    const enrichedLectures = visibleLectures.map((l) => {
      const parentSubj = pubSubjects.find((s) => s.id === l.subjectId);
      const banks = pubBanks.filter((b) => b.lectureId === l.id);
      const qCount = questionCountByLecture.get(l.id) || 0;
      const attempted = attemptedCountByLecture.get(l.id) || 0;
      const correct = correctCountByLecture.get(l.id) || 0;
      const incorrect = incorrectCountByLecture.get(l.id) || 0;
      const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
      const completionProgress = qCount > 0 ? Math.round((attempted / qCount) * 100) : 0;
      const unanswered = Math.max(0, qCount - attempted);

      return {
        ...l,
        pdfUrl: l.pdfUrl || null,
        subjectTitle: parentSubj?.title || 'Medical Subject',
        subjectSlug: parentSubj?.slug || '',
        questionCount: qCount,
        attemptedQuestions: attempted,
        correctAnswers: correct,
        incorrectAnswers: incorrect,
        unansweredCount: unanswered,
        accuracy,
        completionProgress,
        mistakesCount: incorrect,
        difficultyBreakdown: difficultyCountByLecture.get(l.id) || {
          Easy: 0,
          Medium: 0,
          Hard: 0,
        },
        specialTagBreakdown: specialTagCountByLecture.get(l.id) || {},
        questionBanks: banks,
      };
    });

    const enrichedSubjects = pubSubjects.map((s) => {
      const subLectures = enrichedLectures.filter((l) => l.subjectId === s.id);
      const qCount = questionCountBySubject.get(s.id) || 0;
      const attempted = attemptedCountBySubject.get(s.id) || 0;
      const correct = correctCountBySubject.get(s.id) || 0;
      const incorrect = incorrectCountBySubject.get(s.id) || 0;
      const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
      const completionProgress = qCount > 0 ? Math.round((attempted / qCount) * 100) : 0;
      const unanswered = Math.max(0, qCount - attempted);

      return {
        ...s,
        lectureCount: subLectures.length,
        questionCount: qCount,
        attemptedQuestions: attempted,
        correctAnswers: correct,
        incorrectAnswers: incorrect,
        unansweredCount: unanswered,
        accuracy,
        completionProgress,
        mistakesCount: incorrect,
        lectures: subLectures,
      };
    });

    const enrichedModules = pubModules.map((m) => {
      const modSubjects = enrichedSubjects.filter((s) => s.moduleId === m.id);
      const totalQ = modSubjects.reduce((acc, s) => acc + s.questionCount, 0);
      const totalLect = modSubjects.reduce((acc, s) => acc + s.lectureCount, 0);
      return {
        ...m,
        subjects: modSubjects,
        subjectCount: modSubjects.length,
        lectureCount: totalLect,
        questionCount: totalQ,
      };
    });

    const availableSpecialTags = Array.from(specialTagGlobalCounts.values()).sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label)
    );

    return {
      modules: enrichedModules,
      subjects: enrichedSubjects,
      lectures: enrichedLectures,
      specialTags: availableSpecialTags,
      totalPublishedQuestions: visibleQuestions.length,
    };
  } catch (error) {
    console.error('Error fetching published catalog:', error);
    throw new Error('Failed to load educational catalog.', { cause: error });
  }
}

export interface SessionOrderItem {
  questionId: number;
  permutation: OptionPermutation;
  selectedDisplayed: OptionKey | null;
  selectedCanonical: OptionKey | null;
  submitted: boolean;
}

export interface ServerExamDeadlineStatus {
  serverElapsedSeconds: number;
  remainingSeconds: number | null;
  isExpired: boolean;
  isPastSubmissionGrace: boolean;
  effectiveElapsedSeconds: number;
}

/**
 * Pure server-side exam deadline evaluator.
 * Never trusts client-supplied elapsedSeconds for timed exam enforcement.
 */
export function evaluateServerExamDeadline(params: {
  mode: string;
  startedAt: Date | string;
  timeLimitSeconds: number | null;
  nowMs?: number;
  graceSeconds?: number;
}): ServerExamDeadlineStatus {
  const nowMs = params.nowMs ?? Date.now();
  const startedMs = new Date(params.startedAt).getTime();
  const serverElapsedSeconds = Math.max(
    0,
    Math.floor((nowMs - (Number.isFinite(startedMs) ? startedMs : nowMs)) / 1000)
  );

  if (params.timeLimitSeconds === null || params.mode !== 'exam') {
    return {
      serverElapsedSeconds,
      remainingSeconds: null,
      isExpired: false,
      isPastSubmissionGrace: false,
      effectiveElapsedSeconds: Math.max(1, serverElapsedSeconds),
    };
  }

  const limit = Math.max(1, params.timeLimitSeconds);
  const grace = Math.max(0, params.graceSeconds ?? EXAM_SUBMISSION_GRACE_SECONDS);
  const remainingSeconds = Math.max(0, limit - serverElapsedSeconds);
  const isExpired = serverElapsedSeconds > limit;
  const isPastSubmissionGrace = serverElapsedSeconds > limit + grace;
  const effectiveElapsedSeconds = Math.min(limit, Math.max(1, serverElapsedSeconds));

  return {
    serverElapsedSeconds,
    remainingSeconds,
    isExpired,
    isPastSubmissionGrace,
    effectiveElapsedSeconds,
  };
}

/**
 * Automatically completes any in-progress 'exam' sessions for the user whose assigned time limit has finished.
 * Returns any remaining active (non-expired) in-progress 'exam' session(s) for the user.
 */
export async function resolveActiveMockExamsForUser(userUid: string) {
  const activeExams = await db
    .select()
    .from(examSessions)
    .where(
      and(
        eq(examSessions.userUid, userUid),
        eq(examSessions.mode, 'exam'),
        eq(examSessions.status, 'in_progress')
      )
    )
    .orderBy(desc(examSessions.startedAt));

  const stillRunningExams: typeof activeExams = [];
  for (const exam of activeExams) {
    const deadlineStatus = evaluateServerExamDeadline({
      mode: exam.mode,
      startedAt: exam.startedAt,
      timeLimitSeconds: exam.timeLimitSeconds,
    });
    if (
      deadlineStatus.isExpired ||
      (deadlineStatus.remainingSeconds !== null && deadlineStatus.remainingSeconds <= 0)
    ) {
      try {
        await completeExamSession(userUid, exam.id);
      } catch (err) {
        console.warn('Could not auto-complete expired mock exam:', err);
      }
    } else {
      stillRunningExams.push(exam);
    }
  }

  // If multiple in-progress mock exams existed from earlier, keep only the newest one active
  if (stillRunningExams.length > 1) {
    for (let i = 1; i < stillRunningExams.length; i++) {
      try {
        await completeExamSession(userUid, stillRunningExams[i].id);
      } catch {}
    }
    return [stillRunningExams[0]];
  }

  return stillRunningExams;
}

/**
 * Starts a new Study, Exam, or Custom Practice session for a specific authenticated student.
 */
export async function createPracticeOrExamSession(
  userUid: string,
  params: {
    mode: 'study' | 'exam' | 'custom';
    title?: string;
    subjectIds?: number[];
    lectureIds?: number[];
    difficulties?: DifficultyLevel[];
    tagFilter?: string;
    specialTags?: string[];
    requestedCount?: number;
    shuffleQuestions?: boolean;
    shuffleOptions?: boolean;
    avoidRecent?: boolean;
    onlyMistakes?: boolean;
    timeLimitMinutes?: number | null;
  }
) {
  try {
    await ensureSeededDatabase();

    // Auto-complete any expired mock exams and enforce single-active-exam lock when starting a new mock exam
    const runningMockExams = await resolveActiveMockExamsForUser(userUid);
    if (params.mode === 'exam' && runningMockExams.length > 0) {
      const activeExam = runningMockExams[0];
      const deadline = evaluateServerExamDeadline({
        mode: activeExam.mode,
        startedAt: activeExam.startedAt,
        timeLimitSeconds: activeExam.timeLimitSeconds,
      });
      const remSecs = deadline.remainingSeconds ?? 0;
      const mins = Math.floor(remSecs / 60);
      const secs = remSecs % 60;
      throw new ClientSafeError(
        `You already have an active Mock Exam running ("${activeExam.title}" — ${mins}m ${secs}s remaining). You cannot open a new Mock Exam until you submit the active exam or its assigned time finishes.`,
        409
      );
    }

    // Ensure ONLY ONE progress per lecture's MCQ is saved and applied automatically (strictly for normal 'study' mode)
    if (
      params.mode === 'study' &&
      params.lectureIds &&
      params.lectureIds.length === 1 &&
      !params.onlyMistakes
    ) {
      const targetLectureId = params.lectureIds[0];
      const existingSessions = await db
        .select()
        .from(examSessions)
        .where(
          and(
            eq(examSessions.userUid, userUid),
            eq(examSessions.lectureId, targetLectureId),
            eq(examSessions.mode, 'study')
          )
        )
        .orderBy(desc(examSessions.startedAt));

      if (existingSessions.length > 0) {
        // Find best session (highest answers submitted, prefer in_progress)
        let bestSession = existingSessions[0];
        let maxScore = -1;
        for (const s of existingSessions) {
          try {
            const items: SessionOrderItem[] = JSON.parse(s.questionOrderJson || '[]');
            const ansCount = items.filter((i) => i.submitted || i.selectedDisplayed).length;
            const score = (s.status === 'in_progress' ? 1000 : 0) + ansCount;
            if (score > maxScore) {
              maxScore = score;
              bestSession = s;
            }
          } catch {}
        }

        // Clean up redundant duplicate rows if any existed from earlier
        const duplicates = existingSessions.filter((s) => s.id !== bestSession.id);
        if (duplicates.length > 0) {
          const dupIds = duplicates.map((d) => d.id);
          try {
            await db.delete(examSessions).where(inArray(examSessions.id, dupIds));
          } catch (err) {
            console.warn('Could not remove duplicate lecture sessions:', err);
          }
        }

        // Check if new questions were added to this lecture or if any questions were unpublished
        const pubLectureQuestions = await db
          .select()
          .from(questions)
          .where(
            and(
              eq(questions.lectureId, targetLectureId),
              eq(questions.status, 'published')
            )
          )
          .orderBy(asc(questions.id));

        const pubQIdSet = new Set(pubLectureQuestions.map((q) => q.id));

        let existingItems: SessionOrderItem[] = [];
        try {
          existingItems = JSON.parse(bestSession.questionOrderJson || '[]');
        } catch {
          existingItems = [];
        }

        const existingQIdSet = new Set(existingItems.map((i) => i.questionId));

        // Keep items whose questions are still published
        const validExistingItems = existingItems.filter((i) => pubQIdSet.has(i.questionId));

        // Detect newly added published questions for this lecture
        const missingQuestions = pubLectureQuestions.filter((q) => !existingQIdSet.has(q.id));

        if (missingQuestions.length > 0 || validExistingItems.length !== existingItems.length) {
          const newItems: SessionOrderItem[] = missingQuestions.map((q, idx) => ({
            questionId: q.id,
            permutation: createOptionPermutation(
              Boolean(bestSession.shuffleOptions || params.shuffleOptions),
              Date.now() + idx * 97 + q.id
            ),
            selectedDisplayed: null,
            selectedCanonical: null,
            submitted: false,
          }));

          const updatedItems = [...validExistingItems, ...newItems];
          const answeredCount = updatedItems.filter((i) => i.submitted).length;
          const totalCount = updatedItems.length;
          const unansweredCount = Math.max(0, totalCount - answeredCount);

          // If there are newly added questions or any unanswered questions,
          // the session MUST NOT remain completed; it must be in_progress so the student can study!
          const nextStatus = unansweredCount > 0 ? 'in_progress' : bestSession.status;
          const nextCompletedAt = unansweredCount > 0 ? null : bestSession.completedAt;

          await db
            .update(examSessions)
            .set({
              questionOrderJson: JSON.stringify(updatedItems),
              totalQuestions: totalCount,
              unansweredCount,
              status: nextStatus,
              completedAt: nextCompletedAt,
            })
            .where(eq(examSessions.id, bestSession.id));
        }

        // Return the single existing lecture session with its progress automatically applied
        return {
          session: await getExamSessionForStudent(userUid, bestSession.id),
          shortfallNotice: null,
        };
      }
    }
    const pubSubjects = await db
      .select()
      .from(subjects)
      .where(eq(subjects.status, 'published'));
    const pubLectures = await db
      .select()
      .from(lectures)
      .where(eq(lectures.status, 'published'));
    const pubQuestions = await db
      .select()
      .from(questions)
      .where(eq(questions.status, 'published'));

    const subjMap = new Map(pubSubjects.map((s) => [s.id, s]));
    const lectMap = new Map(pubLectures.map((l) => [l.id, l]));

    // Only include questions whose parent subject and lecture are ALSO published
    const eligiblePool = pubQuestions.filter(
      (q) => subjMap.has(q.subjectId) && lectMap.has(q.lectureId)
    );

    let recentlyAnsweredIds = new Set<number>();
    if (params.avoidRecent) {
      const recentAttempts = await db
        .select()
        .from(questionAttempts)
        .where(eq(questionAttempts.userUid, userUid))
        .orderBy(desc(questionAttempts.answeredAt))
        .limit(30);
      recentlyAnsweredIds = new Set(
        recentAttempts.map((a) => a.questionId).filter((id): id is number => id !== null)
      );
    }

    let mistakeQuestionIds: Set<number> | undefined = undefined;
    if (params.onlyMistakes) {
      const pastAttempts = await db
        .select()
        .from(questionAttempts)
        .where(
          and(
            eq(questionAttempts.userUid, userUid),
            sql`${questionAttempts.selectedOption} IS NOT NULL`
          )
        )
        .orderBy(desc(questionAttempts.answeredAt));

      const latestAttemptByQ = new Map<number, boolean>();
      for (const a of pastAttempts) {
        if (a.questionId !== null && !latestAttemptByQ.has(a.questionId)) {
          latestAttemptByQ.set(a.questionId, a.isCorrect);
        }
      }

      const wrongIds = new Set<number>();
      for (const [qId, isCorrect] of latestAttemptByQ.entries()) {
        if (!isCorrect) {
          wrongIds.add(qId);
        }
      }

      if (wrongIds.size === 0) {
        throw new ClientSafeError(
          'No previously incorrect questions recorded for this selection. Great job!',
          400
        );
      }
      mistakeQuestionIds = wrongIds;
    }

    const selection = selectPracticeQuestions(eligiblePool, {
      subjectIds: params.subjectIds,
      lectureIds: params.lectureIds,
      difficulties: params.difficulties,
      tagFilter: params.tagFilter,
      specialTags: params.specialTags,
      requestedCount: params.requestedCount,
      shuffleQuestions: params.shuffleQuestions ?? params.mode !== 'study',
      recentlyAnsweredIds,
      onlyMistakes: params.onlyMistakes,
      mistakeQuestionIds,
    });

    if (selection.selectedQuestions.length === 0) {
      throw new ClientSafeError(
        selection.shortfallNotice || 'No published questions match your selected filters.',
        400
      );
    }

    const orderItems: SessionOrderItem[] = selection.selectedQuestions.map((q, idx) => ({
      questionId: q.id,
      permutation: createOptionPermutation(
        Boolean(params.shuffleOptions),
        Date.now() + idx * 97 + q.id
      ),
      selectedDisplayed: null,
      selectedCanonical: null,
      submitted: false,
    }));

    const firstLect =
      params.lectureIds && params.lectureIds.length === 1
        ? lectMap.get(params.lectureIds[0])
        : null;
    const firstSubj =
      params.subjectIds && params.subjectIds.length === 1
        ? subjMap.get(params.subjectIds[0])
        : firstLect
        ? subjMap.get(firstLect.subjectId)
        : null;

    const defaultTitle =
      params.title ||
      (params.onlyMistakes
        ? firstLect
          ? `${firstLect.title} — Review Mistakes`
          : firstSubj
          ? `${firstSubj.title} — Review Mistakes`
          : `Review Mistakes (${selection.selectedQuestions.length} MCQs)`
        : firstLect
        ? `${firstLect.title} (${params.mode === 'exam' ? 'Mock Exam' : 'Study'})`
        : firstSubj
        ? `${firstSubj.title} (${params.mode === 'exam' ? 'Mock Exam' : 'Practice'})`
        : `Custom Medical Practice (${selection.selectedQuestions.length} MCQs)`);

    const timeLimitSeconds =
      params.mode === 'exam'
        ? Math.max(
            60,
            Math.min(
              60 * 240,
              (params.timeLimitMinutes ??
                Math.max(5, selection.selectedQuestions.length * 2)) * 60
            )
          )
        : null;

    const [createdSession] = await db
      .insert(examSessions)
      .values({
        userUid,
        title: defaultTitle,
        mode: params.mode,
        subjectId: firstSubj?.id ?? null,
        lectureId:
          params.mode === 'study' && !params.onlyMistakes
            ? (firstLect?.id ?? null)
            : null,
        status: 'in_progress',
        totalQuestions: selection.selectedQuestions.length,
        correctCount: 0,
        incorrectCount: 0,
        unansweredCount: selection.selectedQuestions.length,
        scorePercentage: 0,
        timeLimitSeconds,
        elapsedSeconds: 0,
        shuffleOptions: Boolean(params.shuffleOptions),
        questionOrderJson: JSON.stringify(orderItems),
      })
      .returning();

    return {
      session: await getExamSessionForStudent(userUid, createdSession.id),
      shortfallNotice: selection.shortfallNotice,
    };
  } catch (error: any) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error creating practice/exam session:', error);
    throw new Error('Failed to start question session.', { cause: error });
  }
}

// Fast in-memory cache for static catalog tables (subjects & lectures)
// Eliminates 2 separate remote Supabase database round-trips on every session request
let cachedSubjects: any[] | null = null;
let cachedLectures: any[] | null = null;
let catalogCacheExpiry = 0;

export function invalidateCatalogCache() {
  cachedSubjects = null;
  cachedLectures = null;
  catalogCacheExpiry = 0;
}

async function getCachedCatalog() {
  const now = Date.now();
  if (cachedSubjects && cachedLectures && now < catalogCacheExpiry) {
    return { subjects: cachedSubjects, lectures: cachedLectures };
  }
  const [allSubjs, allLecs] = await Promise.all([
    db.select().from(subjects),
    db.select().from(lectures),
  ]);
  cachedSubjects = allSubjs;
  cachedLectures = allLecs;
  catalogCacheExpiry = now + 5 * 60 * 1000; // 5 min TTL
  return { subjects: allSubjs, lectures: allLecs };
}

/**
 * Retrieves an exam session for its owner student.
 * Strictly enforces userUid ownership so students can NEVER access another student's session.
 * During an active Exam Mode session, strips correct answers and explanations from the response!
 * Runs queries concurrently and uses cached subjects/lectures to minimize cloud database latency.
 */
export async function getExamSessionForStudent(
  userUid: string,
  sessionId: number,
  preloadedSession?: any
): Promise<any> {
  try {
    let session = preloadedSession;
    if (!session) {
      const rows = await db
        .select()
        .from(examSessions)
        .where(and(eq(examSessions.id, sessionId), eq(examSessions.userUid, userUid)));

      if (rows.length === 0) {
        throw new ClientSafeError(
          'Forbidden or not found: Exam session does not belong to this account.',
          403
        );
      }
      session = rows[0];

      // If this is an in-progress Mock Exam whose assigned time has finished, auto-complete it now
      if (session.mode === 'exam' && session.status === 'in_progress') {
        const deadlineCheck = evaluateServerExamDeadline({
          mode: session.mode,
          startedAt: session.startedAt,
          timeLimitSeconds: session.timeLimitSeconds,
        });
        if (
          deadlineCheck.isExpired ||
          (deadlineCheck.remainingSeconds !== null && deadlineCheck.remainingSeconds <= 0)
        ) {
          return await completeExamSession(userUid, session.id);
        }
      }
    }

    const orderItems: SessionOrderItem[] = JSON.parse(session.questionOrderJson || '[]');
    const qIds = orderItems.map((item) => item.questionId);

    // Parallelize all remote queries together with cached catalog:
    const [allQuestions, userBookmarks, catalog, savedAttempts] = await Promise.all([
      qIds.length > 0
        ? db.select().from(questions).where(inArray(questions.id, qIds))
        : Promise.resolve([]),
      db.select().from(bookmarks).where(eq(bookmarks.userUid, userUid)),
      getCachedCatalog(),
      session.status === 'completed'
        ? db
            .select()
            .from(questionAttempts)
            .where(
              and(
                eq(questionAttempts.sessionId, session.id),
                eq(questionAttempts.userUid, userUid)
              )
            )
        : Promise.resolve([]),
    ]);

    const { subjects: allSubjects, lectures: allLectures } = catalog;
    const bookmarkedSet = new Set(userBookmarks.map((b) => b.questionId));

    const qMap = new Map(allQuestions.map((q) => [q.id, q]));
    const sMap = new Map(allSubjects.map((s) => [s.id, s.title]));
    const lMap = new Map(allLectures.map((l) => [l.id, l.title]));
    const lPdfMap = new Map(allLectures.map((l) => [l.id, l.pdfUrl]));

    const attemptSnapshotMap = new Map<number, any>();
    for (const att of savedAttempts) {
      if (att.questionId !== null) {
        try {
          attemptSnapshotMap.set(att.questionId, JSON.parse(att.questionSnapshotJson));
        } catch {
          // fallback to live question
        }
      }
    }

    const isExamActive = session.mode === 'exam' && session.status === 'in_progress';

    const formattedQuestions = orderItems
      .map((item, idx) => {
        const snapshot = attemptSnapshotMap.get(item.questionId);
        const liveQ = qMap.get(item.questionId);
        const source = snapshot || liveQ;
        if (!source) return null;

        const canonicalQ: CanonicalQuestion = {
          id: item.questionId,
          subjectId: liveQ?.subjectId ?? 0,
          lectureId: liveQ?.lectureId ?? 0,
          subjectTitle:
            snapshot?.subjectTitle || (liveQ ? sMap.get(liveQ.subjectId) : 'Medical Subject'),
          lectureTitle:
            snapshot?.lectureTitle || (liveQ ? lMap.get(liveQ.lectureId) : 'Lecture'),
          questionText: source.questionText,
          optionA: source.optionA,
          optionB: source.optionB,
          optionC: source.optionC,
          optionD: source.optionD,
          correctAnswer: source.correctAnswer as OptionKey,
          explanation: source.explanation,
          explanationA: source.explanationA || '',
          explanationB: source.explanationB || '',
          explanationC: source.explanationC || '',
          explanationD: source.explanationD || '',
          difficulty: (source.difficulty || 'Medium') as DifficultyLevel,
          tags: source.tags || '',
          specialTags: source.specialTags || liveQ?.specialTags || '',
          diagramSvg: source.diagramSvg || liveQ?.diagramSvg || '',
          pageNumber: source.pageNumber ?? liveQ?.pageNumber ?? null,
          status: (liveQ?.status || 'published') as ContentStatus,
        };

        // In Exam mode: NEVER reveal answers while session is in progress (prevents cheating).
        // In Study or Custom mode: questions include explanations for instant 0ms feedback on click,
        // but client UI keeps feedback hidden until the student selects an option (item.submitted).
        const hideAnswers = isExamActive;

        const clientQ = formatQuestionForClient(canonicalQ, item.permutation, hideAnswers);
        return {
          ...clientQ,
          pageNumber: canonicalQ.pageNumber ?? liveQ?.pageNumber ?? null,
          lecturePdfUrl:
            snapshot?.lecturePdfUrl ||
            (liveQ ? lPdfMap.get(liveQ.lectureId) : null) ||
            null,
          index: idx,
          selectedDisplayed: item.selectedDisplayed,
          submitted: item.submitted,
          isBookmarked: bookmarkedSet.has(item.questionId),
        };
      })
      .filter(Boolean);

    // Authoritative server-side remaining timer calculation for Exam Mode
    const deadlineStatus = evaluateServerExamDeadline({
      mode: session.mode,
      startedAt: session.startedAt,
      timeLimitSeconds: session.timeLimitSeconds,
    });

    const remainingSeconds =
      session.timeLimitSeconds !== null
        ? session.status === 'completed'
          ? Math.max(0, session.timeLimitSeconds - session.elapsedSeconds)
          : deadlineStatus.remainingSeconds
        : null;

    return {
      id: session.id,
      title: session.title,
      mode: session.mode,
      subjectId: session.subjectId,
      lectureId: session.lectureId,
      status: session.status,
      totalQuestions: session.totalQuestions,
      correctCount: session.correctCount,
      incorrectCount: session.incorrectCount,
      unansweredCount: session.unansweredCount,
      scorePercentage: session.scorePercentage,
      timeLimitSeconds: session.timeLimitSeconds,
      elapsedSeconds:
        session.status === 'completed'
          ? session.elapsedSeconds
          : deadlineStatus.serverElapsedSeconds,
      remainingSeconds,
      isExpired: session.status === 'in_progress' ? deadlineStatus.isExpired : false,
      shuffleOptions: session.shuffleOptions,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      questions: formattedQuestions,
    };
  } catch (error: any) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error loading exam session:', error);
    throw new Error('Failed to load exam session.', { cause: error });
  }
}

/**
 * Records an answer selection for a single question inside a session.
 * Strictly enforces server-side exam deadlines and prevents modifying locked answers.
 */
export async function saveSessionQuestionAnswer(
  userUid: string,
  sessionId: number,
  questionId: number,
  displayedOption: OptionKey | null,
  lockAnswer: boolean,
  _clientElapsedSeconds?: number
) {
  try {
    if (
      displayedOption !== null &&
      displayedOption !== undefined &&
      !OPTION_KEYS.includes(displayedOption)
    ) {
      throw new ClientSafeError('Invalid answer option. Must be A, B, C, D, or null.', 400);
    }

    const rows = await db
      .select()
      .from(examSessions)
      .where(and(eq(examSessions.id, sessionId), eq(examSessions.userUid, userUid)));

    if (rows.length === 0) {
      throw new ClientSafeError('Forbidden: Session not found for this user.', 403);
    }

    const session = rows[0];
    if (session.status !== 'in_progress') {
      throw new ClientSafeError(
        'Cannot modify answers for a session that is already completed.',
        409
      );
    }

    const deadlineStatus = evaluateServerExamDeadline({
      mode: session.mode,
      startedAt: session.startedAt,
      timeLimitSeconds: session.timeLimitSeconds,
    });

    if (deadlineStatus.isExpired) {
      throw new ClientSafeError(
        'Exam time limit has expired. Further answer modifications are not allowed.',
        409
      );
    }

    const orderItems: SessionOrderItem[] = JSON.parse(session.questionOrderJson || '[]');
    const targetItem = orderItems.find((item) => item.questionId === questionId);
    if (!targetItem) {
      throw new ClientSafeError('Question does not belong to this session.', 400);
    }

    // In Study or Custom mode, once a question is locked/submitted and its explanation revealed,
    // prevent overwriting the submitted answer.
    if (session.mode !== 'exam' && targetItem.submitted) {
      return getExamSessionForStudent(userUid, sessionId);
    }

    targetItem.selectedDisplayed = displayedOption ?? null;
    targetItem.selectedCanonical = resolveCanonicalOption(
      displayedOption ?? null,
      targetItem.permutation
    );
    if (lockAnswer) {
      targetItem.submitted = true;
    }

    const qIds = orderItems.map((i) => i.questionId);
    const [dbQuestions, catalog] = await Promise.all([
      qIds.length > 0
        ? db.select().from(questions).where(inArray(questions.id, qIds))
        : Promise.resolve([]),
      getCachedCatalog(),
    ]);
    const qMap = new Map(dbQuestions.map((q) => [q.id, q]));
    const sMap = new Map(catalog.subjects.map((s: any) => [s.id, s.title]));
    const lMap = new Map(catalog.lectures.map((l: any) => [l.id, l.title]));

    let liveCorrectCount = 0;
    let liveIncorrectCount = 0;
    let liveUnansweredCount = 0;
    for (const item of orderItems) {
      const q = qMap.get(item.questionId);
      if (!q) continue;
      if (item.selectedCanonical === null || item.selectedCanonical === undefined) {
        liveUnansweredCount++;
      } else if (item.selectedCanonical === q.correctAnswer) {
        liveCorrectCount++;
      } else {
        liveIncorrectCount++;
      }
    }
    const totalQCount = orderItems.length;
    const liveScorePercentage =
      totalQCount > 0 ? Math.round((liveCorrectCount / totalQCount) * 100) : 0;

    const updatedElapsed = Math.max(
      session.elapsedSeconds,
      deadlineStatus.effectiveElapsedSeconds,
      typeof _clientElapsedSeconds === 'number' && Number.isFinite(_clientElapsedSeconds)
        ? Math.max(0, Math.floor(_clientElapsedSeconds))
        : 0
    );

    await db
      .update(examSessions)
      .set({
        questionOrderJson: JSON.stringify(orderItems),
        correctCount: liveCorrectCount,
        incorrectCount: liveIncorrectCount,
        unansweredCount: liveUnansweredCount,
        scorePercentage: liveScorePercentage,
        elapsedSeconds: updatedElapsed,
      })
      .where(
        and(
          eq(examSessions.id, sessionId),
          eq(examSessions.userUid, userUid),
          eq(examSessions.status, 'in_progress')
        )
      );

    // Immediately record/upsert the question attempt in question_attempts so dashboard & lecture labels update live
    const answeredQ = qMap.get(questionId);
    if (answeredQ && (session.mode !== 'exam' || lockAnswer)) {
      await db
        .delete(questionAttempts)
        .where(
          and(
            eq(questionAttempts.sessionId, sessionId),
            eq(questionAttempts.questionId, questionId),
            eq(questionAttempts.userUid, userUid)
          )
        );

      if (targetItem.selectedCanonical !== null) {
        const snapshotJson = JSON.stringify({
          id: answeredQ.id,
          subjectTitle: sMap.get(answeredQ.subjectId) || 'Medical Subject',
          lectureTitle: lMap.get(answeredQ.lectureId) || 'Lecture',
          questionText: answeredQ.questionText,
          optionA: answeredQ.optionA,
          optionB: answeredQ.optionB,
          optionC: answeredQ.optionC,
          optionD: answeredQ.optionD,
          correctAnswer: answeredQ.correctAnswer,
          explanation: answeredQ.explanation,
          explanationA: answeredQ.explanationA,
          explanationB: answeredQ.explanationB,
          explanationC: answeredQ.explanationC,
          explanationD: answeredQ.explanationD,
          difficulty: answeredQ.difficulty,
          tags: answeredQ.tags,
          specialTags: answeredQ.specialTags || '',
          diagramSvg: answeredQ.diagramSvg || '',
          pageNumber: answeredQ.pageNumber ?? null,
          version: answeredQ.version,
        });

        await db
          .insert(questionAttempts)
          .values({
            sessionId,
            userUid,
            questionId: answeredQ.id,
            subjectId: answeredQ.subjectId,
            lectureId: answeredQ.lectureId,
            selectedOption: targetItem.selectedCanonical,
            correctOptionSnapshot: answeredQ.correctAnswer,
            isCorrect: targetItem.selectedCanonical === answeredQ.correctAnswer,
            questionSnapshotJson: snapshotJson,
            timeSpentSeconds: 0,
          })
          .onConflictDoNothing();
      }
    }

    session.questionOrderJson = JSON.stringify(orderItems);
    session.correctCount = liveCorrectCount;
    session.incorrectCount = liveIncorrectCount;
    session.unansweredCount = liveUnansweredCount;
    session.scorePercentage = liveScorePercentage;
    session.elapsedSeconds = updatedElapsed;
    return getExamSessionForStudent(userUid, sessionId, session);
  } catch (error: any) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error saving question answer:', error);
    throw new Error('Failed to save question response.', { cause: error });
  }
}

/**
 * Syncs session elapsed time and progress safely when navigating or exiting.
 */
export async function syncSessionProgress(
  userUid: string,
  sessionId: number,
  elapsedSeconds?: number
) {
  if (typeof elapsedSeconds !== 'number') return;
  try {
    await db
      .update(examSessions)
      .set({
        elapsedSeconds: Math.max(0, Math.floor(elapsedSeconds)),
      })
      .where(
        and(
          eq(examSessions.id, sessionId),
          eq(examSessions.userUid, userUid),
          eq(examSessions.status, 'in_progress')
        )
      );
  } catch (error) {
    console.warn('Warning: Could not sync session progress on exit:', error);
  }
}

/**
 * Completes and grades an Exam or Study session atomically and idempotently inside a PostgreSQL transaction.
 * - Acquires a row-level lock (FOR UPDATE) on the session row so concurrent completion requests cannot race.
 * - Computes authoritative elapsed time from server timestamps (never trusting manipulated clientElapsedSeconds).
 * - Rejects post-deadline answer modifications in timed Exam Mode.
 * - Uses unique index protection on (session_id, question_id) in question_attempts.
 */
export async function completeExamSession(
  userUid: string,
  sessionId: number,
  finalDisplayedAnswers?: Record<number, OptionKey | null>,
  _clientElapsedSeconds?: number
) {
  try {
    await db.transaction(async (tx) => {
      // Acquire row-level lock on the exam session row to serialize concurrent completion calls
      await tx.execute(
        sql`SELECT id, status FROM exam_sessions WHERE id = ${sessionId} AND user_uid = ${userUid} FOR UPDATE`
      );

      const rows = await tx
        .select()
        .from(examSessions)
        .where(and(eq(examSessions.id, sessionId), eq(examSessions.userUid, userUid)));

      if (rows.length === 0) {
        throw new ClientSafeError('Forbidden: Session not found for this user.', 403);
      }

      const session = rows[0];
      if (session.status === 'completed') {
        return;
      }

      const deadlineStatus = evaluateServerExamDeadline({
        mode: session.mode,
        startedAt: session.startedAt,
        timeLimitSeconds: session.timeLimitSeconds,
      });

      const orderItems: SessionOrderItem[] = JSON.parse(session.questionOrderJson || '[]');

      if (finalDisplayedAnswers && typeof finalDisplayedAnswers === 'object') {
        // Check if client is attempting to alter answers after the server deadline expired
        if (deadlineStatus.isExpired) {
          let attemptedPostExpiryMutation = false;
          for (const item of orderItems) {
            if (item.questionId in finalDisplayedAnswers) {
              const disp = finalDisplayedAnswers[item.questionId] ?? null;
              if (disp !== item.selectedDisplayed) {
                attemptedPostExpiryMutation = true;
                break;
              }
            }
          }
          if (attemptedPostExpiryMutation && deadlineStatus.isPastSubmissionGrace) {
            throw new ClientSafeError(
              'Exam deadline has expired. Late answer modifications were rejected.',
              409
            );
          }
          // Even within auto-submit grace, if the deadline has passed, grade only answers already saved before expiry
          for (const item of orderItems) {
            item.submitted = true;
          }
        } else {
          for (const item of orderItems) {
            if (item.questionId in finalDisplayedAnswers) {
              const rawDisp = finalDisplayedAnswers[item.questionId];
              const validDisp =
                rawDisp && OPTION_KEYS.includes(rawDisp) ? rawDisp : null;
              item.selectedDisplayed = validDisp;
              item.selectedCanonical = resolveCanonicalOption(
                validDisp,
                item.permutation
              );
            }
            item.submitted = true;
          }
        }
      } else {
        for (const item of orderItems) {
          item.submitted = true;
        }
      }

      const qIds = orderItems.map((i) => i.questionId);
      const dbQuestions =
        qIds.length > 0
          ? await tx.select().from(questions).where(inArray(questions.id, qIds))
          : [];
      const allSubjects = await tx.select().from(subjects);
      const allLectures = await tx.select().from(lectures);

      const qMap = new Map(dbQuestions.map((q) => [q.id, q]));
      const sMap = new Map(allSubjects.map((s) => [s.id, s.title]));
      const lMap = new Map(allLectures.map((l) => [l.id, l.title]));

      const canonicalAnswersMap: Record<number, OptionKey | null> = {};
      const questionsForScoring: Array<{ id: number; correctAnswer: OptionKey }> = [];

      for (const item of orderItems) {
        const q = qMap.get(item.questionId);
        if (q) {
          questionsForScoring.push({
            id: q.id,
            correctAnswer: q.correctAnswer as OptionKey,
          });
          canonicalAnswersMap[q.id] = item.selectedCanonical;
        }
      }

      const score = scoreExamSession(questionsForScoring, canonicalAnswersMap);
      const finalElapsed = deadlineStatus.effectiveElapsedSeconds;

      // Conditional status transition from 'in_progress' -> 'completed'
      const updatedSessions = await tx
        .update(examSessions)
        .set({
          status: 'completed',
          correctCount: score.correctCount,
          incorrectCount: score.incorrectCount,
          unansweredCount: score.unansweredCount,
          scorePercentage: score.scorePercentage,
          elapsedSeconds: finalElapsed,
          questionOrderJson: JSON.stringify(orderItems),
          completedAt: new Date(),
        })
        .where(
          and(
            eq(examSessions.id, sessionId),
            eq(examSessions.userUid, userUid),
            eq(examSessions.status, 'in_progress')
          )
        )
        .returning();

      if (updatedSessions.length === 0) {
        return;
      }

      await tx
        .delete(questionAttempts)
        .where(
          and(
            eq(questionAttempts.sessionId, sessionId),
            eq(questionAttempts.userUid, userUid)
          )
        );

      const avgTimePerQ =
        score.totalQuestions > 0 ? Math.round(finalElapsed / score.totalQuestions) : 0;

      for (const res of score.questionResults) {
        const q = qMap.get(res.questionId);
        if (!q) continue;

        const snapshotJson = JSON.stringify({
          id: q.id,
          subjectTitle: sMap.get(q.subjectId) || 'Medical Subject',
          lectureTitle: lMap.get(q.lectureId) || 'Lecture',
          questionText: q.questionText,
          optionA: q.optionA,
          optionB: q.optionB,
          optionC: q.optionC,
          optionD: q.optionD,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation,
          explanationA: q.explanationA,
          explanationB: q.explanationB,
          explanationC: q.explanationC,
          explanationD: q.explanationD,
          difficulty: q.difficulty,
          tags: q.tags,
          specialTags: q.specialTags || '',
          diagramSvg: q.diagramSvg || '',
          pageNumber: q.pageNumber ?? null,
          version: q.version,
        });

        await tx
          .insert(questionAttempts)
          .values({
            sessionId,
            userUid,
            questionId: q.id,
            subjectId: q.subjectId,
            lectureId: q.lectureId,
            selectedOption: res.selectedCanonical,
            correctOptionSnapshot: res.correctCanonical,
            isCorrect: res.isCorrect,
            questionSnapshotJson: snapshotJson,
            timeSpentSeconds: avgTimePerQ,
          })
          .onConflictDoNothing();
      }
    });

    return getExamSessionForStudent(userUid, sessionId);
  } catch (error: any) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error completing exam session:', error);
    throw new Error('Failed to submit and grade exam session.', { cause: error });
  }
}

/**
 * Bookmarks management (private to each student)
 */
export async function toggleBookmarkForStudent(
  userUid: string,
  questionId: number,
  note?: string
) {
  try {
    const existing = await db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.userUid, userUid), eq(bookmarks.questionId, questionId)));

    if (existing.length > 0) {
      await db
        .delete(bookmarks)
        .where(and(eq(bookmarks.userUid, userUid), eq(bookmarks.questionId, questionId)));
      return { bookmarked: false, questionId };
    }

    const qRows = await db
      .select()
      .from(questions)
      .where(and(eq(questions.id, questionId), eq(questions.status, 'published')));
    if (qRows.length === 0) {
      throw new ClientSafeError('Question not found or not published.', 404);
    }

    await db.insert(bookmarks).values({
      userUid,
      questionId,
      note: note?.trim() || '',
    });
    return { bookmarked: true, questionId };
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error toggling bookmark:', error);
    throw new Error('Failed to update question bookmark.', { cause: error });
  }
}

export async function getStudentBookmarksAndReview(userUid: string) {
  try {
    await ensureSeededDatabase();
    const userBookmarks = await db
      .select()
      .from(bookmarks)
      .where(eq(bookmarks.userUid, userUid))
      .orderBy(desc(bookmarks.createdAt));

    const userAttempts = await db
      .select()
      .from(questionAttempts)
      .where(eq(questionAttempts.userUid, userUid))
      .orderBy(desc(questionAttempts.answeredAt));

    const allQuestions = await db
      .select()
      .from(questions)
      .where(eq(questions.status, 'published'));
    const allSubjects = await db.select().from(subjects);
    const allLectures = await db.select().from(lectures);

    const qMap = new Map(allQuestions.map((q) => [q.id, q]));
    const sMap = new Map(allSubjects.map((s) => [s.id, s.title]));
    const lMap = new Map(allLectures.map((l) => [l.id, l.title]));

    const latestAttemptByQuestion = new Map<
      number,
      { selectedOption: string | null; isCorrect: boolean; answeredAt: Date }
    >();
    for (const att of userAttempts) {
      if (att.questionId !== null && !latestAttemptByQuestion.has(att.questionId)) {
        latestAttemptByQuestion.set(att.questionId, {
          selectedOption: att.selectedOption,
          isCorrect: att.isCorrect,
          answeredAt: att.answeredAt,
        });
      }
    }

    const bookmarkedItems = userBookmarks
      .map((b) => {
        const q = qMap.get(b.questionId);
        if (!q) return null;
        const latestAtt = latestAttemptByQuestion.get(q.id);
        return {
          bookmarkId: b.id,
          bookmarkedAt: b.createdAt,
          note: b.note,
          questionId: q.id,
          subjectId: q.subjectId,
          lectureId: q.lectureId,
          subjectTitle: sMap.get(q.subjectId) || 'Subject',
          lectureTitle: lMap.get(q.lectureId) || 'Lecture',
          questionText: q.questionText,
          optionA: q.optionA,
          optionB: q.optionB,
          optionC: q.optionC,
          optionD: q.optionD,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation,
          explanationA: q.explanationA,
          explanationB: q.explanationB,
          explanationC: q.explanationC,
          explanationD: q.explanationD,
          difficulty: q.difficulty,
          tags: q.tags,
          specialTags: q.specialTags || '',
          diagramSvg: sanitizeSvgDiagram(q.diagramSvg),
          lastAttemptStatus: !latestAtt
            ? 'unanswered'
            : latestAtt.selectedOption === null
            ? 'unanswered'
            : latestAtt.isCorrect
            ? 'correct'
            : 'incorrect',
          lastSelectedOption: latestAtt?.selectedOption ?? null,
        };
      })
      .filter(Boolean);

    const bookmarkedIds = new Set(userBookmarks.map((b) => b.questionId));
    const answeredReviewItems = Array.from(latestAttemptByQuestion.entries())
      .map(([questionId, latestAtt]) => {
        const q = qMap.get(questionId);
        if (!q) return null;
        return {
          questionId: q.id,
          subjectId: q.subjectId,
          lectureId: q.lectureId,
          subjectTitle: sMap.get(q.subjectId) || 'Subject',
          lectureTitle: lMap.get(q.lectureId) || 'Lecture',
          questionText: q.questionText,
          optionA: q.optionA,
          optionB: q.optionB,
          optionC: q.optionC,
          optionD: q.optionD,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation,
          explanationA: q.explanationA,
          explanationB: q.explanationB,
          explanationC: q.explanationC,
          explanationD: q.explanationD,
          difficulty: q.difficulty,
          tags: q.tags,
          specialTags: q.specialTags || '',
          diagramSvg: sanitizeSvgDiagram(q.diagramSvg),
          isBookmarked: bookmarkedIds.has(q.id),
          status:
            latestAtt.selectedOption === null
              ? 'unanswered'
              : latestAtt.isCorrect
              ? 'correct'
              : 'incorrect',
          selectedOption: latestAtt.selectedOption,
          answeredAt: latestAtt.answeredAt,
        };
      })
      .filter(Boolean);

    return {
      bookmarks: bookmarkedItems,
      answeredQuestions: answeredReviewItems,
    };
  } catch (error) {
    console.error('Error fetching student bookmarks:', error);
    throw new Error('Failed to load bookmarks and review history.', { cause: error });
  }
}

/**
 * Consolidates multiple sessions for the same lecture down to strictly one single session per lecture.
 */
export async function consolidateUserLectureSessions(userUid: string) {
  try {
    const allUserSessions = await db
      .select()
      .from(examSessions)
      .where(eq(examSessions.userUid, userUid))
      .orderBy(desc(examSessions.startedAt));

    const sessionsByLecture = new Map<number, typeof allUserSessions>();
    for (const s of allUserSessions) {
      if (s.lectureId !== null && s.lectureId !== undefined) {
        const list = sessionsByLecture.get(s.lectureId) || [];
        list.push(s);
        sessionsByLecture.set(s.lectureId, list);
      }
    }

    const dupIdsToDelete: number[] = [];
    for (const [, list] of sessionsByLecture.entries()) {
      if (list.length > 1) {
        let best = list[0];
        let maxScore = -1;
        for (const s of list) {
          try {
            const items = JSON.parse(s.questionOrderJson || '[]');
            const ansCount = items.filter((i: any) => i.submitted || i.selectedDisplayed).length;
            const score = (s.status === 'in_progress' ? 1000 : 0) + ansCount;
            if (score > maxScore) {
              maxScore = score;
              best = s;
            }
          } catch {}
        }
        for (const s of list) {
          if (s.id !== best.id) {
            dupIdsToDelete.push(s.id);
          }
        }
      }
    }

    if (dupIdsToDelete.length > 0) {
      await db.delete(examSessions).where(inArray(examSessions.id, dupIdsToDelete));
    }
  } catch (err) {
    console.warn('Could not consolidate duplicate lecture sessions:', err);
  }
}

/**
 * Student Dashboard & Progress Analytics using real database records.
 * Clearly distinguishes between unique questions attempted and total answers submitted.
 */
export async function getStudentDashboardAnalytics(userUid: string) {
  try {
    await ensureSeededDatabase();
    await resolveActiveMockExamsForUser(userUid);
    await consolidateUserLectureSessions(userUid);
    const [userSessions, userAttempts, userBookmarks, allSubjects, allLectures, allQuestions] =
      await Promise.all([
        db
          .select()
          .from(examSessions)
          .where(eq(examSessions.userUid, userUid))
          .orderBy(desc(examSessions.startedAt)),
        db
          .select()
          .from(questionAttempts)
          .where(eq(questionAttempts.userUid, userUid))
          .orderBy(desc(questionAttempts.answeredAt)),
        db.select().from(bookmarks).where(eq(bookmarks.userUid, userUid)),
        db
          .select()
          .from(subjects)
          .where(eq(subjects.status, 'published'))
          .orderBy(asc(subjects.displayOrder)),
        db
          .select()
          .from(lectures)
          .where(eq(lectures.status, 'published'))
          .orderBy(asc(lectures.lectureNumber)),
        db
          .select()
          .from(questions)
          .where(eq(questions.status, 'published')),
      ]);

    const completedSessions = userSessions.filter((s) => s.status === 'completed');
    const inProgressSessions = userSessions.filter((s) => s.status === 'in_progress');

    const qMap = new Map(allQuestions.map((q) => [q.id, q]));
    const sMap = new Map(allSubjects.map((s) => [s.id, s.title]));
    const lMap = new Map(allLectures.map((l) => [l.id, l.title]));

    // Ensure any questions already solved inside in_progress sessions are reflected immediately in attempts
    const recordedAttemptKeys = new Set(
      userAttempts.map((a) => `${a.sessionId}:${a.questionId}`)
    );
    const synthesizedAttempts: typeof userAttempts = [];

    for (const s of userSessions) {
      if (s.mode === 'exam' && s.status === 'in_progress') continue;
      try {
        const orderItems: SessionOrderItem[] = JSON.parse(s.questionOrderJson || '[]');
        let liveCorrect = 0;
        let liveIncorrect = 0;
        let liveUnanswered = 0;

        for (const item of orderItems) {
          const q = qMap.get(item.questionId);
          if (!q) continue;
          const canonical =
            item.selectedCanonical ??
            resolveCanonicalOption(item.selectedDisplayed ?? null, item.permutation);

          if (!canonical) {
            liveUnanswered++;
            continue;
          }

          const isCorr = canonical === q.correctAnswer;
          if (isCorr) liveCorrect++;
          else liveIncorrect++;

          const key = `${s.id}:${q.id}`;
          if (!recordedAttemptKeys.has(key)) {
            recordedAttemptKeys.add(key);
            const snapshotJson = JSON.stringify({
              id: q.id,
              subjectTitle: sMap.get(q.subjectId) || 'Medical Subject',
              lectureTitle: lMap.get(q.lectureId) || 'Lecture',
              questionText: q.questionText,
              optionA: q.optionA,
              optionB: q.optionB,
              optionC: q.optionC,
              optionD: q.optionD,
              correctAnswer: q.correctAnswer,
              explanation: q.explanation,
              explanationA: q.explanationA,
              explanationB: q.explanationB,
              explanationC: q.explanationC,
              explanationD: q.explanationD,
              difficulty: q.difficulty,
              tags: q.tags,
              diagramSvg: q.diagramSvg || '',
              pageNumber: q.pageNumber ?? null,
              version: q.version,
            });

            synthesizedAttempts.push({
              id: 0,
              sessionId: s.id,
              userUid,
              questionId: q.id,
              subjectId: q.subjectId,
              lectureId: q.lectureId,
              selectedOption: canonical,
              correctOptionSnapshot: q.correctAnswer,
              isCorrect: isCorr,
              questionSnapshotJson: snapshotJson,
              timeSpentSeconds: 0,
              answeredAt: s.startedAt,
            });

            // Backfill into question_attempts asynchronously so it's permanently stored
            db.insert(questionAttempts)
              .values({
                sessionId: s.id,
                userUid,
                questionId: q.id,
                subjectId: q.subjectId,
                lectureId: q.lectureId,
                selectedOption: canonical,
                correctOptionSnapshot: q.correctAnswer,
                isCorrect: isCorr,
                questionSnapshotJson: snapshotJson,
                timeSpentSeconds: 0,
              })
              .onConflictDoNothing()
              .catch(() => {});
          }
        }

        if (s.status === 'in_progress' && orderItems.length > 0) {
          const liveScorePct = Math.round((liveCorrect / orderItems.length) * 100);
          if (
            s.correctCount !== liveCorrect ||
            s.incorrectCount !== liveIncorrect ||
            s.unansweredCount !== liveUnanswered
          ) {
            s.correctCount = liveCorrect;
            s.incorrectCount = liveIncorrect;
            s.unansweredCount = liveUnanswered;
            s.scorePercentage = liveScorePct;
            db.update(examSessions)
              .set({
                correctCount: liveCorrect,
                incorrectCount: liveIncorrect,
                unansweredCount: liveUnanswered,
                scorePercentage: liveScorePct,
              })
              .where(eq(examSessions.id, s.id))
              .catch(() => {});
          }
        }
      } catch {}
    }

    const combinedAttempts = [...userAttempts, ...synthesizedAttempts];
    const answeredAttempts = combinedAttempts.filter((a) => a.selectedOption !== null);

    // Deduplicate by questionId (keeping the latest attempt per unique question)
    // so each solved question in a lecture directly and accurately updates the lecture label
    const latestAttemptByQuestionId = new Map<number, (typeof answeredAttempts)[0]>();
    for (const att of answeredAttempts) {
      if (att.questionId !== null && !latestAttemptByQuestionId.has(att.questionId)) {
        latestAttemptByQuestionId.set(att.questionId, att);
      }
    }
    const uniqueLatestAttempts = Array.from(latestAttemptByQuestionId.values());

    const totalAnswersSubmitted = uniqueLatestAttempts.length;
    const totalCorrectAnswers = uniqueLatestAttempts.filter((a) => a.isCorrect).length;
    const totalIncorrectAnswers = totalAnswersSubmitted - totalCorrectAnswers;
    const overallAccuracy =
      totalAnswersSubmitted > 0
        ? Math.round((totalCorrectAnswers / totalAnswersSubmitted) * 100)
        : 0;

    const uniqueQuestionIds = new Set(
      uniqueLatestAttempts.map((a) => a.questionId).filter((id): id is number => id !== null)
    );
    const uniqueLecturesAttempted = new Set(
      uniqueLatestAttempts.map((a) => a.lectureId).filter((id): id is number => id !== null)
    );
    const remainingUnansweredQuestions = Math.max(0, allQuestions.length - uniqueQuestionIds.size);

    // Subject & Lecture breakdown (reflecting every solved question immediately)
    const subjectProgress = allSubjects.map((subj) => {
      const subjQuestions = allQuestions.filter((q) => q.subjectId === subj.id);
      const subjAttempts = uniqueLatestAttempts.filter((a) => a.subjectId === subj.id);
      const subjUniqueIds = new Set(
        subjAttempts.map((a) => a.questionId).filter((id): id is number => id !== null)
      );
      const subjCorrect = subjAttempts.filter((a) => a.isCorrect).length;
      const subjIncorrect = subjAttempts.length - subjCorrect;
      const accuracy =
        subjAttempts.length > 0 ? Math.round((subjCorrect / subjAttempts.length) * 100) : 0;
      const latestAttempt = subjAttempts[0]?.answeredAt ?? null;

      const lectureBreakdown = allLectures
        .filter((l) => l.subjectId === subj.id)
        .sort((a, b) => a.lectureNumber - b.lectureNumber)
        .map((lect) => {
          const lectQuestions = subjQuestions.filter((q) => q.lectureId === lect.id);
          const lectAttempts = subjAttempts.filter((a) => a.lectureId === lect.id);
          const lectUniqueIds = new Set(
            lectAttempts.map((a) => a.questionId).filter((id): id is number => id !== null)
          );
          const lectCorrect = lectAttempts.filter((a) => a.isCorrect).length;
          const lectIncorrect = lectAttempts.length - lectCorrect;
          return {
            lectureId: lect.id,
            title: lect.title,
            description: lect.description,
            lectureNumber: lect.lectureNumber,
            pdfUrl: lect.pdfUrl,
            totalPublishedQuestions: lectQuestions.length,
            uniqueQuestionsAttempted: lectUniqueIds.size,
            remainingUnansweredQuestions: Math.max(0, lectQuestions.length - lectUniqueIds.size),
            totalAnswersSubmitted: lectAttempts.length,
            correctAnswers: lectCorrect,
            incorrectAnswers: lectIncorrect,
            accuracyPercentage:
              lectAttempts.length > 0
                ? Math.round((lectCorrect / lectAttempts.length) * 100)
                : 0,
            lastAttemptAt: lectAttempts[0]?.answeredAt ?? null,
          };
        });

      return {
        subjectId: subj.id,
        title: subj.title,
        description: subj.description,
        slug: subj.slug,
        displayOrder: subj.displayOrder,
        lectureCount: lectureBreakdown.length,
        totalPublishedQuestions: subjQuestions.length,
        uniqueQuestionsAttempted: subjUniqueIds.size,
        remainingUnansweredQuestions: Math.max(0, subjQuestions.length - subjUniqueIds.size),
        totalAnswersSubmitted: subjAttempts.length,
        correctAnswers: subjCorrect,
        incorrectAnswers: subjIncorrect,
        accuracyPercentage: accuracy,
        lastAttemptAt: latestAttempt,
        lectures: lectureBreakdown,
      };
    });

    // Weak-topic analysis with small-sample transparency
    const attemptsWithTags = uniqueLatestAttempts.map((att) => {
      let tags = '';
      try {
        const snap = JSON.parse(att.questionSnapshotJson);
        tags = snap.tags || '';
      } catch {
        const liveQ = allQuestions.find((q) => q.id === att.questionId);
        tags = liveQ?.tags || '';
      }
      return {
        questionId: att.questionId,
        isCorrect: att.isCorrect,
        tags,
      };
    });

    const topicPerformance = computeTopicPerformance(attemptsWithTags);

    const seenLectureIds = new Set<number>();
    const deduplicatedSessions: typeof userSessions = [];

    for (const s of userSessions) {
      if (s.lectureId !== null && s.lectureId !== undefined) {
        if (seenLectureIds.has(s.lectureId)) {
          continue; // Only preserve one progress per lecture
        }
        seenLectureIds.add(s.lectureId);
      }
      deduplicatedSessions.push(s);
    }

    const history = deduplicatedSessions.map((s) => {
      let answeredCount = 0;
      try {
        const items = JSON.parse(s.questionOrderJson || '[]');
        answeredCount = items.filter((i: any) => i.submitted || i.selectedDisplayed).length;
      } catch {
        answeredCount = s.totalQuestions - s.unansweredCount;
      }
      const deadline = evaluateServerExamDeadline({
        mode: s.mode,
        startedAt: s.startedAt,
        timeLimitSeconds: s.timeLimitSeconds,
      });
      return {
        id: s.id,
        title: s.title,
        mode: s.mode,
        status: s.status,
        subjectTitle: s.subjectId ? sMap.get(s.subjectId) || 'Multi-Subject' : 'Multi-Subject',
        lectureTitle: s.lectureId ? lMap.get(s.lectureId) || 'All Lectures' : 'Multiple Lectures',
        totalQuestions: s.totalQuestions,
        answeredCount,
        correctCount: s.correctCount,
        incorrectCount: s.incorrectCount,
        unansweredCount: s.unansweredCount,
        scorePercentage: s.scorePercentage,
        timeLimitSeconds: s.timeLimitSeconds,
        remainingSeconds:
          s.status === 'in_progress' && s.mode === 'exam' ? deadline.remainingSeconds : null,
        elapsedSeconds: s.elapsedSeconds,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
      };
    });

    return {
      summary: {
        totalCompletedAttempts: completedSessions.length,
        inProgressCount: inProgressSessions.length,
        totalQuestionsAnswered: totalAnswersSubmitted,
        uniqueQuestionsAttempted: uniqueQuestionIds.size,
        totalPublishedQuestions: allQuestions.length,
        totalCorrectAnswers,
        totalIncorrectAnswers,
        remainingUnansweredQuestions,
        overallAccuracy,
        accuracyPercentage: overallAccuracy,
        lecturesAttemptedCount: uniqueLecturesAttempted.size,
        totalPublishedLectures: allLectures.length,
        bookmarkCount: userBookmarks.length,
      },
      subjectProgress,
      topicPerformance,
      history,
    };
  } catch (error) {
    console.error('Error building student dashboard analytics:', error);
    throw new Error('Failed to load student progress analytics.', { cause: error });
  }
}

/**
 * ADMINISTRATOR REPOSITORY OPERATIONS
 * Every admin operation logs to adminAuditLogs and preserves historical attempts.
 */
export async function logAdminAction(
  adminUid: string,
  adminEmail: string,
  action: string,
  targetType: string,
  targetId: string | number,
  details: string
) {
  try {
    await db.insert(adminAuditLogs).values({
      adminUid,
      adminEmail,
      action,
      targetType,
      targetId: String(targetId),
      details,
    });
  } catch (error) {
    console.error('Failed to write admin audit log:', error);
  }
}

export async function getAdminDashboardData() {
  try {
    await ensureSeededDatabase();
    const [
      allUsers,
      allModules,
      allSubjects,
      allLectures,
      allBanks,
      allQuestions,
      recentSessions,
      recentImports,
      recentAuditLogs,
    ] = await Promise.all([
      db.select().from(users).orderBy(desc(users.createdAt)),
      db
        .select()
        .from(modules)
        .orderBy(asc(modules.displayOrder), asc(modules.id)),
      db
        .select()
        .from(subjects)
        .orderBy(asc(subjects.displayOrder), asc(subjects.id)),
      db
        .select()
        .from(lectures)
        .orderBy(asc(lectures.subjectId), asc(lectures.lectureNumber)),
      db.select().from(questionBanks),
      db
        .select()
        .from(questions)
        .orderBy(desc(questions.updatedAt), desc(questions.id)),
      db
        .select()
        .from(examSessions)
        .orderBy(desc(examSessions.startedAt))
        .limit(15),
      db
        .select()
        .from(importBatches)
        .orderBy(desc(importBatches.createdAt))
        .limit(10),
      db
        .select()
        .from(adminAuditLogs)
        .orderBy(desc(adminAuditLogs.createdAt))
        .limit(25),
    ]);

    const sMap = new Map(allSubjects.map((s) => [s.id, s.title]));
    const lMap = new Map(allLectures.map((l) => [l.id, l.title]));
    const mMap = new Map(allModules.map((m) => [m.id, `${m.code} - ${m.title}`]));

    return {
      metrics: {
        totalUsers: allUsers.length,
        totalModules: allModules.length,
        publishedSubjects: allSubjects.filter((s) => s.status === 'published').length,
        totalSubjects: allSubjects.length,
        publishedLectures: allLectures.filter((l) => l.status === 'published').length,
        totalLectures: allLectures.length,
        publishedQuestions: allQuestions.filter((q) => q.status === 'published').length,
        totalQuestions: allQuestions.length,
        completedExamsCount: recentSessions.filter((s) => s.status === 'completed').length,
      },
      modules: allModules.map((m) => {
        const modSubjects = allSubjects.filter((s) => s.moduleId === m.id);
        return {
          ...m,
          subjects: modSubjects,
          subjectCount: modSubjects.length,
          lectureCount: allLectures.filter((l) => modSubjects.some((s) => s.id === l.subjectId)).length,
          questionCount: allQuestions.filter((q) => modSubjects.some((s) => s.id === q.subjectId)).length,
        };
      }),
      subjects: allSubjects.map((s) => ({
        ...s,
        moduleName: s.moduleId ? mMap.get(s.moduleId) || 'Unassigned Module' : 'Unassigned Module',
        lectureCount: allLectures.filter((l) => l.subjectId === s.id).length,
        questionCount: allQuestions.filter((q) => q.subjectId === s.id).length,
      })),
      lectures: allLectures.map((l) => ({
        ...l,
        subjectTitle: sMap.get(l.subjectId) || 'Unknown Subject',
        questionCount: allQuestions.filter((q) => q.lectureId === l.id).length,
      })),
      questionBanks: allBanks.map((b) => ({
        ...b,
        subjectTitle: sMap.get(b.subjectId) || 'Unknown Subject',
        lectureTitle: b.lectureId ? lMap.get(b.lectureId) || 'Unknown Lecture' : 'All Lectures',
        questionCount: allQuestions.filter(
          (q) => q.questionBankId === b.id || (b.lectureId && q.lectureId === b.lectureId)
        ).length,
      })),
      questions: allQuestions.map((q) => ({
        ...q,
        diagramSvg: sanitizeSvgDiagram(q.diagramSvg),
        subjectTitle: sMap.get(q.subjectId) || 'Unknown Subject',
        lectureTitle: lMap.get(q.lectureId) || 'Unknown Lecture',
      })),
      users: allUsers.map(({ passwordHash: _ph, ...u }) => ({
        ...u,
        isOwner:
          isOwnerAdminEmail(u.email) &&
          u.authProvider !== 'local' &&
          Boolean(u.emailVerified),
      })),
      recentActivity: recentSessions,
      recentImports,
      auditLogs: recentAuditLogs,
    };
  } catch (error) {
    console.error('Error loading admin dashboard:', error);
    throw new Error('Failed to load administrator console data.', { cause: error });
  }
}

export async function upsertModuleAdmin(
  admin: { uid: string; email: string },
  payload: {
    id?: number;
    code: string;
    title: string;
    description: string;
    displayOrder: number;
    status: ContentStatus;
  }
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    const cleanCode = payload.code.trim();
    const cleanTitle = payload.title.trim();
    if (!cleanCode || !cleanTitle) {
      throw new ClientSafeError('Module code and title are required.', 400);
    }

    if (payload.id) {
      const [updated] = await db
        .update(modules)
        .set({
          code: cleanCode,
          title: cleanTitle,
          description: payload.description.trim(),
          displayOrder: Number(payload.displayOrder) || 1,
          status: payload.status,
          updatedAt: new Date(),
        })
        .where(eq(modules.id, payload.id))
        .returning();

      await logAdminAction(
        verifiedAdmin.uid,
        verifiedAdmin.email,
        'UPDATE_MODULE',
        'module',
        updated.id,
        `Updated module "${updated.code}: ${updated.title}" (status: ${updated.status})`
      );
      invalidateCatalogCache();
      return updated;
    }

    const [created] = await db
      .insert(modules)
      .values({
        code: cleanCode,
        title: cleanTitle,
        description: payload.description.trim(),
        displayOrder: Number(payload.displayOrder) || 1,
        status: payload.status || 'published',
      })
      .returning();

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'CREATE_MODULE',
      'module',
      created.id,
      `Created module "${created.code}: ${created.title}"`
    );
    invalidateCatalogCache();
    return created;
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error saving module:', error);
    throw new Error('Failed to save module.', { cause: error });
  }
}

export async function deleteModuleAdmin(
  admin: { uid: string; email: string },
  moduleId: number
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    const [deleted] = await db
      .delete(modules)
      .where(eq(modules.id, moduleId))
      .returning();

    if (deleted) {
      await logAdminAction(
        verifiedAdmin.uid,
        verifiedAdmin.email,
        'DELETE_MODULE',
        'module',
        deleted.id,
        `Deleted module "${deleted.code}: ${deleted.title}"`
      );
    }
    invalidateCatalogCache();
    return deleted;
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error deleting module:', error);
    throw new Error('Failed to delete module.', { cause: error });
  }
}

export async function upsertSubjectAdmin(
  admin: { uid: string; email: string },
  payload: {
    id?: number;
    moduleId?: number | null;
    title: string;
    description: string;
    displayOrder: number;
    status: ContentStatus;
  }
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    const slug = payload.title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    if (payload.id) {
      const [updated] = await db
        .update(subjects)
        .set({
          moduleId: payload.moduleId !== undefined ? payload.moduleId : null,
          title: payload.title.trim(),
          description: payload.description.trim(),
          displayOrder: Number(payload.displayOrder) || 1,
          status: payload.status,
          updatedAt: new Date(),
        })
        .where(eq(subjects.id, payload.id))
        .returning();

      await logAdminAction(
        verifiedAdmin.uid,
        verifiedAdmin.email,
        'UPDATE_SUBJECT',
        'subject',
        updated.id,
        `Updated subject "${updated.title}" (status: ${updated.status})`
      );
      invalidateCatalogCache();
      return updated;
    }

    const [created] = await db
      .insert(subjects)
      .values({
        moduleId: payload.moduleId ?? null,
        slug: `${slug}-${Date.now().toString(36)}`,
        title: payload.title.trim(),
        description: payload.description.trim(),
        displayOrder: Number(payload.displayOrder) || 1,
        status: payload.status || 'published',
      })
      .returning();

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'CREATE_SUBJECT',
      'subject',
      created.id,
      `Created subject "${created.title}"`
    );
    invalidateCatalogCache();
    return created;
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error saving subject:', error);
    throw new Error('Failed to save subject.', { cause: error });
  }
}

export async function upsertLectureAdmin(
  admin: { uid: string; email: string },
  payload: {
    id?: number;
    subjectId: number;
    title: string;
    description: string;
    lectureNumber: number;
    educationalNotes?: string;
    estimatedMinutes?: number;
    pdfUrl?: string | null;
    status: ContentStatus;
  }
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    const cleanPdfUrl =
      payload.pdfUrl && typeof payload.pdfUrl === 'string' && payload.pdfUrl.trim()
        ? payload.pdfUrl.trim()
        : null;

    if (payload.id) {
      const [updated] = await db
        .update(lectures)
        .set({
          subjectId: Number(payload.subjectId),
          title: payload.title.trim(),
          description: payload.description.trim(),
          lectureNumber: Number(payload.lectureNumber) || 1,
          educationalNotes: payload.educationalNotes?.trim() || '',
          estimatedMinutes: Number(payload.estimatedMinutes) || 30,
          pdfUrl: cleanPdfUrl,
          status: payload.status,
          updatedAt: new Date(),
        })
        .where(eq(lectures.id, payload.id))
        .returning();

      await logAdminAction(
        verifiedAdmin.uid,
        verifiedAdmin.email,
        'UPDATE_LECTURE',
        'lecture',
        updated.id,
        `Updated lecture "${updated.title}" (status: ${updated.status})`
      );
      invalidateCatalogCache();
      return updated;
    }

    const created = await db.transaction(async (tx) => {
      const [insertedLecture] = await tx
        .insert(lectures)
        .values({
          subjectId: Number(payload.subjectId),
          title: payload.title.trim(),
          description: payload.description.trim(),
          lectureNumber: Number(payload.lectureNumber) || 1,
          educationalNotes: payload.educationalNotes?.trim() || '',
          estimatedMinutes: Number(payload.estimatedMinutes) || 30,
          pdfUrl: cleanPdfUrl,
          status: payload.status || 'published',
        })
        .returning();

      // Automatically create a default Practice Question Bank for the new lecture
      await tx.insert(questionBanks).values({
        subjectId: insertedLecture.subjectId,
        lectureId: insertedLecture.id,
        title: `${insertedLecture.title} — Practice Bank`,
        description: `Formative practice bank for ${insertedLecture.title}.`,
        bankType: 'practice',
        status: 'published',
      });

      return insertedLecture;
    });

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'CREATE_LECTURE',
      'lecture',
      created.id,
      `Created lecture "${created.title}"`
    );
    invalidateCatalogCache();
    return created;
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error saving lecture:', error);
    throw new Error('Failed to save lecture.', { cause: error });
  }
}

/**
 * Attaches or updates a PDF document URL directly on a lecture (e.g. after lectures are generated or imported).
 */
export async function attachPdfToLectureAdmin(
  admin: { uid: string; email: string },
  lectureId: number,
  pdfUrl: string | null
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    const cleanPdfUrl =
      pdfUrl && typeof pdfUrl === 'string' && pdfUrl.trim()
        ? pdfUrl.trim()
        : null;

    const [updated] = await db
      .update(lectures)
      .set({
        pdfUrl: cleanPdfUrl,
        updatedAt: new Date(),
      })
      .where(eq(lectures.id, lectureId))
      .returning();

    if (!updated) {
      throw new ClientSafeError(`Lecture with ID ${lectureId} not found.`, 404);
    }

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'ATTACH_LECTURE_PDF',
      'lecture',
      updated.id,
      cleanPdfUrl
        ? `Attached PDF "${cleanPdfUrl}" to lecture "${updated.title}" (ID: ${updated.id})`
        : `Removed PDF from lecture "${updated.title}" (ID: ${updated.id})`
    );

    invalidateCatalogCache();
    return updated;
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error attaching PDF to lecture:', error);
    throw new Error('Failed to attach PDF to lecture.', { cause: error });
  }
}

/**
 * Saves an uploaded PDF file and its binary base64 data to the PostgreSQL database `lecture_files` table.
 */
export async function saveUploadedPdfFileAdmin(
  admin: { uid: string; email: string },
  params: {
    fileName: string;
    mimeType: string;
    fileSize: number;
    dataBase64: string;
    url: string;
    telegramFileId?: string | null;
  }
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    const [saved] = await db
      .insert(lectureFiles)
      .values({
        fileName: params.fileName,
        mimeType: params.mimeType || 'application/pdf',
        fileSize: Number(params.fileSize) || 0,
        dataBase64: params.dataBase64,
        url: params.url,
        telegramFileId: params.telegramFileId || null,
      })
      .onConflictDoUpdate({
        target: lectureFiles.url,
        set: {
          fileName: params.fileName,
          fileSize: Number(params.fileSize) || 0,
          dataBase64: params.dataBase64,
          mimeType: params.mimeType || 'application/pdf',
          telegramFileId: params.telegramFileId || null,
        },
      })
      .returning();

    pdfTelegramMetaCache.set(saved.url, {
      telegramFileId: saved.telegramFileId || null,
      mimeType: saved.mimeType || 'application/pdf',
      fileSize: saved.fileSize || 0,
    });

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'UPLOAD_LECTURE_PDF',
      'lecture_file',
      saved.id,
      `Uploaded and saved lecture PDF "${saved.fileName}" (${Math.round(saved.fileSize / 1024)} KB) to database`
    );

    return saved;
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error saving uploaded PDF to database:', error);
    throw new Error('Failed to save PDF to database.', { cause: error });
  }
}

const pdfTelegramMetaCache = new Map<
  string,
  { telegramFileId: string | null; mimeType: string; fileSize: number }
>();

/**
 * Lightweight metadata lookup for Plan B Telegram streaming.
 * Excludes data_base64 so zero large binary payload is transferred from Supabase PostgreSQL.
 */
export async function getPdfTelegramMetadataByUrl(url: string) {
  const cached = pdfTelegramMetaCache.get(url);
  if (cached && cached.telegramFileId) {
    return cached;
  }
  try {
    const rows = await db
      .select({
        telegramFileId: lectureFiles.telegramFileId,
        mimeType: lectureFiles.mimeType,
        fileSize: lectureFiles.fileSize,
      })
      .from(lectureFiles)
      .where(eq(lectureFiles.url, url))
      .limit(1);
    const record = rows[0] || null;
    if (record) {
      pdfTelegramMetaCache.set(url, {
        telegramFileId: record.telegramFileId || null,
        mimeType: record.mimeType || 'application/pdf',
        fileSize: record.fileSize || 0,
      });
    }
    return record;
  } catch (error) {
    console.error('Error fetching PDF Telegram metadata from database:', error);
    return null;
  }
}

/**
 * Retrieves a stored lecture PDF by its URL from the PostgreSQL database.
 */
export async function getUploadedPdfByUrl(url: string) {
  try {
    const rows = await db
      .select()
      .from(lectureFiles)
      .where(eq(lectureFiles.url, url))
      .limit(1);
    const row = rows[0] || null;
    if (row) {
      pdfTelegramMetaCache.set(url, {
        telegramFileId: row.telegramFileId || null,
        mimeType: row.mimeType || 'application/pdf',
        fileSize: row.fileSize || 0,
      });
    }
    return row;
  } catch (error) {
    console.error('Error fetching uploaded PDF from database:', error);
    return null;
  }
}

/**
 * Updates the telegram_file_id for an uploaded PDF file record.
 */
export async function updateLectureFileTelegramId(url: string, telegramFileId: string) {
  try {
    await db
      .update(lectureFiles)
      .set({ telegramFileId })
      .where(eq(lectureFiles.url, url));
    const existing = pdfTelegramMetaCache.get(url);
    pdfTelegramMetaCache.set(url, {
      telegramFileId,
      mimeType: existing?.mimeType || 'application/pdf',
      fileSize: existing?.fileSize || 0,
    });
    return true;
  } catch (error) {
    console.error('Error updating telegram_file_id in database:', error);
    return false;
  }
}

export async function upsertQuestionAdmin(
  admin: { uid: string; email: string },
  payload: {
    id?: number;
    subjectId: number;
    lectureId: number;
    questionText: string;
    optionA: string;
    optionB: string;
    optionC: string;
    optionD: string;
    correctAnswer: OptionKey;
    explanation: string;
    explanationA?: string;
    explanationB?: string;
    explanationC?: string;
    explanationD?: string;
    diagramSvg?: string;
    pageNumber?: number | null;
    difficulty: DifficultyLevel;
    tags?: string;
    specialTags?: string;
    status: ContentStatus;
  }
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    const sanitizedSvg = sanitizeSvgDiagram(payload.diagramSvg);
    const contentHash = computeContentHash(
      `${payload.subjectId}|${payload.lectureId}|${payload.questionText}|${payload.optionA}|${payload.optionB}|${payload.optionC}|${payload.optionD}`
    );

    let cleanPageNumber: number | null = null;
    if (
      payload.pageNumber !== undefined &&
      payload.pageNumber !== null &&
      String(payload.pageNumber).trim() !== ''
    ) {
      const p = Number(payload.pageNumber);
      if (!Number.isInteger(p) || p <= 0) {
        throw new ClientSafeError('PDF Page Number must be a positive integer.', 400);
      }
      cleanPageNumber = p;
    }

    if (payload.id) {
      const existing = await db
        .select()
        .from(questions)
        .where(eq(questions.id, payload.id));
      const nextVersion = (existing[0]?.version || 1) + 1;

      const [updated] = await db
        .update(questions)
        .set({
          subjectId: Number(payload.subjectId),
          lectureId: Number(payload.lectureId),
          questionText: payload.questionText.trim(),
          optionA: payload.optionA.trim(),
          optionB: payload.optionB.trim(),
          optionC: payload.optionC.trim(),
          optionD: payload.optionD.trim(),
          correctAnswer: payload.correctAnswer,
          explanation: payload.explanation.trim(),
          explanationA: payload.explanationA?.trim() || '',
          explanationB: payload.explanationB?.trim() || '',
          explanationC: payload.explanationC?.trim() || '',
          explanationD: payload.explanationD?.trim() || '',
          ...(payload.diagramSvg !== undefined ? { diagramSvg: sanitizedSvg } : {}),
          pageNumber: cleanPageNumber,
          difficulty: payload.difficulty,
          tags: payload.tags?.trim() || '',
          specialTags: payload.specialTags?.trim() || '',
          status: payload.status,
          version: nextVersion,
          contentHash,
          updatedAt: new Date(),
        })
        .where(eq(questions.id, payload.id))
        .returning();

      await logAdminAction(
        verifiedAdmin.uid,
        verifiedAdmin.email,
        'UPDATE_QUESTION',
        'question',
        updated.id,
        `Updated question #${updated.id} to v${nextVersion} (historical attempt snapshots remain untouched)`
      );
      return {
        ...updated,
        diagramSvg: sanitizeSvgDiagram(updated.diagramSvg),
      };
    }

    const [created] = await db
      .insert(questions)
      .values({
        subjectId: Number(payload.subjectId),
        lectureId: Number(payload.lectureId),
        questionText: payload.questionText.trim(),
        optionA: payload.optionA.trim(),
        optionB: payload.optionB.trim(),
        optionC: payload.optionC.trim(),
        optionD: payload.optionD.trim(),
        correctAnswer: payload.correctAnswer,
        explanation: payload.explanation.trim(),
        explanationA: payload.explanationA?.trim() || '',
        explanationB: payload.explanationB?.trim() || '',
        explanationC: payload.explanationC?.trim() || '',
        explanationD: payload.explanationD?.trim() || '',
        diagramSvg: sanitizedSvg,
        pageNumber: cleanPageNumber,
        difficulty: payload.difficulty,
        tags: payload.tags?.trim() || '',
        specialTags: payload.specialTags?.trim() || '',
        status: payload.status || 'published',
        version: 1,
        contentHash,
      })
      .returning();

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'CREATE_QUESTION',
      'question',
      created.id,
      `Created question #${created.id} (${created.difficulty})`
    );
    return {
      ...created,
      diagramSvg: sanitizeSvgDiagram(created.diagramSvg),
    };
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error saving question:', error);
    throw new Error('Failed to save question.', { cause: error });
  }
}

/**
 * Permanently deletes a Subject and all its Lectures, Question Banks (Quizzes),
 * Questions, Bookmarks, Question Attempts, and Exam Sessions atomically.
 */
export async function deleteSubjectAdmin(
  admin: { uid: string; email: string },
  subjectId: number
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    const { title, qCount } = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(subjects)
        .where(eq(subjects.id, subjectId));
      const subjTitle = existing[0]?.title || `Subject #${subjectId}`;

      const subjectQuestions = await tx
        .select({ id: questions.id })
        .from(questions)
        .where(eq(questions.subjectId, subjectId));
      const qIds = subjectQuestions.map((q) => q.id);

      if (qIds.length > 0) {
        await tx.delete(bookmarks).where(inArray(bookmarks.questionId, qIds));
        await tx
          .delete(questionAttempts)
          .where(inArray(questionAttempts.questionId, qIds));
      }

      await tx
        .delete(questionAttempts)
        .where(eq(questionAttempts.subjectId, subjectId));
      await tx.delete(examSessions).where(eq(examSessions.subjectId, subjectId));
      await tx.delete(questions).where(eq(questions.subjectId, subjectId));
      await tx.delete(questionBanks).where(eq(questionBanks.subjectId, subjectId));
      await tx.delete(lectures).where(eq(lectures.subjectId, subjectId));
      await tx.delete(subjects).where(eq(subjects.id, subjectId));

      return { title: subjTitle, qCount: qIds.length };
    });

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'DELETE_SUBJECT',
      'subject',
      subjectId,
      `Permanently deleted subject "${title}" and all its lectures, quizzes, and ${qCount} question(s).`
    );

    invalidateCatalogCache();
    return {
      action: 'deleted',
      message: `Subject "${title}" and all associated lectures, quizzes, and questions were permanently deleted.`,
    };
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error deleting subject:', error);
    throw new Error('Failed to delete subject.', { cause: error });
  }
}

/**
 * Permanently deletes a Lecture and all its Question Banks (Quizzes),
 * Questions, Bookmarks, Question Attempts, and Exam Sessions atomically.
 */
export async function deleteLectureAdmin(
  admin: { uid: string; email: string },
  lectureId: number
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    const { title, qCount } = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(lectures)
        .where(eq(lectures.id, lectureId));
      const lectTitle = existing[0]?.title || `Lecture #${lectureId}`;

      const lectureQuestions = await tx
        .select({ id: questions.id })
        .from(questions)
        .where(eq(questions.lectureId, lectureId));
      const qIds = lectureQuestions.map((q) => q.id);

      if (qIds.length > 0) {
        await tx.delete(bookmarks).where(inArray(bookmarks.questionId, qIds));
        await tx
          .delete(questionAttempts)
          .where(inArray(questionAttempts.questionId, qIds));
      }

      await tx
        .delete(questionAttempts)
        .where(eq(questionAttempts.lectureId, lectureId));
      await tx.delete(examSessions).where(eq(examSessions.lectureId, lectureId));
      await tx.delete(questions).where(eq(questions.lectureId, lectureId));
      await tx.delete(questionBanks).where(eq(questionBanks.lectureId, lectureId));
      await tx.delete(lectures).where(eq(lectures.id, lectureId));

      return { title: lectTitle, qCount: qIds.length };
    });

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'DELETE_LECTURE',
      'lecture',
      lectureId,
      `Permanently deleted lecture "${title}" and all its quizzes and ${qCount} question(s).`
    );

    invalidateCatalogCache();
    return {
      action: 'deleted',
      message: `Lecture "${title}" and all associated quizzes and questions were permanently deleted.`,
    };
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error deleting lecture:', error);
    throw new Error('Failed to delete lecture.', { cause: error });
  }
}

/**
 * Permanently deletes a Question Bank (Quiz) and its associated questions atomically.
 */
export async function deleteQuestionBankAdmin(
  admin: { uid: string; email: string },
  bankId: number
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    const { title, qCount } = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(questionBanks)
        .where(eq(questionBanks.id, bankId));
      const bank = existing[0];
      const bankTitle = bank?.title || `Quiz Bank #${bankId}`;

      const bankQuestions = await tx
        .select({ id: questions.id })
        .from(questions)
        .where(eq(questions.questionBankId, bankId));
      const qIds = bankQuestions.map((q) => q.id);

      if (qIds.length > 0) {
        await tx.delete(bookmarks).where(inArray(bookmarks.questionId, qIds));
        await tx
          .delete(questionAttempts)
          .where(inArray(questionAttempts.questionId, qIds));
        await tx.delete(questions).where(inArray(questions.id, qIds));
      }

      await tx.delete(questionBanks).where(eq(questionBanks.id, bankId));
      return { title: bankTitle, qCount: qIds.length };
    });

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'DELETE_QUIZ_BANK',
      'question_bank',
      bankId,
      `Permanently deleted quiz bank "${title}" and ${qCount} question(s).`
    );

    return {
      action: 'deleted',
      message: `Quiz "${title}" and its questions were permanently deleted.`,
    };
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error deleting quiz bank:', error);
    throw new Error('Failed to delete quiz bank.', { cause: error });
  }
}

/**
 * Permanently deletes a Question and any bookmarks/attempts referencing it atomically.
 */
export async function deleteOrArchiveQuestionAdmin(
  admin: { uid: string; email: string },
  questionId: number
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    await db.transaction(async (tx) => {
      await tx.delete(bookmarks).where(eq(bookmarks.questionId, questionId));
      await tx
        .delete(questionAttempts)
        .where(eq(questionAttempts.questionId, questionId));
      await tx.delete(questions).where(eq(questions.id, questionId));
    });

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'DELETE_QUESTION',
      'question',
      questionId,
      `Permanently deleted question #${questionId}`
    );
    return {
      action: 'deleted',
      message: `Question #${questionId} was permanently deleted.`,
    };
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error deleting question:', error);
    throw new Error('Failed to delete question.', { cause: error });
  }
}

/**
 * Permanently deletes a Student Exam / Quiz Session and its attempts atomically.
 */
export async function deleteExamSessionAdmin(
  admin: { uid: string; email: string },
  sessionId: number
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    await db.transaction(async (tx) => {
      await tx
        .delete(questionAttempts)
        .where(eq(questionAttempts.sessionId, sessionId));
      await tx.delete(examSessions).where(eq(examSessions.id, sessionId));
    });

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'DELETE_EXAM_SESSION',
      'exam_session',
      sessionId,
      `Permanently deleted student quiz session #${sessionId}`
    );

    return {
      action: 'deleted',
      message: `Quiz session #${sessionId} was permanently deleted.`,
    };
  } catch (error) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error deleting exam session:', error);
    throw new Error('Failed to delete quiz session.', { cause: error });
  }
}

/**
 * Changes a user's role between 'student' and 'admin' (one user at a time).
 * Requires an existing database-verified administrator and prevents demoting the
 * verified primary owner account or the sole remaining administrator.
 */
export async function updateUserRoleAdmin(
  admin: { uid: string; email: string },
  targetUid: string,
  newRole: 'student' | 'admin'
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    if (newRole !== 'student' && newRole !== 'admin') {
      throw new ClientSafeError('Invalid role specified.', 400);
    }

    const { targetUser, updated } = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(users)
        .where(eq(users.uid, targetUid))
        .for('update');
      const found = existing[0];
      if (!found || found.deletedAt !== null || found.accountStatus !== 'active') {
        throw new ClientSafeError('User account not found or inactive.', 404);
      }

      const isVerifiedOwner =
        isOwnerAdminEmail(found.email) &&
        found.authProvider !== 'local' &&
        Boolean(found.emailVerified);

      if (isVerifiedOwner && newRole !== 'admin') {
        throw new ClientSafeError(
          'The primary owner administrator account cannot be changed to student.',
          403
        );
      }

      if (found.role === 'admin' && newRole !== 'admin') {
        const activeAdmins = await tx
          .select({ uid: users.uid })
          .from(users)
          .where(
            and(
              eq(users.role, 'admin'),
              eq(users.accountStatus, 'active'),
              isNull(users.deletedAt)
            )
          );
        if (activeAdmins.length <= 1) {
          throw new ClientSafeError(
            'Cannot demote the last remaining active administrator account.',
            409
          );
        }
      }

      const now = new Date();
      const [updatedRow] = await tx
        .update(users)
        .set({
          role: newRole,
          tokenVersion: sql`${users.tokenVersion} + 1`,
          sessionsRevokedAt: now,
          updatedAt: now,
        })
        .where(eq(users.uid, targetUid))
        .returning();

      return { targetUser: found, updated: updatedRow };
    });

    if (targetUser.role !== newRole) {
      recordUserSessionRevocation(targetUid);
      if (targetUser.firebaseUid) {
        recordUserSessionRevocation(targetUser.firebaseUid);
      }
      const targetFirebaseUid = resolveUserFirebaseUid(targetUser);
      if (targetFirebaseUid) {
        try {
          await adminAuth.revokeRefreshTokens(targetFirebaseUid);
        } catch {
          // Database sessionsRevokedAt is authoritative
        }
      }
    }

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'UPDATE_USER_ROLE',
      'user',
      targetUser.email,
      `Changed role of "${targetUser.displayName}" (${targetUser.email}) to ${newRole.toUpperCase()}`
    );

    return {
      user: sanitizeUserForClient(updated),
      message: `${targetUser.displayName} (${targetUser.email}) is now set to ${
        newRole === 'admin' ? 'Administrator' : 'Student'
      }.`,
    };
  } catch (error: any) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error updating user role:', error);
    throw new Error('Failed to update user role.', { cause: error });
  }
}

/**
 * Deletes a single user account and their individual records atomically, recording a tombstone
 * so any active tokens for the deleted user are immediately rejected.
 * The primary owner account (zeyadzedan098@gmail.com) cannot be deleted.
 */
export async function deleteUserAdmin(
  admin: { uid: string; email: string },
  targetUid: string
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.uid, targetUid));
    const targetUser = existing[0];
    if (!targetUser) {
      throw new ClientSafeError('User account not found.', 404);
    }

    const isVerifiedOwner =
      isOwnerAdminEmail(targetUser.email) &&
      targetUser.authProvider !== 'local' &&
      Boolean(targetUser.emailVerified);

    if (isVerifiedOwner) {
      throw new ClientSafeError(
        'The primary owner administrator account cannot be deleted.',
        403
      );
    }

    await deleteUserAccount(targetUid);

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'DELETE_USER',
      'user',
      targetUser.email,
      `Permanently deleted user account "${targetUser.displayName}" (${targetUser.email})`
    );

    return {
      action: 'deleted',
      message: `User account "${targetUser.displayName}" (${targetUser.email}) was permanently deleted.`,
    };
  } catch (error: any) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error deleting user:', error);
    throw new Error('Failed to delete user account.', { cause: error });
  }
}

/**
 * Resets a student's progress and quiz history for a specific lecture.
 * Deletes all exam/study sessions attached to the lecture and all associated question attempts.
 */
export async function resetLectureProgress(
  targetUserUid: string,
  lectureId: number,
  adminActor?: { uid: string; email: string }
) {
  try {
    await ensureSeededDatabase();

    const targetLect = await db
      .select()
      .from(lectures)
      .where(eq(lectures.id, lectureId));

    if (targetLect.length === 0) {
      throw new ClientSafeError('Lecture not found.', 404);
    }
    const lectureTitle = targetLect[0].title;

    // 1. Find all sessions for this user tied specifically to this lecture
    const userLectSessions = await db
      .select()
      .from(examSessions)
      .where(
        and(
          eq(examSessions.userUid, targetUserUid),
          eq(examSessions.lectureId, lectureId)
        )
      );

    const sessionIds = userLectSessions.map((s) => s.id);

    // 2. Find all questions belonging to this lecture
    const lectureQuestions = await db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.lectureId, lectureId));

    const qIds = lectureQuestions.map((q) => q.id);

    await db.transaction(async (tx) => {
      // Delete question attempts linked to these sessions or matching questions for this lecture
      if (sessionIds.length > 0) {
        await tx
          .delete(questionAttempts)
          .where(
            and(
              eq(questionAttempts.userUid, targetUserUid),
              inArray(questionAttempts.sessionId, sessionIds)
            )
          );
      }

      if (qIds.length > 0) {
        await tx
          .delete(questionAttempts)
          .where(
            and(
              eq(questionAttempts.userUid, targetUserUid),
              inArray(questionAttempts.questionId, qIds)
            )
          );
      }

      // Also clean up by direct lectureId column on questionAttempts
      await tx
        .delete(questionAttempts)
        .where(
          and(
            eq(questionAttempts.userUid, targetUserUid),
            eq(questionAttempts.lectureId, lectureId)
          )
        );

      // Delete the lecture's exam/study sessions for this user
      if (sessionIds.length > 0) {
        await tx
          .delete(examSessions)
          .where(
            and(
              eq(examSessions.userUid, targetUserUid),
              inArray(examSessions.id, sessionIds)
            )
          );
      }
    });

    if (adminActor) {
      await logAdminAction(
        adminActor.uid,
        adminActor.email,
        'RESET_LECTURE_PROGRESS',
        'lecture',
        lectureId,
        `Reset progress for lecture "${lectureTitle}" (ID: ${lectureId}) for user ${targetUserUid}`
      );
    }

    return {
      success: true,
      message: `Progress for lecture "${lectureTitle}" has been completely reset.`,
      lectureId,
      lectureTitle,
    };
  } catch (error: any) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error resetting lecture progress:', error);
    throw new Error('Failed to reset lecture progress.', { cause: error });
  }
}

/**
 * Bulk CSV Question Validation & Transactional Import
 */
export async function previewCsvImportAdmin(csvContent: string, targetLectureId?: number) {
  try {
    await ensureSeededDatabase();

    let targetContext: { defaultSubject?: string; defaultLecture?: string } | undefined;
    if (targetLectureId) {
      const lectRows = await db
        .select()
        .from(lectures)
        .where(eq(lectures.id, targetLectureId));
      if (lectRows.length > 0) {
        const lect = lectRows[0];
        const subjRows = await db
          .select()
          .from(subjects)
          .where(eq(subjects.id, lect.subjectId));
        const subj = subjRows[0];
        targetContext = {
          defaultLecture: lect.title,
          defaultSubject: subj?.title || 'Selected Module',
        };
      }
    }

    const existingQuestions = await db.select().from(questions);
    const existingHashes = new Set(
      existingQuestions.map((q) => q.contentHash).filter(Boolean)
    );

    const report = parseAndValidateCsvQuestions(csvContent, existingHashes, targetContext);
    const pastBatches = await db
      .select()
      .from(importBatches)
      .where(eq(importBatches.fileHash, report.fileHash));

    return {
      ...report,
      targetLectureContext: targetContext || null,
      alreadyImportedBatch: pastBatches[0] || null,
    };
  } catch (error) {
    console.error('Error previewing CSV import:', error);
    throw new Error('Failed to validate CSV file.', { cause: error });
  }
}

export async function executeCsvImportAdmin(
  admin: { uid: string; email: string },
  fileName: string,
  csvContent: string,
  targetLectureId?: number
) {
  try {
    const verifiedAdmin = await assertActiveAdminInDb(admin.uid);
    await ensureSeededDatabase();

    let targetContext: { defaultSubject?: string; defaultLecture?: string } | undefined;
    let targetLectureObj: typeof lectures.$inferSelect | null = null;

    if (targetLectureId) {
      const lectRows = await db
        .select()
        .from(lectures)
        .where(eq(lectures.id, targetLectureId));
      if (lectRows.length > 0) {
        targetLectureObj = lectRows[0];
        const subjRows = await db
          .select()
          .from(subjects)
          .where(eq(subjects.id, targetLectureObj.subjectId));
        const subj = subjRows[0];
        targetContext = {
          defaultLecture: targetLectureObj.title,
          defaultSubject: subj?.title || 'Selected Module',
        };
      }
    }

    const existingQuestions = await db.select().from(questions);
    const existingHashes = new Set(
      existingQuestions.map((q) => q.contentHash).filter(Boolean)
    );

    const report = parseAndValidateCsvQuestions(csvContent, existingHashes, targetContext);
    if (report.headerErrors.length > 0) {
      throw new ClientSafeError(report.headerErrors.join(' '), 400);
    }

    const existingBatch = await db
      .select()
      .from(importBatches)
      .where(eq(importBatches.fileHash, report.fileHash));

    if (existingBatch.length > 0 && report.validCount === 0) {
      throw new ClientSafeError(
        `Duplicate file submission prevented: "${fileName}" was already imported on ${new Date(
          existingBatch[0].createdAt
        ).toLocaleString()}.`,
        409
      );
    }

    const validRows = report.rows.filter((r) => r.isValid);
    const skippedCount = report.duplicateCount;
    const failedCount = report.invalidCount;

    const resultData = await db.transaction(async (tx) => {
      const allSubjects = await tx.select().from(subjects);
      const allLectures = await tx.select().from(lectures);

      const subjectByTitle = new Map(
        allSubjects.map((s) => [s.title.toLowerCase().trim(), s])
      );
      const lectureByKey = new Map(
        allLectures.map((l) => [`${l.subjectId}:${l.title.toLowerCase().trim()}`, l])
      );

      const affectedLectureIds = new Set<number>();
      const newlyCreatedLectureIds = new Set<number>();

      let importedCount = 0;

      for (const row of validRows) {
        let destSubjectId: number;
        let destLectureId: number;

        if (targetLectureObj) {
          destSubjectId = targetLectureObj.subjectId;
          destLectureId = targetLectureObj.id;
        } else {
          const subjKey = row.subject.toLowerCase().trim();
          let subj = subjectByTitle.get(subjKey);
          if (!subj) {
            const slug = `${subjKey.replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}-${importedCount}`;
            const [newSubj] = await tx
              .insert(subjects)
              .values({
                slug,
                title: row.subject.trim(),
                description: `Imported subject: ${row.subject.trim()}`,
                displayOrder: subjectByTitle.size + 1,
                status: 'published',
              })
              .returning();
            subj = newSubj;
            subjectByTitle.set(subjKey, subj);
          }

          const lectKey = `${subj.id}:${row.lecture.toLowerCase().trim()}`;
          let lect = lectureByKey.get(lectKey);
          if (!lect) {
            const [newLect] = await tx
              .insert(lectures)
              .values({
                subjectId: subj.id,
                title: row.lecture.trim(),
                description: `Imported lecture for ${subj.title}`,
                lectureNumber: 1,
                status: 'published',
              })
              .returning();
            lect = newLect;
            lectureByKey.set(lectKey, lect);
            newlyCreatedLectureIds.add(newLect.id);
          }
          destSubjectId = subj.id;
          destLectureId = lect.id;
        }

        affectedLectureIds.add(destLectureId);

        await tx.insert(questions).values({
          subjectId: destSubjectId,
          lectureId: destLectureId,
          questionText: row.questionText,
          optionA: row.optionA,
          optionB: row.optionB,
          optionC: row.optionC,
          optionD: row.optionD,
          correctAnswer: row.correctAnswer,
          explanation: row.explanation,
          explanationA: row.explanationA,
          explanationB: row.explanationB,
          explanationC: row.explanationC,
          explanationD: row.explanationD,
          difficulty: row.difficulty,
          tags: row.tags,
          specialTags: row.specialTags || '',
          pageNumber: row.pageNumber ?? null,
          status: row.status,
          version: 1,
          contentHash: row.contentHash,
        });
        importedCount += 1;
      }

      const [insertedBatch] = await tx
        .insert(importBatches)
        .values({
          adminUid: verifiedAdmin.uid,
          fileName: fileName || 'questions_import.csv',
          fileHash: report.fileHash,
          totalRows: report.totalRows,
          importedCount,
          skippedCount,
          failedCount,
          summaryJson: JSON.stringify({
            importedCount,
            skippedCount,
            failedCount,
          }),
        })
        .returning();

      let affectedLectures: Array<{
        id: number;
        subjectId: number;
        title: string;
        description: string;
        lectureNumber: number;
        pdfUrl: string | null;
        status: string;
        subjectTitle?: string | null;
        isNew: boolean;
      }> = [];

      if (affectedLectureIds.size > 0) {
        const rows = await tx
          .select({
            id: lectures.id,
            subjectId: lectures.subjectId,
            title: lectures.title,
            description: lectures.description,
            lectureNumber: lectures.lectureNumber,
            pdfUrl: lectures.pdfUrl,
            status: lectures.status,
            subjectTitle: subjects.title,
          })
          .from(lectures)
          .leftJoin(subjects, eq(lectures.subjectId, subjects.id))
          .where(inArray(lectures.id, Array.from(affectedLectureIds)));

        affectedLectures = rows.map((r) => ({
          ...r,
          isNew: newlyCreatedLectureIds.has(r.id),
        }));
      }

      return {
        batch: insertedBatch,
        affectedLectures,
      };
    });

    await logAdminAction(
      verifiedAdmin.uid,
      verifiedAdmin.email,
      'BULK_CSV_IMPORT',
      'import_batch',
      resultData.batch.id,
      `Imported ${resultData.batch.importedCount} questions from "${fileName}" (${skippedCount} duplicates skipped, ${failedCount} invalid rows rejected)`
    );

    invalidateCatalogCache();

    return {
      batch: resultData.batch,
      report,
      affectedLectures: resultData.affectedLectures,
    };
  } catch (error: any) {
    if (error instanceof ClientSafeError) throw error;
    console.error('Error executing CSV import:', error);
    throw new Error('Failed to complete bulk CSV import.', { cause: error });
  }
}

export async function exportQuestionBankCsvAdmin(): Promise<string> {
  try {
    const allSubjects = await db.select().from(subjects);
    const allLectures = await db.select().from(lectures);
    const allQuestions = await db
      .select()
      .from(questions)
      .orderBy(asc(questions.subjectId), asc(questions.lectureId), asc(questions.id));

    const sMap = new Map(allSubjects.map((s) => [s.id, s.title]));
    const lMap = new Map(allLectures.map((l) => [l.id, l.title]));

    const escapeCsv = (val: string) => `"${(val || '').replace(/"/g, '""')}"`;

    const headers = [
      'subject',
      'lecture',
      'question_text',
      'option_a',
      'option_b',
      'option_c',
      'option_d',
      'correct_answer',
      'explanation',
      'explanation_a',
      'explanation_b',
      'explanation_c',
      'explanation_d',
      'difficulty',
      'tags',
      'special_tags',
      'page_number',
      'status',
    ].join(',');

    const lines = allQuestions.map((q) =>
      [
        escapeCsv(sMap.get(q.subjectId) || ''),
        escapeCsv(lMap.get(q.lectureId) || ''),
        escapeCsv(q.questionText),
        escapeCsv(q.optionA),
        escapeCsv(q.optionB),
        escapeCsv(q.optionC),
        escapeCsv(q.optionD),
        escapeCsv(q.correctAnswer),
        escapeCsv(q.explanation),
        escapeCsv(q.explanationA),
        escapeCsv(q.explanationB),
        escapeCsv(q.explanationC),
        escapeCsv(q.explanationD),
        escapeCsv(q.difficulty),
        escapeCsv(q.tags),
        escapeCsv(q.specialTags || ''),
        escapeCsv(q.pageNumber ? String(q.pageNumber) : ''),
        escapeCsv(q.status),
      ].join(',')
    );

    return [headers, ...lines].join('\n');
  } catch (error) {
    console.error('Error exporting question bank CSV:', error);
    throw new Error('Failed to export question bank CSV.', { cause: error });
  }
}
