import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import {
  requireAuth,
  type AuthRequest,
  verifyPassword,
  validatePasswordBounds,
  createServerSessionToken,
  verifyServerSessionToken,
  validateAuthConfiguration,
} from './src/middleware/auth.ts';
import {
  createBoundedRateLimiter,
  createPostgresRateLimitStore,
  resolveRateLimitStoreConfig,
  normalizeClientIp,
  resolveTrustProxyConfig,
} from './src/middleware/rate-limit.ts';
import {
  ClientSafeError,
  sanitizeUserForClient,
  getAuthenticatedUserByUid,
  getOrCreateUser,
  registerEmailPasswordUser,
  findUserByEmail,
  authenticateEmailUser,
  requestPasswordRecoveryToken,
  confirmPasswordRecoveryToken,
  changeAuthenticatedUserPassword,
  linkPasswordToAuthenticatedAccount,
  revokeUserSessions,
  updateUserProfile,
  deleteUserAccount,
  getPublishedCatalog,
  createPracticeOrExamSession,
  getExamSessionForStudent,
  saveSessionQuestionAnswer,
  syncSessionProgress,
  completeExamSession,
  toggleBookmarkForStudent,
  getStudentBookmarksAndReview,
  getStudentDashboardAnalytics,
  getAdminDashboardData,
  upsertModuleAdmin,
  deleteModuleAdmin,
  upsertSubjectAdmin,
  upsertLectureAdmin,
  upsertQuestionAdmin,
  deleteSubjectAdmin,
  deleteLectureAdmin,
  deleteQuestionBankAdmin,
  deleteOrArchiveQuestionAdmin,
  deleteExamSessionAdmin,
  updateUserRoleAdmin,
  deleteUserAdmin,
  resetLectureProgress,
  previewCsvImportAdmin,
  executeCsvImportAdmin,
  exportQuestionBankCsvAdmin,
  saveUploadedPdfFileAdmin,
  getUploadedPdfByUrl,
  attachPdfToLectureAdmin,
} from './src/db/repository.ts';
import { getSampleCsvTemplate } from './src/lib/mcq-engine.ts';
import { executeScheduledBackup } from './src/lib/backup-service.ts';
import { isR2Configured, getR2PublicUrl, uploadToR2 } from './src/lib/r2-storage.ts';
import { uploadPdfToFirebaseStorage, isFirebaseStorageConfigured } from './src/lib/firebase-storage.ts';

// Validate AUTH_SESSION_SECRET at module load / startup (fails fast if missing or weak)
validateAuthConfiguration();

export const app = express();
app.set('trust proxy', resolveTrustProxyConfig());
app.disable('x-powered-by');

// Security headers middleware
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});

// Serve public static assets (including lecture PDFs)
app.use(express.static(path.resolve(process.cwd(), 'public')));

// Fallback dynamic resolver for uploaded lecture PDFs: serves from disk, redirects to Cloudflare R2, or restores from PostgreSQL database
app.get('/lectures/:filename', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const safeFilename = path.basename(req.params.filename);

    // 1. If Cloudflare R2 is configured with a public URL, redirect directly to Cloudflare CDN (zero egress fees!)
    const r2DirectUrl = getR2PublicUrl(safeFilename);
    if (r2DirectUrl) {
      return res.redirect(302, r2DirectUrl);
    }

    const lecturesDir = path.resolve(process.cwd(), 'public', 'lectures');
    const filePath = path.resolve(lecturesDir, safeFilename);

    // Defensive path-containment validation against directory traversal
    if (!filePath.startsWith(lecturesDir)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }

    // If missing from local disk, fetch directly from PostgreSQL database `lecture_files` table
    const relativeUrl = `/lectures/${safeFilename}`;
    const fileRecord = await getUploadedPdfByUrl(relativeUrl);
    if (fileRecord && fileRecord.dataBase64) {
      const buf = Buffer.from(fileRecord.dataBase64, 'base64');
      try {
        const lecturesDir = path.resolve(process.cwd(), 'public', 'lectures');
        if (!fs.existsSync(lecturesDir)) {
          fs.mkdirSync(lecturesDir, { recursive: true });
        }
        fs.writeFileSync(filePath, buf);
      } catch {
        // Disk write failure is non-fatal; we still serve from DB
      }
      res.setHeader('Content-Type', fileRecord.mimeType || 'application/pdf');
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    }
    return next();
  } catch (err) {
    return next(err);
  }
});

// Tight default JSON body parser (64kb) for all API and auth endpoints;
// 5mb parser is scoped exclusively to authenticated admin CSV import endpoints;
// 50mb parser is scoped exclusively to authenticated admin PDF slide deck uploads.
const defaultJsonParser = express.json({ limit: '64kb' });
const adminCsvImportJsonParser = express.json({ limit: '5mb' });
const adminPdfUploadJsonParser = express.json({ limit: '50mb' });
app.use((req: Request, res: Response, next: NextFunction) => {
  if (
    req.path.startsWith('/api/admin/import/preview') ||
    req.path.startsWith('/api/admin/import/execute')
  ) {
    return adminCsvImportJsonParser(req, res, next);
  }
  if (req.path.startsWith('/api/admin/upload-pdf')) {
    return adminPdfUploadJsonParser(req, res, next);
  }
  return defaultJsonParser(req, res, next);
});

const rateLimitResolution = resolveRateLimitStoreConfig(process.env);
const sharedRateLimitStore = rateLimitResolution.store;
const rateLimitDegradedPolicy = rateLimitResolution.degradedModePolicy;

