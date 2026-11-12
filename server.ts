import { getSampleJsonTemplate } from './src/lib/json-import.ts';
import { protectQuestionImageFields, uploadQuestionImage, imageForStorage, fetchQuestionImage } from './src/lib/telegram-question-images.ts';
import { validImageFileName } from './src/lib/question-images.ts';
import 'dotenv/config';
import {impulseRouter} from './src/lib/impulse-routes.ts';
import {shortAnswerRouter} from './src/lib/short-answer-routes.ts';
import { practicalMockRouter } from './src/lib/practical-mock-routes.ts';
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { protectDocumentFields, documentReferenceForStorage } from './src/lib/protected-document-reference.ts';
import { createProtectedDocumentRouter } from './src/middleware/protected-documents.ts';
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
  reportQuestionForStudent,
  getQuestionReportsForAdmin,
  resolveQuestionReportAdmin,
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
  getProtectedPdfMetadata,
  getDocumentSecuritySettings,
  setDocumentWatermarksEnabled,
  attachPdfToLectureAdmin,
} from './src/db/repository.ts';
import { pool, isDatabaseConfigured } from './src/db/index.ts';
import { createTournament, getDailyGoal, getTournamentBoard, joinTournament, setDailyGoal, StudyRewardsError } from './src/db/study-rewards.ts';
import { tournamentsEnabled } from './src/lib/study-rewards.ts';
import { getSampleCsvTemplate } from './src/lib/mcq-engine.ts';
import { executeScheduledBackup } from './src/lib/backup-service.ts';
import {
  isTelegramConfigured,
  uploadPdfToTelegram,
  fetchTelegramPdfBuffer,
} from './src/lib/telegram-storage.ts';
import {
  isPlanBActive,
  getEgressStatus,
  setPlanBOverride,
} from './src/lib/egress-monitor.ts';

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

// Never expose the original file, including local public assets, range requests,
// old Telegram proxy URLs, or alternate static-serving paths.
app.use((req: Request, res: Response, next: NextFunction) => {
  let pathname: string;
  try { pathname = decodeURIComponent(req.path); } catch { return res.status(400).end(); }
  if ((pathname.startsWith('/lectures/') && pathname !== '/lectures/') || /\.pdf(?:$|\/)/i.test(pathname)) {
    res.set({ 'Cache-Control': 'private, no-store', 'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store' });
    return res.status(410).json({ error: 'Direct PDF delivery is disabled. Use the protected lecture viewer.' });
  }
  next();
});

// Hide original filenames/URLs and Telegram identifiers in every JSON response,
// including catalog, saved sessions, bookmarks, upload results, and admin forms.
app.use((_req: Request, res: Response, next: NextFunction) => {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => originalJson(protectDocumentFields(protectQuestionImageFields(body)))) as typeof res.json;
  next();
});
app.use(express.static(path.resolve(process.cwd(), 'public')));

// Tight default JSON body parser (64kb) for all API and auth endpoints;
// 5mb parser is scoped exclusively to authenticated admin question import endpoints;
// 50mb parser is scoped exclusively to authenticated admin PDF slide deck uploads.
const defaultJsonParser = express.json({ limit: '64kb' });
const adminCsvImportJsonParser = express.json({ limit: '5mb' });
const adminPdfUploadJsonParser = express.json({ limit: '50mb' });
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/impulse')) return next();
  if (req.method === 'POST' && /^\/api\/practical-mocks\/?$/.test(req.path)) return next();
  if (
    req.path.startsWith('/api/admin/import/preview') ||
    req.path.startsWith('/api/admin/import/execute')
  ) {
    return adminCsvImportJsonParser(req, res, next);
  }
  if (req.path.startsWith('/api/admin/upload-pdf') || /^\/api\/admin\/lectures\/\d+\/attach-pdf$/.test(req.path)) {
    return adminPdfUploadJsonParser(req, res, next);
  }
  return defaultJsonParser(req, res, next);
});

const rateLimitResolution = resolveRateLimitStoreConfig(process.env);
const sharedRateLimitStore = rateLimitResolution.store;
const rateLimitDegradedPolicy = rateLimitResolution.degradedModePolicy;
app.use(impulseRouter(sharedRateLimitStore));