function extractNormalizedRateLimitEmail(req: Request): string | null {
  const raw = req.body?.email;
  if (typeof raw !== 'string') return null;
  const normalized = raw.toLowerCase().trim().slice(0, 120);
  return normalized.length > 0 ? normalized : null;
}

// Bounded, shared-store rate limiters with independent per-IP, per-email, and combined limits
const registerLimiter = createBoundedRateLimiter({
  scope: 'auth-register',
  maxRequests: 15,
  windowMs: 60_000,
  maxKeys: 5_000,
  store: sharedRateLimitStore,
  degradedModePolicy: rateLimitDegradedPolicy,
  secondaryRules: [
    {
      scopeSuffix: 'email',
      maxRequests: 6,
      keyGenerator: (req) => extractNormalizedRateLimitEmail(req),
    },
  ],
});

const loginLimiter = createBoundedRateLimiter({
  scope: 'auth-login',
  maxRequests: 15,
  windowMs: 60_000,
  maxKeys: 5_000,
  store: sharedRateLimitStore,
  degradedModePolicy: rateLimitDegradedPolicy,
  keyGenerator: (req) => {
    const email = extractNormalizedRateLimitEmail(req) || '';
    return `${normalizeClientIp(req)}:${email}`;
  },
  secondaryRules: [
    {
      scopeSuffix: 'ip',
      maxRequests: 25,
      keyGenerator: (req) => normalizeClientIp(req),
    },
    {
      scopeSuffix: 'email',
      maxRequests: 12,
      keyGenerator: (req) => extractNormalizedRateLimitEmail(req),
    },
  ],
});

const forgotPasswordLimiter = createBoundedRateLimiter({
  scope: 'auth-forgot-password',
  maxRequests: 6,
  windowMs: 60_000,
  maxKeys: 5_000,
  store: sharedRateLimitStore,
  degradedModePolicy: rateLimitDegradedPolicy,
  keyGenerator: (req) => {
    const email = extractNormalizedRateLimitEmail(req) || '';
    return `${normalizeClientIp(req)}:${email}`;
  },
  secondaryRules: [
    {
      scopeSuffix: 'ip',
      maxRequests: 10,
      keyGenerator: (req) => normalizeClientIp(req),
    },
    {
      scopeSuffix: 'email',
      maxRequests: 5,
      keyGenerator: (req) => extractNormalizedRateLimitEmail(req),
    },
  ],
});

const resetPasswordLimiter = createBoundedRateLimiter({
  scope: 'auth-reset-password',
  maxRequests: 10,
  windowMs: 60_000,
  maxKeys: 5_000,
  store: sharedRateLimitStore,
  degradedModePolicy: rateLimitDegradedPolicy,
});

const passwordMutationLimiter = createBoundedRateLimiter({
  scope: 'auth-password-mutation',
  maxRequests: 10,
  windowMs: 60_000,
  maxKeys: 5_000,
  store: sharedRateLimitStore,
  degradedModePolicy: rateLimitDegradedPolicy,
  secondaryRules: [
    {
      scopeSuffix: 'uid',
      maxRequests: 8,
      keyGenerator: (req) => (req as AuthRequest).user?.uid || null,
    },
  ],
});

function sendErrorResponse(
  res: Response,
  error: unknown,
  fallbackMessage: string,
  defaultStatus = 500
) {
  if (error instanceof ClientSafeError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  return res.status(defaultStatus).json({ error: fallbackMessage });
}

// Middleware to verify database-backed Administrator role without creating unverified admins
const requireAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    const dbUser =
      req.user.authType === 'firebase'
        ? await getOrCreateUser(req.user.uid, req.user.email, req.user.name, {
            authType: 'firebase',
            emailVerified: req.user.emailVerified,
            allowCreate: true,
          })
        : await getAuthenticatedUserByUid(req.user.uid);

    if (
      !dbUser ||
      dbUser.deletedAt !== null ||
      dbUser.accountStatus !== 'active' ||
      dbUser.role !== 'admin'
    ) {
      return res
        .status(403)
        .json({ error: 'Forbidden: Administrator privileges are required.' });
    }
    return next();
  } catch (error) {
    console.error('Admin verification failed:', error);
    return sendErrorResponse(
      res,
      error,
      'Failed to verify administrator permissions.',
      500
    );
  }
};

// ============================================================================
// PUBLIC CATALOG API
// ============================================================================
app.get('/api/catalog', async (_req, res) => {
  try {
    const catalog = await getPublishedCatalog();
    return res.json(catalog);
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to load catalog.', 500);
  }
});

// ============================================================================
// AUTHENTICATION & ACCOUNT API
// ============================================================================
app.post('/api/auth/register', registerLimiter, async (req, res) => {
  try {
    const { email, password, displayName } = req.body || {};
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }
    if (typeof password !== 'string') {
      return res
        .status(400)
        .json({ error: 'Password must be at least 8 characters long.' });
    }
    const bounds = validatePasswordBounds(password, { requireMinLength: true });
    if (!bounds.valid) {
      return res.status(400).json({ error: bounds.error });
    }
    if (!displayName || typeof displayName !== 'string' || displayName.trim().length < 2) {
      return res.status(400).json({
        error: 'Please enter your full name or display name (at least 2 characters).',
      });
    }

    // Any client-supplied role or emailVerified flags in req.body are ignored.
    const user = await registerEmailPasswordUser(email, password, displayName);
    const token = createServerSessionToken({
      uid: user.uid,
      email: user.email,
      name: user.displayName,
      tokenVersion: user.tokenVersion,
      emailVerified: Boolean(user.emailVerified),
    });

    return res.status(201).json({
      token,
      user: sanitizeUserForClient(user),
    });
  } catch (error) {
    return sendErrorResponse(res, error, 'Registration failed.', 400);
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (
      !email ||
      typeof email !== 'string' ||
      !password ||
      typeof password !== 'string'
    ) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const bounds = validatePasswordBounds(password, { requireMinLength: false });
    if (!bounds.valid) {
      return res.status(400).json({ error: bounds.error });
    }

    const user = await authenticateEmailUser(email, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email address or password.' });
    }

    const token = createServerSessionToken({
      uid: user.uid,
      email: user.email,
      name: user.displayName,
      tokenVersion: user.tokenVersion,
      emailVerified: Boolean(user.emailVerified),
    });

    return res.json({
      token,
      user: sanitizeUserForClient(user),
    });
  } catch (error) {
    return sendErrorResponse(res, error, 'Login failed.', 500);
  }
});

/**
 * Step 1 of Password Recovery: Request an account-aware password reset email / token.
 */
app.post('/api/auth/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    const { email, origin } = req.body || {};
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res
        .status(400)
        .json({ error: 'Please enter a valid account email address.' });
    }
    const candidateOrigin =
      typeof origin === 'string' && origin.trim().length > 0
        ? origin.trim()
        : undefined;
    const result = await requestPasswordRecoveryToken(email, {
      origin: candidateOrigin,
    });
    return res.json({
      accepted: result.accepted,
      message: result.message,
      expiresInMinutes: result.expiresInMinutes,
    });
  } catch (error) {
    return sendErrorResponse(
      res,
      error,
      'Failed to initiate password recovery.',
      400
    );
  }
});

/**
 * Step 2 of Password Recovery: Complete password reset using a verified single-use recovery token
 * or a Firebase Authentication password-reset oobCode / pasted reset URL.
 * Unauthenticated reset by { email, newPassword } alone is strictly rejected.
 */
app.post('/api/auth/reset-password', resetPasswordLimiter, async (req, res) => {
  try {
    const { token, oobCode, newPassword } = req.body || {};
    const recoverySecret =
      typeof token === 'string' && token.trim().length > 0
        ? token.trim()
        : typeof oobCode === 'string' && oobCode.trim().length > 0
        ? oobCode.trim()
        : '';

    if (!recoverySecret || recoverySecret.length < 10) {
      return res.status(400).json({
        error:
          'A valid single-use password recovery token or Firebase reset code is required to reset a password.',
      });
    }
    if (typeof newPassword !== 'string') {
      return res
        .status(400)
        .json({ error: 'New password must be at least 8 characters long.' });
    }
    const bounds = validatePasswordBounds(newPassword, { requireMinLength: true });
    if (!bounds.valid) {
      return res.status(400).json({ error: bounds.error });
    }

    await confirmPasswordRecoveryToken(recoverySecret, newPassword);
    return res.json({
      message:
        'Your password has been updated and prior sessions have been revoked. You may now sign in with your new password.',
    });
  } catch (error) {
    return sendErrorResponse(res, error, 'Password recovery failed.', 400);
  }
});

/**
 * Authenticated password change (requires currentPassword).
 */
app.post(
  '/api/auth/change-password',
  requireAuth,
  passwordMutationLimiter,
  async (req: AuthRequest, res) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        return res
          .status(400)
          .json({ error: 'Current password and new password are required.' });
      }
      const currentBounds = validatePasswordBounds(currentPassword, {
        requireMinLength: false,
      });
      if (!currentBounds.valid) {
        return res.status(400).json({ error: currentBounds.error });
      }
      const newBounds = validatePasswordBounds(newPassword, {
        requireMinLength: true,
      });
      if (!newBounds.valid) {
        return res.status(400).json({ error: newBounds.error });
      }
      const updated = await changeAuthenticatedUserPassword(
        req.user!.uid,
        currentPassword,
        newPassword
      );
      const token = createServerSessionToken({
        uid: updated.uid,
        email: updated.email,
        name: updated.displayName,
        tokenVersion: updated.tokenVersion,
        emailVerified: Boolean(updated.emailVerified),
      });
      return res.json({
        message: 'Your password has been updated.',
        token,
        user: sanitizeUserForClient(updated),
      });
    } catch (error) {
      return sendErrorResponse(res, error, 'Failed to change password.', 400);
    }
  }
);

/**
 * Authenticated password linking for accounts created via verified OAuth/Firebase provider.
 */
app.post(
  '/api/auth/link-password',
  requireAuth,
  passwordMutationLimiter,
  async (req: AuthRequest, res) => {
    try {
      const { newPassword } = req.body || {};
      if (typeof newPassword !== 'string') {
        return res
          .status(400)
          .json({ error: 'New password must be at least 8 characters long.' });
      }
      const newBounds = validatePasswordBounds(newPassword, {
        requireMinLength: true,
      });
      if (!newBounds.valid) {
        return res.status(400).json({ error: newBounds.error });
      }
      const updated = await linkPasswordToAuthenticatedAccount(
        req.user!.uid,
        newPassword
      );
      const token = createServerSessionToken({
        uid: updated.uid,
        email: updated.email,
        name: updated.displayName,
        tokenVersion: updated.tokenVersion,
        emailVerified: Boolean(updated.emailVerified),
      });
      return res.json({
        message: 'Local password has been linked to your account.',
        token,
        user: sanitizeUserForClient(updated),
      });
    } catch (error) {
      return sendErrorResponse(res, error, 'Failed to link password.', 400);
    }
  }
);

app.post('/api/auth/logout', requireAuth, async (req: AuthRequest, res) => {
  try {
    await revokeUserSessions(req.user!.uid);
    return res.json({ loggedOut: true });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to revoke session.', 500);
  }
});