app.use('/api/documents', createProtectedDocumentRouter({
  authenticate: requireAuth,
  limiter: createBoundedRateLimiter({ scope: 'document-view', maxRequests: 90,
    windowMs: 60_000, maxKeys: 5_000, store: sharedRateLimitStore,
    degradedModePolicy: rateLimitDegradedPolicy,
    keyGenerator: (req) => (req as AuthRequest).user!.uid }),
  getMetadata: getProtectedPdfMetadata,
  fetchSource: async (fileId) => (await fetchTelegramPdfBuffer(fileId)).buffer,
}));

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/admin/') && req.body && Object.hasOwn(req.body, 'pdfUrl')) {
    try { req.body.pdfUrl = documentReferenceForStorage(req.body.pdfUrl); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid document reference.' }); }
  }
  next();
});

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
  const detail = error instanceof Error ? error.message : undefined;
  return res.status(defaultStatus).json({
    error: fallbackMessage,
    ...(detail ? { detail } : {}),
  });
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
// SYSTEM HEALTH & DIAGNOSTICS API
// ============================================================================
app.get('/api/health', async (_req, res) => {
  const isConfigured = isDatabaseConfigured();
  if (!isConfigured) {
    return res.status(500).json({
      status: 'error',
      error: 'Database environment variables are missing.',
    });
  }
  try {
    const t0 = Date.now();
    await pool.query('SELECT 1 as ok');
    return res.json({
      status: 'ok',
      database: 'connected',
      latencyMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({
      status: 'error',
      database: 'disconnected',
      error: error?.message || 'Database connection error',
      code: error?.code,
    });
  }
});

// ============================================================================
// PUBLIC CATALOG API
// ============================================================================
app.get('/api/catalog', async (_req, res) => {
  try {
    const catalog = await getPublishedCatalog();
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
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
    const { email, password, displayName, faculty } = req.body || {};
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
        error: 'Username must be at least 2 characters long.',
      });
    }

    // Any client-supplied role or emailVerified flags in req.body are ignored.
    const user = await registerEmailPasswordUser(email, password, displayName, faculty);
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

app.use('/api/short-answers', requireAuth, shortAnswerRouter);
app.use('/api/practical-mocks', requireAuth, practicalMockRouter(requireAdmin));

app.all('/api/auth/gemini-key', requireAuth, async (req: AuthRequest, res) => {
  res.setHeader('Cache-Control','no-store');
  try {
    const keys=await import('./src/lib/student-gemini-keys.ts');
    const uid=req.user!.uid;
    if(req.method==='GET')return res.json(await keys.getStudentGeminiKeyStatus(uid));
    if(req.method==='DELETE')return res.json(await keys.removeStudentGeminiKey(uid));
    if(req.method==='PUT') {
      if(!keys.studentKeyStorageAvailable())return res.status(503).json({error:'Secure key storage is temporarily unavailable. Please try again later.'});
      const value=typeof req.body?.apiKey==='string'?req.body.apiKey.trim():req.body?.apiKey;
      if(!keys.validStudentGeminiKey(value))return res.status(400).json({error:'Paste the complete key copied from Google AI Studio, without quotes, spaces, or an API-key assignment.'});
      return res.json(await keys.saveStudentGeminiKey(uid,value));
    }
    res.setHeader('Allow','GET, PUT, DELETE');return res.status(405).json({error:'Method not allowed.'});
  }catch{
    // Never include provider keys, request bodies, database errors or ciphertext in logs/responses.
    return res.status(500).json({error:'Could not update Gemini key settings. Please try again.'});
  }
});

app.put('/api/auth/profile', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { displayName, faculty, preferences } = req.body || {};
    const updated = await updateUserProfile(req.user!.uid, {
      displayName,
      faculty,
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
      specialTags,
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
      specialTags: Array.isArray(specialTags)
        ? specialTags.map(String).filter(Boolean)
        : undefined,
      requestedCount: requestedCount ? Number(requestedCount) : undefined,
      shuffleQuestions: Boolean(shuffleQuestions),
      shuffleOptions: Boolean(shuffleOptions),
      avoidRecent: Boolean(avoidRecent),
      onlyMistakes: Boolean(onlyMistakes),
      batched: req.body?.batchSize === 6,
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
    const batched = req.query.batchSize === '6';
    const offset = req.query.offset === undefined ? undefined : Number(req.query.offset);
    if (req.query.offset !== undefined && (!batched || !Number.isSafeInteger(offset) || offset! < 0 || offset! % 6 !== 0)) {
      return res.status(400).json({ error: 'Invalid question batch offset.' });
    }
    const session = await getExamSessionForStudent(req.user!.uid, sessionId, undefined,
      { batched, offset: req.query.review === '1' && batched ? 0 : offset, batchOnly: req.query.review !== '1' && offset !== undefined });
    return res.json({ session });
  } catch (error) {
    return sendErrorResponse(res, error, 'Session not found.', 404);
  }
});

app.post(['/api/sessions/:id/short-answer','/api/sessions/:id/short-answer/grade'],requireAuth,async(req:AuthRequest,res)=>{
 try{const {saveQuizShortAnswer,gradeQuizShortAnswer,saveAndGradeQuizShortAnswer}=await import('./src/lib/mixed-quiz-short-answers.ts');
 if(req.path.endsWith('/grade')){
  if(req.body?.consent!==true)return res.status(400).json({error:'Confirm sending your answer to Google for grading.'});
  const {questionId,answer}=req.body;
  return res.json(await (answer===undefined
   ?gradeQuizShortAnswer(req.user!.uid,req.params.id,questionId)
   :saveAndGradeQuizShortAnswer(req.user!.uid,req.params.id,questionId,answer)));
 }
 return res.json(await saveQuizShortAnswer(req.user!.uid,req.params.id,req.body?.questionId,req.body?.answer));
 }catch(error:any){return res.status(error.status||500).json({error:error.status?error.message:'Could not save or grade this answer. Your previous progress is safe.'});}
});

app.post('/api/sessions/:id/answer', requireAuth, async (req: AuthRequest, res) => {
  try {
    const sessionId = Number(req.params.id);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ error: 'Invalid session ID.' });
    }
    const { questionId, selectedOption, lockAnswer, elapsedSeconds, slim, matchingChoiceId } = req.body || {};
    const session = await saveSessionQuestionAnswer(
      req.user!.uid,
      sessionId,
      Number(questionId),
      selectedOption || null,
      Boolean(lockAnswer),
      typeof elapsedSeconds === 'number' ? elapsedSeconds : undefined,
      Boolean(slim),
      matchingChoiceId
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
      typeof elapsedSeconds === 'number' ? elapsedSeconds : undefined,
      { batched: req.body?.batchSize === 6 }
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

function sendStudyRewardsError(res: Response, error: unknown) {
  if (error instanceof StudyRewardsError) return res.status(error.status).json({ error: error.message });
  console.error('Study rewards request failed:', error);
  return res.status(500).json({ error: 'Could not update study rewards. Please try again.' });
}

app.get('/api/study-goal', requireAuth, async (req: AuthRequest, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { return res.json(await getDailyGoal(req.user!.uid)); }
  catch (error) { return sendStudyRewardsError(res, error); }
});

app.put('/api/study-goal', requireAuth, async (req: AuthRequest, res) => {
  try { return res.json(await setDailyGoal(req.user!.uid, req.body?.target)); }
  catch (error) { return sendStudyRewardsError(res, error); }
});

if (!tournamentsEnabled) {
  app.use(['/api/tournaments', '/api/admin/tournaments'], (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
}

app.get('/api/tournaments', requireAuth, async (req: AuthRequest, res) => {
  res.set('Cache-Control', 'private, no-store');
  const rawId = req.query.id;
  if (rawId !== undefined && (typeof rawId !== 'string' || !/^[1-9]\d{0,9}$/.test(rawId) || Number(rawId) > 2147483647)) {
    return res.status(400).json({ error: 'Choose a valid tournament.' });
  }
  try { return res.json(await getTournamentBoard(req.user!.uid, rawId === undefined ? undefined : Number(rawId))); }
  catch (error) { return sendStudyRewardsError(res, error); }
});

app.post('/api/tournaments/:id/join', requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) return res.status(400).json({ error: 'Choose a valid tournament.' });
  try { return res.json(await joinTournament(req.user!.uid, id, req.body?.nickname)); }
  catch (error) { return sendStudyRewardsError(res, error); }
});

app.post('/api/admin/tournaments', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try { return res.status(201).json(await createTournament(req.body)); }
  catch (error) { return sendStudyRewardsError(res, error); }
});

app.get('/api/bookmarks', requireAuth, async (req: AuthRequest, res) => {
  try {
    const positiveInteger = (value: unknown) => value === undefined || (typeof value === 'string' && /^[1-9]\d{0,5}$/.test(value));
    if (![req.query.page, req.query.pageSize, req.query.subjectId].every(positiveInteger) ||
      (req.query.status !== undefined && !['all', 'correct', 'incorrect', 'unanswered'].includes(String(req.query.status)))) {
      return res.status(400).json({ error: 'Choose a valid review page and filters.' });
    }
    const data = await getStudentBookmarksAndReview(req.user!.uid, req.query.view === 'saved', {
      page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 25,
      subjectId: Number(req.query.subjectId) || undefined, status: req.query.status ? String(req.query.status) : undefined,
      reviewOnly: req.query.view === 'answered',
    });
    return res.json(data);
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to load bookmarks.', 500);
  }
});

app.post('/api/bookmarks/toggle', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { questionId, note, bookmarked } = req.body || {};
    if (bookmarked !== undefined && typeof bookmarked !== 'boolean') return res.status(400).json({ error: 'bookmarked must be true or false.' });
    if (!Number.isInteger(Number(questionId)) || Number(questionId) <= 0) {
      return res.status(400).json({ error: 'questionId is required.' });
    }
    const result = await toggleBookmarkForStudent(
      req.user!.uid,
      Number(questionId),
      note ? String(note) : undefined,
      bookmarked
    );
    return res.json(result);
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to toggle bookmark.', 500);
  }
});