app.get('/api/auth/me', requireAuth, async (req: AuthRequest, res) => {
  try {
    const user = await getOrCreateUser(
      req.user!.uid,
      req.user!.email,
      req.user!.name,
      {
        authType: req.user!.authType,
        emailVerified: req.user!.emailVerified,
        allowCreate: req.user!.authType === 'firebase',
      }
    );
    const token = createServerSessionToken({
      uid: user.uid,
      email: user.email,
      name: user.displayName,
      tokenVersion: user.tokenVersion,
      emailVerified: Boolean(user.emailVerified),
    });
    return res.json({ token, user: sanitizeUserForClient(user) });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to load profile.', 500);
  }
});

app.put('/api/auth/profile', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { displayName, preferences } = req.body || {};
    if (displayName !== undefined && String(displayName).trim().length < 2) {
      return res
        .status(400)
        .json({ error: 'Display name must be at least 2 characters long.' });
    }
    const updated = await updateUserProfile(req.user!.uid, {
      displayName: displayName ? String(displayName) : undefined,
      preferences: typeof preferences === 'object' ? preferences : undefined,
    });
    return res.json({ user: sanitizeUserForClient(updated) });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to update profile.', 500);
  }
});

app.delete('/api/auth/account', requireAuth, async (req: AuthRequest, res) => {
  try {
    const result = await deleteUserAccount(req.user!.uid);
    return res.json(result);
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to delete account.', 500);
  }
});

// ============================================================================
// STUDENT MCQ SESSIONS, BOOKMARKS & DASHBOARD ANALYTICS
// ============================================================================
app.post('/api/sessions', requireAuth, async (req: AuthRequest, res) => {
  try {
    const {
      mode,
      title,
      subjectIds,
      lectureIds,
      difficulties,
      tagFilter,
      requestedCount,
      shuffleQuestions,
      shuffleOptions,
      avoidRecent,
      onlyMistakes,
      timeLimitMinutes,
    } = req.body || {};

    const validMode = mode === 'exam' || mode === 'custom' ? mode : 'study';
    const result = await createPracticeOrExamSession(req.user!.uid, {
      mode: validMode,
      title,
      subjectIds: Array.isArray(subjectIds) ? subjectIds.map(Number) : undefined,
      lectureIds: Array.isArray(lectureIds) ? lectureIds.map(Number) : undefined,
      difficulties: Array.isArray(difficulties) ? difficulties : undefined,
      tagFilter: tagFilter ? String(tagFilter) : undefined,
      requestedCount: requestedCount ? Number(requestedCount) : undefined,
      shuffleQuestions: Boolean(shuffleQuestions),
      shuffleOptions: Boolean(shuffleOptions),
      avoidRecent: Boolean(avoidRecent),
      onlyMistakes: Boolean(onlyMistakes),
      timeLimitMinutes:
        timeLimitMinutes !== undefined && timeLimitMinutes !== null
          ? Number(timeLimitMinutes)
          : undefined,
    });
    return res.status(201).json(result);
  } catch (error) {
    return sendErrorResponse(res, error, 'Could not start session.', 400);
  }
});

app.get('/api/sessions/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const sessionId = Number(req.params.id);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ error: 'Invalid session ID.' });
    }
    const session = await getExamSessionForStudent(req.user!.uid, sessionId);
    return res.json({ session });
  } catch (error) {
    return sendErrorResponse(res, error, 'Session not found.', 404);
  }
});

app.post('/api/sessions/:id/answer', requireAuth, async (req: AuthRequest, res) => {
  try {
    const sessionId = Number(req.params.id);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ error: 'Invalid session ID.' });
    }
    const { questionId, selectedOption, lockAnswer, elapsedSeconds } = req.body || {};
    const session = await saveSessionQuestionAnswer(
      req.user!.uid,
      sessionId,
      Number(questionId),
      selectedOption || null,
      Boolean(lockAnswer),
      typeof elapsedSeconds === 'number' ? elapsedSeconds : undefined
    );
    return res.json({ session });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to record answer.', 400);
  }
});

app.post('/api/sessions/:id/sync', requireAuth, async (req: AuthRequest, res) => {
  try {
    const sessionId = Number(req.params.id);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ error: 'Invalid session ID.' });
    }
    const { elapsedSeconds } = req.body || {};
    await syncSessionProgress(req.user!.uid, sessionId, elapsedSeconds);
    return res.json({ success: true });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to sync progress.', 400);
  }
});

app.post('/api/sessions/:id/complete', requireAuth, async (req: AuthRequest, res) => {
  try {
    const sessionId = Number(req.params.id);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ error: 'Invalid session ID.' });
    }
    const { answers, elapsedSeconds } = req.body || {};
    const session = await completeExamSession(
      req.user!.uid,
      sessionId,
      answers,
      typeof elapsedSeconds === 'number' ? elapsedSeconds : undefined
    );
    return res.json({ session });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to complete session.', 400);
  }
});

app.post('/api/lectures/:id/reset', requireAuth, async (req: AuthRequest, res) => {
  try {
    const lectureId = Number(req.params.id);
    if (!Number.isInteger(lectureId) || lectureId <= 0) {
      return res.status(400).json({ error: 'Invalid lecture ID.' });
    }
    const result = await resetLectureProgress(req.user!.uid, lectureId);
    return res.json(result);
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to reset lecture progress.', 400);
  }
});

app.get('/api/dashboard', requireAuth, async (req: AuthRequest, res) => {
  try {
    const analytics = await getStudentDashboardAnalytics(req.user!.uid);
    return res.json(analytics);
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to load dashboard.', 500);
  }
});

app.get('/api/bookmarks', requireAuth, async (req: AuthRequest, res) => {
  try {
    const data = await getStudentBookmarksAndReview(req.user!.uid);
    return res.json(data);
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to load bookmarks.', 500);
  }
});

app.post('/api/bookmarks/toggle', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { questionId, note } = req.body || {};
    if (!questionId) {
      return res.status(400).json({ error: 'questionId is required.' });
    }
    const result = await toggleBookmarkForStudent(
      req.user!.uid,
      Number(questionId),
      note ? String(note) : undefined
    );
    return res.json(result);
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to toggle bookmark.', 500);
  }
});

// ============================================================================
// PROTECTED ADMINISTRATOR API
// ============================================================================
app.get('/api/admin/overview', requireAuth, requireAdmin, async (_req: AuthRequest, res) => {
  try {
    const data = await getAdminDashboardData();
    return res.json(data);
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to load admin overview.', 500);
  }
});

app.post('/api/admin/modules', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id, code, title, description, displayOrder, status } = req.body || {};
    if (!code || !title) {
      return res.status(400).json({ error: 'Module code and title are required.' });
    }
    const saved = await upsertModuleAdmin(
      { uid: req.user!.uid, email: req.user!.email },
      {
        id: id ? Number(id) : undefined,
        code: String(code),
        title: String(title),
        description: String(description || ''),
        displayOrder: Number(displayOrder) || 1,
        status: status || 'published',
      }
    );
    return res.json({ module: saved });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to save module.', 400);
  }
});

app.delete('/api/admin/modules/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const moduleId = Number(req.params.id);
    if (!moduleId || isNaN(moduleId)) {
      return res.status(400).json({ error: 'Valid moduleId parameter is required.' });
    }
    const deleted = await deleteModuleAdmin(
      { uid: req.user!.uid, email: req.user!.email },
      moduleId
    );
    return res.json({ success: true, deleted });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to delete module.', 400);
  }
});

app.post('/api/admin/subjects', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id, moduleId, title, description, displayOrder, status } = req.body || {};
    if (!title || !description) {
      return res.status(400).json({ error: 'Subject title and description are required.' });
    }
    const saved = await upsertSubjectAdmin(
      { uid: req.user!.uid, email: req.user!.email },
      {
        id: id ? Number(id) : undefined,
        moduleId: moduleId ? Number(moduleId) : null,
        title: String(title),
        description: String(description),
        displayOrder: Number(displayOrder) || 1,
        status: status || 'published',
      }
    );
    return res.json({ subject: saved });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to save subject.', 400);
  }
});

app.post('/api/admin/upload-pdf', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { fileName, fileData, mimeType } = req.body || {};
    if (!fileName || typeof fileName !== 'string' || !fileData || typeof fileData !== 'string') {
      return res.status(400).json({ error: 'fileName and fileData (base64) are required.' });
    }

    // Strip data URI prefix if present (e.g. "data:application/pdf;base64,")
    const base64Clean = fileData.replace(/^data:[^;]+;base64,/, '').trim();
    if (!base64Clean) {
      return res.status(400).json({ error: 'Uploaded file is empty.' });
    }

    const buffer = Buffer.from(base64Clean, 'base64');
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'Uploaded file is empty.' });
    }

    // Validate PDF magic bytes: %PDF- (0x25, 0x50, 0x44, 0x46)
    const isPdf =
      buffer.length >= 4 &&
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46;

    if (!isPdf) {
      return res.status(400).json({
        error: 'Invalid file format. Only valid PDF files are permitted for lecture documents.',
      });
    }

    // Max file size: 50MB
    const MAX_PDF_BYTES = 50 * 1024 * 1024;
    if (buffer.length > MAX_PDF_BYTES) {
      return res.status(400).json({
        error: `File size exceeds the 50MB limit (size: ${(buffer.length / (1024 * 1024)).toFixed(1)}MB).`,
      });
    }

    // Construct a safe, clean file name
    const rawBaseName = path.basename(fileName).replace(/\.pdf$/i, '');
    const safeBase = rawBaseName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'lecture';
    const uniqueFileName = `${Date.now()}-${safeBase}.pdf`;
    const relativeUrl = `/lectures/${uniqueFileName}`;

    // 1. Save to disk in public/lectures/
    const lecturesDir = path.resolve(process.cwd(), 'public', 'lectures');
    if (!fs.existsSync(lecturesDir)) {
      fs.mkdirSync(lecturesDir, { recursive: true });
    }
    const targetFilePath = path.join(lecturesDir, uniqueFileName);
    fs.writeFileSync(targetFilePath, buffer);

    // 2. Save directly to PostgreSQL database `lecture_files` table
    const savedRecord = await saveUploadedPdfFileAdmin(
      { uid: req.user!.uid, email: req.user!.email },
      {
        fileName: uniqueFileName,
        mimeType: mimeType || 'application/pdf',
        fileSize: buffer.length,
        dataBase64: base64Clean,
        url: relativeUrl,
      }
    );

    // 3. Upload to Firebase Storage (Google Cloud CDN, no credit card required, 30GB/mo free egress)
    let firebaseStorageUrl: string | null = null;
    if (isFirebaseStorageConfigured()) {
      try {
        const fbResult = await uploadPdfToFirebaseStorage(uniqueFileName, buffer, mimeType || 'application/pdf');
        firebaseStorageUrl = fbResult.url;
        console.log('✅ Uploaded lecture PDF to Firebase Storage (no card required):', uniqueFileName);
      } catch (fbErr: any) {
        console.warn('[FIREBASE_STORAGE_NOTICE] Firebase Storage upload notice:', fbErr?.message || fbErr);
      }
    }

    // 4. Upload to Cloudflare R2 (zero egress fees) if configured
    let r2StorageUrl: string | null = null;
    if (isR2Configured()) {
      try {
        const r2Result = await uploadToR2({
          fileName: uniqueFileName,
          data: buffer,
          contentType: mimeType || 'application/pdf',
        });
        r2StorageUrl = r2Result.publicUrl;
        console.log('✅ Uploaded lecture PDF to Cloudflare R2 (zero egress fees):', uniqueFileName);
      } catch (r2Err: any) {
        console.warn('[R2_STORAGE_NOTICE] Cloudflare R2 upload notice:', r2Err?.message || r2Err);
      }
    }

    // 5. Upload directly to Supabase Storage bucket 'lecture-pdfs' as fallback
    let supabaseStorageUrl: string | null = null;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
        const { error: storageError } = await supabase.storage
          .from('lecture-pdfs')
          .upload(uniqueFileName, buffer, {
            contentType: mimeType || 'application/pdf',
            upsert: true,
          });
        if (!storageError) {
          const { data: urlData } = supabase.storage.from('lecture-pdfs').getPublicUrl(uniqueFileName);
          supabaseStorageUrl = urlData?.publicUrl || null;
        } else {
          console.warn('Supabase storage upload notice:', storageError.message);
        }
      } catch (err) {
        console.warn('Supabase storage upload error:', err);
      }
    }

    // Determine the optimal public PDF URL: Firebase Storage > Cloudflare R2 > relative URL
    const effectivePdfUrl = firebaseStorageUrl || r2StorageUrl || relativeUrl;

    // If lectureId is provided, automatically attach this uploaded PDF to the lecture
    let attachedLecture = null;
    if (req.body.lectureId) {
      const targetLecId = Number(req.body.lectureId);
      if (!isNaN(targetLecId) && targetLecId > 0) {
        attachedLecture = await attachPdfToLectureAdmin(
          { uid: req.user!.uid, email: req.user!.email },
          targetLecId,
          effectivePdfUrl
        );
      }
    }

    return res.json({
      success: true,
      url: effectivePdfUrl,
      firebaseStorageUrl,
      r2StorageUrl,
      supabaseStorageUrl,
      fileName: uniqueFileName,
      fileSize: buffer.length,
      id: savedRecord.id,
      lecture: attachedLecture,
      message: attachedLecture
        ? `Lecture PDF uploaded and attached to "${attachedLecture.title}" successfully.`
        : 'Lecture PDF uploaded and saved successfully.',
    });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to upload PDF.', 500);
  }
});