const questionReportLimiter = createBoundedRateLimiter({
  scope: 'question-report', maxRequests: 20, windowMs: 60 * 60_000, maxKeys: 5000,
  store: sharedRateLimitStore, degradedModePolicy: rateLimitDegradedPolicy,
  keyGenerator: req => (req as AuthRequest).user!.uid,
});

app.post('/api/question-reports', requireAuth, questionReportLimiter, async (req: AuthRequest, res) => {
  try {
    const result = await reportQuestionForStudent(req.user!.uid, req.body?.questionId, req.body?.reason);
    return res.json(result);
  } catch (error) { return sendErrorResponse(res, error, 'Could not send the question report.', 500); }
});

app.get('/api/admin/question-reports', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try { return res.json(await getQuestionReportsForAdmin(req.user!.uid)); }
  catch (error) { return sendErrorResponse(res, error, 'Could not load question reports.', 500); }
});

app.post('/api/admin/question-reports/:id/resolve', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try { return res.json(await resolveQuestionReportAdmin(req.user!, Number(req.params.id))); }
  catch (error) { return sendErrorResponse(res, error, 'Could not resolve the question report.', 500); }
});

// ============================================================================
// PROTECTED ADMINISTRATOR API
// ============================================================================
app.get('/api/admin/egress-status', requireAuth, requireAdmin, (_req: AuthRequest, res) => {
  return res.json(getEgressStatus());
});