app.post('/api/admin/lectures/:id/attach-pdf', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const lectureId = Number(req.params.id);
    if (isNaN(lectureId) || lectureId <= 0) {
      return res.status(400).json({ error: 'Valid lecture ID is required.' });
    }

    let pdfUrlToAttach: string | null = null;
    let uploadDetails: any = null;

    if (req.body.fileData) {
      const { fileName, fileData, mimeType } = req.body;
      if (!fileName || typeof fileName !== 'string' || typeof fileData !== 'string') {
        return res.status(400).json({ error: 'Valid fileName and fileData (base64) are required.' });
      }

      const base64Clean = fileData.replace(/^data:[^;]+;base64,/, '').trim();
      if (!base64Clean) {
        return res.status(400).json({ error: 'Uploaded file is empty.' });
      }

      const buffer = Buffer.from(base64Clean, 'base64');
      if (buffer.length === 0) {
        return res.status(400).json({ error: 'Uploaded file is empty.' });
      }

      const isPdf =
        buffer.length >= 4 &&
        buffer[0] === 0x25 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x44 &&
        buffer[3] === 0x46;

      if (!isPdf) {
        return res.status(400).json({
          error: 'Invalid file format. Only valid PDF files are permitted for lecture documents.',
        });
      }

      const MAX_PDF_BYTES = 50 * 1024 * 1024;
      if (buffer.length > MAX_PDF_BYTES) {
        return res.status(400).json({
          error: `File size exceeds the 50MB limit (size: ${(buffer.length / (1024 * 1024)).toFixed(1)}MB).`,
        });
      }

      const rawBaseName = path.basename(fileName).replace(/\.pdf$/i, '');
      const safeBase = rawBaseName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'lecture';
      const uniqueFileName = `${Date.now()}-${safeBase}.pdf`;
      const relativeUrl = `/lectures/${uniqueFileName}`;

      const lecturesDir = path.resolve(process.cwd(), 'public', 'lectures');
      if (!fs.existsSync(lecturesDir)) {
        fs.mkdirSync(lecturesDir, { recursive: true });
      }
      fs.writeFileSync(path.join(lecturesDir, uniqueFileName), buffer);

      await saveUploadedPdfFileAdmin(
        { uid: req.user!.uid, email: req.user!.email },
        {
          fileName: uniqueFileName,
          mimeType: mimeType || 'application/pdf',
          fileSize: buffer.length,
          dataBase64: base64Clean,
          url: relativeUrl,
        }
      );

      if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
        try {
          const { createClient } = await import('@supabase/supabase-js');
          const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
          await supabase.storage
            .from('lecture-pdfs')
            .upload(uniqueFileName, buffer, {
              contentType: mimeType || 'application/pdf',
              upsert: true,
            });
        } catch (err) {
          console.warn('Supabase storage upload notice:', err);
        }
      }

      pdfUrlToAttach = relativeUrl;
      uploadDetails = {
        fileName: uniqueFileName,
        fileSize: buffer.length,
      };
    } else if (req.body.pdfUrl !== undefined) {
      pdfUrlToAttach =
        req.body.pdfUrl && String(req.body.pdfUrl).trim()
          ? String(req.body.pdfUrl).trim()
          : null;
    } else {
      return res.status(400).json({ error: 'Either fileData or pdfUrl must be provided.' });
    }

    const updated = await attachPdfToLectureAdmin(
      { uid: req.user!.uid, email: req.user!.email },
      lectureId,
      pdfUrlToAttach
    );

    return res.json({
      success: true,
      lecture: updated,
      url: pdfUrlToAttach,
      uploadDetails,
      message: pdfUrlToAttach
        ? `PDF successfully attached to lecture "${updated.title}".`
        : `PDF successfully removed from lecture "${updated.title}".`,
    });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to attach PDF to lecture.', 400);
  }
});

app.post('/api/admin/lectures', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const {
      id,
      subjectId,
      title,
      description,
      lectureNumber,
      educationalNotes,
      estimatedMinutes,
      pdfUrl,
      status,
    } = req.body || {};
    if (!subjectId || !title || !description) {
      return res
        .status(400)
        .json({ error: 'Parent subject, lecture title, and description are required.' });
    }
    const saved = await upsertLectureAdmin(
      { uid: req.user!.uid, email: req.user!.email },
      {
        id: id ? Number(id) : undefined,
        subjectId: Number(subjectId),
        title: String(title),
        description: String(description),
        lectureNumber: Number(lectureNumber) || 1,
        educationalNotes: educationalNotes ? String(educationalNotes) : '',
        estimatedMinutes: Number(estimatedMinutes) || 30,
        pdfUrl: pdfUrl !== undefined && pdfUrl !== null && String(pdfUrl).trim() !== '' ? String(pdfUrl).trim() : null,
        status: status || 'published',
      }
    );
    return res.json({ lecture: saved });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to save lecture.', 400);
  }
});

app.post('/api/admin/questions', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const {
      id,
      subjectId,
      lectureId,
      questionText,
      optionA,
      optionB,
      optionC,
      optionD,
      correctAnswer,
      explanation,
      explanationA,
      explanationB,
      explanationC,
      explanationD,
      diagramSvg,
      pageNumber,
      difficulty,
      tags,
      status,
    } = req.body || {};

    if (
      !subjectId ||
      !lectureId ||
      !questionText ||
      !optionA ||
      !optionB ||
      !optionC ||
      !optionD ||
      !correctAnswer ||
      !explanation
    ) {
      return res.status(400).json({
        error:
          'Subject, lecture, question stem, all 4 options, correct answer (A–D), and explanation are required.',
      });
    }

    let parsedPageNumber: number | null = null;
    if (pageNumber !== undefined && pageNumber !== null && String(pageNumber).trim() !== '') {
      const p = Number(pageNumber);
      if (!Number.isInteger(p) || p <= 0) {
        return res.status(400).json({ error: 'PDF Page Number must be a positive integer.' });
      }
      parsedPageNumber = p;
    }

    const saved = await upsertQuestionAdmin(
      { uid: req.user!.uid, email: req.user!.email },
      {
        id: id ? Number(id) : undefined,
        subjectId: Number(subjectId),
        lectureId: Number(lectureId),
        questionText: String(questionText),
        optionA: String(optionA),
        optionB: String(optionB),
        optionC: String(optionC),
        optionD: String(optionD),
        correctAnswer: String(correctAnswer).toUpperCase() as any,
        explanation: String(explanation),
        explanationA: explanationA ? String(explanationA) : '',
        explanationB: explanationB ? String(explanationB) : '',
        explanationC: explanationC ? String(explanationC) : '',
        explanationD: explanationD ? String(explanationD) : '',
        diagramSvg: diagramSvg !== undefined ? String(diagramSvg) : undefined,
        pageNumber: parsedPageNumber,
        difficulty: difficulty || 'Medium',
        tags: tags ? String(tags) : '',
        status: status || 'published',
      }
    );
    return res.json({ question: saved });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to save question.', 400);
  }
});

app.delete(
  '/api/admin/subjects/:id',
  requireAuth,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const subjectId = Number(req.params.id);
      const result = await deleteSubjectAdmin(
        { uid: req.user!.uid, email: req.user!.email },
        subjectId
      );
      return res.json(result);
    } catch (error) {
      return sendErrorResponse(res, error, 'Failed to delete subject.', 400);
    }
  }
);

app.delete(
  '/api/admin/lectures/:id',
  requireAuth,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const lectureId = Number(req.params.id);
      const result = await deleteLectureAdmin(
        { uid: req.user!.uid, email: req.user!.email },
        lectureId
      );
      return res.json(result);
    } catch (error) {
      return sendErrorResponse(res, error, 'Failed to delete lecture.', 400);
    }
  }
);

app.delete(
  '/api/admin/question-banks/:id',
  requireAuth,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const bankId = Number(req.params.id);
      const result = await deleteQuestionBankAdmin(
        { uid: req.user!.uid, email: req.user!.email },
        bankId
      );
      return res.json(result);
    } catch (error) {
      return sendErrorResponse(res, error, 'Failed to delete quiz bank.', 400);
    }
  }
);

app.delete(
  '/api/admin/questions/:id',
  requireAuth,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const questionId = Number(req.params.id);
      const result = await deleteOrArchiveQuestionAdmin(
        { uid: req.user!.uid, email: req.user!.email },
        questionId
      );
      return res.json(result);
    } catch (error) {
      return sendErrorResponse(res, error, 'Failed to delete question.', 400);
    }
  }
);