app.post('/api/admin/egress-fallback', requireAuth, requireAdmin, (req: AuthRequest, res) => {
  const { forceFallback } = req.body || {};
  if (forceFallback === true || forceFallback === false || forceFallback === null) {
    setPlanBOverride(forceFallback);
  }
  return res.json(getEgressStatus());
});

app.get('/api/admin/overview', requireAuth, requireAdmin, async (_req: AuthRequest, res) => {
  try {
    const [data, documentSecurity] = await Promise.all([getAdminDashboardData(), getDocumentSecuritySettings()]);
    return res.json({
      ...data,
      egressStatus: getEgressStatus(),
      isTelegramConfigured: isTelegramConfigured(),
      documentSecurity,
    });
  } catch (error) {
    return sendErrorResponse(res, error, 'Failed to load admin overview.', 500);
  }
});

app.put('/api/admin/document-security', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    if (typeof req.body?.watermarksEnabled !== 'boolean') {
      return res.status(400).json({error:'watermarksEnabled must be a boolean.'});
    }
    const documentSecurity = await setDocumentWatermarksEnabled({uid:req.user!.uid,email:req.user!.email!},req.body.watermarksEnabled);
    return res.json({documentSecurity});
  } catch (error) { return sendErrorResponse(res,error,'Failed to save document settings.',500); }
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

    if (!isTelegramConfigured()) throw new Error('Telegram PDF storage is required.');
    const tgResult = await uploadPdfToTelegram(uniqueFileName, buffer, `MedAtlas Lecture: ${fileName}`);
    const savedRecord = await saveUploadedPdfFileAdmin(
      { uid: req.user!.uid, email: req.user!.email },
      { fileName: uniqueFileName, mimeType: 'application/pdf', fileSize: buffer.length,
        dataBase64: '', url: relativeUrl, telegramFileId: tgResult.fileId }
    );
    const effectivePdfUrl = relativeUrl;

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

      if (!isTelegramConfigured()) throw new Error('Telegram PDF storage is required.');
      const tgResult = await uploadPdfToTelegram(uniqueFileName, buffer, `MedAtlas Lecture: ${fileName}`);
      await saveUploadedPdfFileAdmin(
        { uid: req.user!.uid, email: req.user!.email },
        { fileName: uniqueFileName, mimeType: 'application/pdf', fileSize: buffer.length,
          dataBase64: '', url: relativeUrl, telegramFileId: tgResult.fileId }
      );

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
        contentType:req.body.contentType,
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
      specialTags,
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
        matchingChoiceId: req.body.matchingChoiceId,
        explanation: String(explanation),
        explanationA: explanationA ? String(explanationA) : '',
        explanationB: explanationB ? String(explanationB) : '',
        explanationC: explanationC ? String(explanationC) : '',
        explanationD: explanationD ? String(explanationD) : '',
        diagramSvg: diagramSvg !== undefined ? String(diagramSvg) : undefined,
        pageNumber: parsedPageNumber,
        difficulty: difficulty || 'Medium',
        tags: tags ? String(tags) : '',
        specialTags: specialTags ? String(specialTags) : '',
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