app.delete(
  '/api/admin/sessions/:id',
  requireAuth,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const sessionId = Number(req.params.id);
      const result = await deleteExamSessionAdmin(
        { uid: req.user!.uid, email: req.user!.email },
        sessionId
      );
      return res.json(result);
    } catch (error) {
      return sendErrorResponse(res, error, 'Failed to delete quiz session.', 400);
    }
  }
);

app.put(
  '/api/admin/users/:uid/role',
  requireAuth,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const targetUid = String(req.params.uid);
      const role = req.body?.role === 'admin' ? 'admin' : 'student';
      const result = await updateUserRoleAdmin(
        { uid: req.user!.uid, email: req.user!.email },
        targetUid,
        role
      );
      return res.json(result);
    } catch (error) {
      return sendErrorResponse(res, error, 'Failed to update user role.', 400);
    }
  }
);

app.delete(
  '/api/admin/users/:uid',
  requireAuth,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const targetUid = String(req.params.uid);
      const result = await deleteUserAdmin(
        { uid: req.user!.uid, email: req.user!.email },
        targetUid
      );
      return res.json(result);
    } catch (error) {
      return sendErrorResponse(res, error, 'Failed to delete user.', 400);
    }
  }
);

app.post(
  '/api/admin/users/:uid/lectures/:lectureId/reset',
  requireAuth,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const targetUid = String(req.params.uid);
      const lectureId = Number(req.params.lectureId);
      if (!Number.isInteger(lectureId) || lectureId <= 0) {
        return res.status(400).json({ error: 'Invalid lecture ID.' });
      }
      const result = await resetLectureProgress(
        targetUid,
        lectureId,
        { uid: req.user!.uid, email: req.user!.email }
      );
      return res.json(result);
    } catch (error) {
      return sendErrorResponse(res, error, 'Failed to reset user lecture progress.', 400);
    }
  }
);

app.get('/api/admin/csv-template', requireAuth, requireAdmin, (_req, res) => {
  const csv = getSampleCsvTemplate();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="medatlas_mcq_template.csv"');
  res.send(csv);
});

app.post(
  '/api/admin/import/preview',
  requireAuth,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const { csvContent, targetLectureId } = req.body || {};
      if (!csvContent || typeof csvContent !== 'string') {
        return res.status(400).json({ error: 'CSV content is required for validation.' });
      }
      const preview = await previewCsvImportAdmin(
        csvContent,
        targetLectureId ? Number(targetLectureId) : undefined
      );
      return res.json(preview);
    } catch (error) {
      return sendErrorResponse(res, error, 'Failed to validate CSV.', 400);
    }
  }
);

app.post(
  '/api/admin/import/execute',
  requireAuth,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const { fileName, csvContent, targetLectureId } = req.body || {};
      if (!csvContent || typeof csvContent !== 'string') {
        return res.status(400).json({ error: 'CSV content is required for import.' });
      }
      const result = await executeCsvImportAdmin(
        { uid: req.user!.uid, email: req.user!.email },
        fileName || 'upload.csv',
        csvContent,
        targetLectureId ? Number(targetLectureId) : undefined
      );
      return res.json(result);
    } catch (error) {
      return sendErrorResponse(res, error, 'CSV import failed.', 400);
    }
  }
);

app.get('/api/admin/export-csv', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const csv = await exportQuestionBankCsvAdmin();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="medatlas_question_bank_backup.csv"'
    );
    return res.send(csv);
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to export question bank.', 500);
  }
});

// Automated & Admin-triggered Database Backup Endpoint (Vercel Cron & Administrator Dashboard)
app.all(
  '/api/cron/backup',
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization || '';
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      return next();
    }
    return requireAuth(req, res, () => {
      return requireAdmin(req, res, next);
    });
  },
  async (_req, res) => {
    try {
      const result = await executeScheduledBackup();
      return res.json({
        success: true,
        backupId: result.backupId,
        storageProvider: result.storageProvider,
        isDurable: result.isDurableStorage,
        location: result.location,
        tables: result.metadata.tables,
        restoreVerification: result.verificationResult.status,
        prunedCount: result.prunedCount,
        durationMs: result.durationMs,
      });
    } catch (error: any) {
      console.error('[CRON_BACKUP_ERROR]', error);
      return res.status(500).json({
        success: false,
        error: error?.message || 'Scheduled backup execution failed.',
      });
    }
  }
);

// Global Express error handler to prevent unhandled internal error leaks or stack traces
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
  const isProd = process.env.NODE_ENV === 'production';
  if (status >= 500) {
    console.error('[ServerError]', err?.message || err);
  }
  if (!res.headersSent) {
    res.status(status).json({
      error: status === 500 && isProd ? 'Internal server error' : (err?.message || 'Unexpected error'),
    });
  }
});

// ============================================================================
// VITE DEV SERVER / PRODUCTION STATIC SERVING
// ============================================================================
async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;
  const distPath = path.join(process.cwd(), 'dist');
  const hasDist = fs.existsSync(path.join(distPath, 'index.html'));

  const isProduction =
    process.env.NODE_ENV === 'production' ||
    (!process.env.NODE_ENV && hasDist) ||
    (process.env.NODE_ENV !== 'development' && hasDist);

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Prevent serving server source, compiled backend bundle, or secrets as public static assets
    app.use((req, res, next) => {
      if (
        req.path === '/server.ts' ||
        req.path === '/server.js' ||
        req.path.startsWith('/server.js.') ||
        req.path.startsWith('/server.ts.')
      ) {
        return res.status(404).end();
      }
      return next();
    });
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MedAtlas MCQ server running on http://0.0.0.0:${PORT}`);
  });
}

if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  startServer();
}

export default app;