const imageReadLimiter = createBoundedRateLimiter({scope:'question-image-read',maxRequests:240,windowMs:60000,maxKeys:5000,store:sharedRateLimitStore,degradedModePolicy:rateLimitDegradedPolicy,keyGenerator:(req)=>String((req as AuthRequest).user?.uid || normalizeClientIp(req))});
const imageUploadLimiter = createBoundedRateLimiter({scope:'question-image-upload',maxRequests:150,windowMs:600000,maxKeys:100,store:sharedRateLimitStore,degradedModePolicy:rateLimitDegradedPolicy,keyGenerator:(req)=>String((req as AuthRequest).user?.uid)});
app.post('/api/admin/import/image', requireAuth, requireAdmin, imageUploadLimiter, express.raw({type:'application/octet-stream',limit:'2mb'}), async(req:AuthRequest,res)=>{
  const fileName=String(req.query.name || '');
  if(!validImageFileName(fileName) || !Buffer.isBuffer(req.body))return res.status(400).json({error:'Choose a PNG, JPEG, or WebP file up to 2 MB.'});
  try {return res.json(await uploadQuestionImage(fileName,req.body));}
  catch {return res.status(400).json({error:'Image could not be uploaded. Check it is a valid PNG/JPEG/WebP under 2 MB, then retry.'});}
});
app.get('/api/question-images/:reference', requireAuth, imageReadLimiter, async(req:AuthRequest,res)=>{
  res.set({'Cache-Control':'private, no-store','CDN-Cache-Control':'no-store','Vercel-CDN-Cache-Control':'no-store'});
  let image;
  try {image=imageForStorage({id:'',alt:'',source:'/api/question-images/'+req.params.reference});}
  catch {return res.status(404).json({error:'Image reference is invalid. Reopen the study set.'});}
  try {
    const buffer=await fetchQuestionImage(image);
    return res.type(image.mimeType!).set('Content-Disposition','inline').send(buffer);
  } catch {return res.status(503).json({error:'Image is temporarily unavailable. Please retry loading it.'});}
});
app.get('/api/admin/json-template',requireAuth,requireAdmin,(_req,res)=>res.type('application/json').attachment('medatlas_mcq_template.json').send(getSampleJsonTemplate()));

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
      const { csvContent, jsonContent, imageFiles, targetLectureId } = req.body || {};
      const content = jsonContent ?? csvContent;
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'JSON content is required for validation.' });
      }
      const preview = await previewCsvImportAdmin(
        content,
        targetLectureId ? Number(targetLectureId) : undefined,
        jsonContent !== undefined ? {format:'json', imageFiles: imageFiles ?? []} : undefined
      );
      return res.json(preview);
    } catch (error) {
      return sendErrorResponse(res, error, 'Failed to validate questions.', 400);
    }
  }
);

app.post(
  '/api/admin/import/execute',
  requireAuth,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const { fileName, csvContent, jsonContent, imageFiles, uploadedImages, targetLectureId, rowOverrides } = req.body || {};
      const content = jsonContent ?? csvContent;
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'JSON content is required for import.' });
      }
      const result = await executeCsvImportAdmin(
        { uid: req.user!.uid, email: req.user!.email },
        fileName || 'upload.json',
        content,
        targetLectureId ? Number(targetLectureId) : undefined,
        rowOverrides,
        jsonContent !== undefined ? {format:'json', imageFiles: imageFiles ?? [], uploadedImages} : undefined
      );
      return res.json(result);
    } catch (error) {
      return sendErrorResponse(res, error, 'Question import failed.', 400);
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
