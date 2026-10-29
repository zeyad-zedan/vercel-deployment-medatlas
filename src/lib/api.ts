import {
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
  type UserCredential,
} from 'firebase/auth';
import { auth, googleAuthProvider } from './firebase.ts';

const STORAGE_TOKEN_KEY = 'medatlas_session_token';
const STORAGE_USER_KEY = 'medatlas_cached_user_profile';

let inMemoryAuthToken: string | null =
  typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_TOKEN_KEY) : null;

export function setCachedUserProfile(user: UserProfile | null) {
  if (typeof window === 'undefined') return;
  try {
    if (user) {
      window.localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user));
    } else {
      window.localStorage.removeItem(STORAGE_USER_KEY);
    }
  } catch {}
}

export function getCachedUserProfile(): UserProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_USER_KEY);
    return raw ? (JSON.parse(raw) as UserProfile) : null;
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null) {
  inMemoryAuthToken = token;
  if (!token) {
    lastExchangedFirebaseUser = null;
  }
  if (typeof window !== 'undefined') {
    if (token) {
      window.localStorage.setItem(STORAGE_TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(STORAGE_TOKEN_KEY);
      window.localStorage.removeItem(STORAGE_USER_KEY);
    }
  }
}

export function getAuthToken(): string | null {
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(STORAGE_TOKEN_KEY);
      if (stored !== inMemoryAuthToken) {
        inMemoryAuthToken = stored;
        if (!stored) {
          lastExchangedFirebaseUser = null;
        }
      }
    } catch {}
  }
  return inMemoryAuthToken;
}

export type FirebaseClientAuthHandlersForTests = {
  signInWithPopup?: (auth: any, provider: any) => Promise<any>;
  signInWithRedirect?: (auth: any, provider: any) => Promise<void>;
  getRedirectResult?: (auth: any) => Promise<any>;
  signOut?: (auth: any) => Promise<void>;
  onAuthStateChanged?: (
    auth: any,
    nextOrObserver: (user: any) => void,
    error?: (err: Error) => void
  ) => () => void;
};

let customClientAuthHandlersForTests: FirebaseClientAuthHandlersForTests | null = null;

export function setFirebaseClientAuthHandlersForTests(
  handlers: FirebaseClientAuthHandlersForTests | null
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Security violation: setFirebaseClientAuthHandlersForTests is forbidden outside test environment.');
  }
  customClientAuthHandlersForTests = handlers;
  inFlightFirebaseExchange = null;
  lastExchangedFirebaseUser = null;
}

const REDIRECT_PENDING_STORAGE_KEY = 'medatlas_google_redirect_in_progress';

function setPendingRedirectMarker(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(REDIRECT_PENDING_STORAGE_KEY, 'true');
  } catch {}
  try {
    window.localStorage.setItem(REDIRECT_PENDING_STORAGE_KEY, 'true');
  } catch {}
}

function hasPendingRedirectMarker(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.sessionStorage.getItem(REDIRECT_PENDING_STORAGE_KEY) === 'true') {
      return true;
    }
  } catch {}
  try {
    if (window.localStorage.getItem(REDIRECT_PENDING_STORAGE_KEY) === 'true') {
      return true;
    }
  } catch {}
  return false;
}

function clearPendingRedirectMarker(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(REDIRECT_PENDING_STORAGE_KEY);
  } catch {}
  try {
    window.localStorage.removeItem(REDIRECT_PENDING_STORAGE_KEY);
  } catch {}
}

let inFlightFirebaseExchange: {
  uid: string;
  promise: Promise<UserProfile>;
} | null = null;

let lastExchangedFirebaseUser: {
  uid: string;
  profile: UserProfile;
} | null = null;

/**
 * Exchanges a verified Firebase User with the MedAtlas backend (/api/auth/me)
 * using only supported public Firebase Auth APIs (user.getIdToken())
 * to establish an authoritative server-signed HMAC session.
 * Deduplicates concurrent calls for the same Firebase UID.
 */
async function exchangeFirebaseUserForSession(
  firebaseUser: { uid?: string; getIdToken?: (forceRefresh?: boolean) => Promise<string> }
): Promise<UserProfile> {
  if (!firebaseUser || typeof firebaseUser.getIdToken !== 'function') {
    throw new Error('Invalid Google authentication credential: missing user.getIdToken().');
  }

  const uidKey = firebaseUser.uid || '__anonymous_firebase_uid__';

  const currentToken = getAuthToken();
  if (
    firebaseUser.uid &&
    lastExchangedFirebaseUser?.uid === firebaseUser.uid &&
    currentToken &&
    currentToken.startsWith('medatlas.')
  ) {
    return lastExchangedFirebaseUser.profile;
  }

  if (inFlightFirebaseExchange && inFlightFirebaseExchange.uid === uidKey) {
    return inFlightFirebaseExchange.promise;
  }

  const exchangePromise = (async (): Promise<UserProfile> => {
    const idToken = await firebaseUser.getIdToken!();
    if (!idToken || typeof idToken !== 'string') {
      throw new Error('Could not retrieve authentication token from Google credential.');
    }

    // Send the Firebase ID token in the Authorization header without overwriting
    // the stored MedAtlas session token until the backend returns a verified medatlas.* token.
    const data = await apiRequest<{ token?: string; user?: UserProfile }>('/api/auth/me', {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    if (
      !data ||
      typeof data.token !== 'string' ||
      !data.token.startsWith('medatlas.') ||
      !data.user ||
      typeof data.user.uid !== 'string'
    ) {
      throw new Error('MedAtlas server did not return a valid authenticated session.');
    }

    setAuthToken(data.token);
    setCachedUserProfile(data.user);
    clearPendingRedirectMarker();

    if (firebaseUser.uid) {
      lastExchangedFirebaseUser = { uid: firebaseUser.uid, profile: data.user };
    }

    // Clear in-memory Firebase client session after MedAtlas session is safely established
    const signOutFn =
      process.env.NODE_ENV === 'test' && customClientAuthHandlersForTests?.signOut
        ? customClientAuthHandlersForTests.signOut
        : signOut;
    await signOutFn(auth).catch(() => {});

    return data.user;
  })();

  inFlightFirebaseExchange = { uid: uidKey, promise: exchangePromise };

  try {
    return await exchangePromise;
  } finally {
    if (inFlightFirebaseExchange?.promise === exchangePromise) {
      inFlightFirebaseExchange = null;
    }
  }
}

async function exchangeFirebaseCredentialForSession(
  result: UserCredential
): Promise<UserProfile> {
  if (!result || !result.user) {
    throw new Error('Google authentication did not return a valid user credential.');
  }
  return await exchangeFirebaseUserForSession(result.user);
}

export function subscribeToAuthChanges(
  onUserResolved: (user: UserProfile | null) => void,
  onRedirectError?: (error: Error) => void
): () => void {
  let cancelled = false;
  let hasResolvedAuthenticatedUser = false;
  let pendingListenerExchange: Promise<UserProfile | null> | null = null;
  let resolveInitialAuthState: ((user: any) => void) | null = null;
  const wasRedirectExpected = hasPendingRedirectMarker();
  const graceTimeoutMs = process.env.NODE_ENV === 'test' ? 60 : 500;

  const emitAuthenticatedUser = (profile: UserProfile) => {
    if (cancelled || hasResolvedAuthenticatedUser) return;
    hasResolvedAuthenticatedUser = true;
    onUserResolved(profile);
  };

  const initialAuthStatePromise = new Promise<any>((resolve) => {
    resolveInitialAuthState = resolve;
    setTimeout(() => {
      if (resolveInitialAuthState) {
        const r = resolveInitialAuthState;
        resolveInitialAuthState = null;
        r(null);
      }
    }, graceTimeoutMs);
  });

  const onAuthStateChangedFn =
    process.env.NODE_ENV === 'test' && customClientAuthHandlersForTests?.onAuthStateChanged
      ? customClientAuthHandlersForTests.onAuthStateChanged
      : typeof onAuthStateChanged === 'function'
      ? onAuthStateChanged
      : null;

  // Bind onAuthStateChanged to catch asynchronously restored Firebase credentials
  // and coordinate with getRedirectResult() via deduplicated exchangeFirebaseUserForSession.
  const unsubscribeFirebase = onAuthStateChangedFn
    ? onAuthStateChangedFn(
        auth,
        (firebaseUser: any) => {
          if (cancelled || !firebaseUser) {
            if (resolveInitialAuthState && !wasRedirectExpected) {
              const r = resolveInitialAuthState;
              resolveInitialAuthState = null;
              r(null);
            }
            return;
          }

          const task = exchangeFirebaseUserForSession(firebaseUser)
            .then((profile) => {
              emitAuthenticatedUser(profile);
              return profile;
            })
            .catch((err: any) => {
              if (!cancelled && !hasResolvedAuthenticatedUser) {
                onRedirectError?.(
                  err instanceof Error
                    ? err
                    : new Error(err?.message || 'Failed to complete Google authentication.')
                );
              }
              return null;
            })
            .finally(() => {
              if (pendingListenerExchange === task) {
                pendingListenerExchange = null;
              }
            });

          pendingListenerExchange = task;
          if (resolveInitialAuthState) {
            const r = resolveInitialAuthState;
            resolveInitialAuthState = null;
            r(firebaseUser);
          }
        },
        (err: Error) => {
          if (resolveInitialAuthState) {
            const r = resolveInitialAuthState;
            resolveInitialAuthState = null;
            r(null);
          }
          if (!cancelled && !hasResolvedAuthenticatedUser) {
            onRedirectError?.(err);
          }
        }
      )
    : () => {};

  (async () => {
    try {
      // 1. Process pending Google Redirect authentication if returning from Google OAuth
      try {
        const redirectUser = await api.handleGoogleRedirectResult();
        if (redirectUser) {
          emitAuthenticatedUser(redirectUser);
          return;
        }
      } catch (redirectErr: any) {
        console.warn('Google redirect resolution error:', redirectErr);
        if (!cancelled) {
          if (onRedirectError) {
            onRedirectError(
              redirectErr instanceof Error
                ? redirectErr
                : new Error(redirectErr?.message || 'Google sign-in via redirect failed.')
            );
          }
          if (!hasResolvedAuthenticatedUser) {
            onUserResolved(null);
          }
        }
        return;
      }

      // 2. Wait for initial onAuthStateChanged emission / in-flight exchange if no token is present yet
      if (!hasResolvedAuthenticatedUser && !pendingListenerExchange && (wasRedirectExpected || !getAuthToken())) {
        await initialAuthStatePromise;
      }
      if (pendingListenerExchange) {
        const listenerUser = await pendingListenerExchange;
        if (listenerUser || hasResolvedAuthenticatedUser || cancelled) {
          return;
        }
      }
      if (hasResolvedAuthenticatedUser || cancelled) {
        return;
      }

      // 3. Otherwise verify existing MedAtlas server session token
      const existingToken = getAuthToken();
      if (existingToken) {
        if (!existingToken.startsWith('medatlas.')) {
          setAuthToken(null);
        } else {
          const data = await api.getCurrentUser();
          if (data && data.user && data.user.uid) {
            if (data.token && data.token.startsWith('medatlas.')) {
              setAuthToken(data.token);
            }
            setCachedUserProfile(data.user);
            emitAuthenticatedUser(data.user);
            return;
          } else {
            setAuthToken(null);
          }
        }
      }

      // 4. If a Google redirect was explicitly initiated by the user, but the browser returned
      // with no Firebase credential (e.g. due to cross-domain third-party storage partitioning),
      // surface a clear diagnostic error rather than silently rendering an unauthenticated homepage.
      if (wasRedirectExpected && !hasResolvedAuthenticatedUser && !cancelled) {
        const blockedErr: any = new Error(
          'Google sign-in returned to MedAtlas, but your browser blocked cross-domain redirect storage. Please click "Continue with Google" to sign in via popup, or sign in with Email & Password below.'
        );
        blockedErr.code = 'auth/redirect-session-blocked';
        onRedirectError?.(blockedErr);
        onUserResolved(null);
        return;
      }

      if (!cancelled && !hasResolvedAuthenticatedUser) {
        onUserResolved(null);
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.status === 403 || err?.message?.includes('401')) {
        setAuthToken(null);
      } else {
        console.warn('Error verifying existing MedAtlas session:', err);
      }
      if (!cancelled && !hasResolvedAuthenticatedUser) {
        onUserResolved(null);
      }
    }
  })();

  return () => {
    cancelled = true;
    try {
      unsubscribeFirebase();
    } catch {}
  };
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  const currentToken = getAuthToken();
  if (currentToken && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${currentToken}`;
  }

  const res = await fetch(path, {
    ...options,
    headers,
  });

  if (!res.ok) {
    if (res.status === 401) {
      setAuthToken(null);
    }

    let errMsg = `Request failed (${res.status})`;
    try {
      const errBody = await res.json();
      if (errBody?.error) errMsg = errBody.error;
    } catch {
      // ignore json parse error
    }
    const err: any = new Error(errMsg);
    err.status = res.status;
    throw err;
  }

  return res.json() as Promise<T>;
}

export interface UserProfile {
  id: number;
  uid: string;
  email: string;
  displayName: string;
  authProvider?: string;
  hasPassword?: boolean;
  role: 'student' | 'admin';
  subscriptionTier: string;
  subscriptionStatus: string;
  emailVerified: boolean;
  preferences: string;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  // Public Catalog
  getCatalog: () =>
    apiRequest<{
      subjects: any[];
      lectures: any[];
      totalPublishedQuestions: number;
    }>('/api/catalog'),

  // Authentication
  registerWithEmail: async (email: string, password: string, displayName: string) => {
    const data = await apiRequest<{ token: string; user: UserProfile }>(
      '/api/auth/register',
      {
        method: 'POST',
        body: JSON.stringify({ email, password, displayName }),
      }
    );
    setAuthToken(data.token);
    setCachedUserProfile(data.user);
    return data.user;
  },

  loginWithEmail: async (email: string, password: string) => {
    const data = await apiRequest<{ token: string; user: UserProfile }>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }
    );
    setAuthToken(data.token);
    setCachedUserProfile(data.user);
    return data.user;
  },

  loginWithGooglePopup: async (): Promise<UserProfile> => {
    const popupFn =
      process.env.NODE_ENV === 'test' && customClientAuthHandlersForTests?.signInWithPopup
        ? customClientAuthHandlersForTests.signInWithPopup
        : signInWithPopup;
    const result = await popupFn(auth, googleAuthProvider);
    return await exchangeFirebaseCredentialForSession(result);
  },

  loginWithGoogleRedirect: async (): Promise<void> => {
    setPendingRedirectMarker();
    const redirectFn =
      process.env.NODE_ENV === 'test' && customClientAuthHandlersForTests?.signInWithRedirect
        ? customClientAuthHandlersForTests.signInWithRedirect
        : signInWithRedirect;
    await redirectFn(auth, googleAuthProvider);
  },

  handleGoogleRedirectResult: async (): Promise<UserProfile | null> => {
    if (typeof window === 'undefined') return null;
    const isRedirectExpected = hasPendingRedirectMarker();

    const getRedirectResultFn =
      process.env.NODE_ENV === 'test' && customClientAuthHandlersForTests?.getRedirectResult
        ? customClientAuthHandlersForTests.getRedirectResult
        : getRedirectResult;

    try {
      const result = await getRedirectResultFn(auth);
      clearPendingRedirectMarker();

      if (result && result.user) {
        return await exchangeFirebaseCredentialForSession(result);
      }

      // If redirect was in progress or Firebase user is present, wait for authStateReady and exchange
      if (isRedirectExpected || auth.currentUser) {
        if (typeof auth.authStateReady === 'function') {
          await auth.authStateReady();
        }
        if (auth.currentUser) {
          return await exchangeFirebaseUserForSession(auth.currentUser);
        }
      }

      return null;
    } catch (err: any) {
      clearPendingRedirectMarker();

      // If no redirect was in progress and there's no auth event, swallow cleanly
      if (!isRedirectExpected && (err?.code === 'auth/no-auth-event' || !err?.code)) {
        return null;
      }
      throw err;
    }
  },

  requestPasswordReset: async (email: string) => {
    const origin =
      typeof window !== 'undefined' ? window.location.origin : undefined;
    return apiRequest<{
      accepted: boolean;
      message: string;
      expiresInMinutes: number;
      cooldownSeconds?: number;
    }>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email, origin }),
    });
  },

  verifyRecoveryCode: async (email: string, code: string) => {
    return apiRequest<{ valid: boolean }>('/api/auth/verify-code', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    });
  },

  confirmPasswordReset: (
    target:
      | string
      | { email?: string; code?: string; token?: string; newPassword?: string },
    optionalPassword?: string
  ) => {
    let payload: Record<string, any>;
    if (typeof target === 'string') {
      payload = { token: target, newPassword: optionalPassword };
    } else {
      payload = target;
    }
    return apiRequest<{ message: string }>('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  changePassword: async (currentPassword: string, newPassword: string) => {
    const data = await apiRequest<{
      message: string;
      token: string;
      user: UserProfile;
    }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    setAuthToken(data.token);
    return data;
  },

  linkPassword: async (newPassword: string) => {
    const data = await apiRequest<{
      message: string;
      token: string;
      user: UserProfile;
    }>('/api/auth/link-password', {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    });
    setAuthToken(data.token);
    return data;
  },

  logout: async () => {
    if (inMemoryAuthToken) {
      try {
        await apiRequest<{ loggedOut: boolean }>('/api/auth/logout', {
          method: 'POST',
        });
      } catch {
        // ignore if token already expired
      }
    }
    inFlightFirebaseExchange = null;
    lastExchangedFirebaseUser = null;
    clearPendingRedirectMarker();
    setAuthToken(null);
    const signOutFn =
      process.env.NODE_ENV === 'test' && customClientAuthHandlersForTests?.signOut
        ? customClientAuthHandlersForTests.signOut
        : signOut;
    try {
      await signOutFn(auth);
    } catch {
      // ignore if not signed in via firebase
    }
  },

  getCurrentUser: () =>
    apiRequest<{ token?: string; user: UserProfile }>('/api/auth/me'),

  updateProfile: (displayName: string, preferences?: Record<string, unknown>) =>
    apiRequest<{ user: UserProfile }>('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({ displayName, preferences }),
    }),

  deleteAccount: async () => {
    const res = await apiRequest<{ deleted: boolean }>('/api/auth/account', {
      method: 'DELETE',
    });
    setAuthToken(null);
    try {
      await signOut(auth);
    } catch {
      // ignore
    }
    return res;
  },

  // Student Sessions & MCQ Engine
  startSession: (params: {
    mode: 'study' | 'exam' | 'custom';
    title?: string;
    subjectIds?: number[];
    lectureIds?: number[];
    difficulties?: string[];
    tagFilter?: string;
    requestedCount?: number;
    shuffleQuestions?: boolean;
    shuffleOptions?: boolean;
    avoidRecent?: boolean;
    onlyMistakes?: boolean;
    timeLimitMinutes?: number | null;
  }) =>
    apiRequest<{ session: any; shortfallNotice: string | null }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  getSession: (sessionId: number) =>
    apiRequest<{ session: any }>(`/api/sessions/${sessionId}`),

  submitQuestionAnswer: (
    sessionId: number,
    questionId: number,
    selectedOption: string | null,
    lockAnswer: boolean,
    elapsedSeconds?: number
  ) =>
    apiRequest<{ session: any }>(`/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      keepalive: true,
      body: JSON.stringify({
        questionId,
        selectedOption,
        lockAnswer,
        elapsedSeconds,
      }),
    }),

  syncSessionProgress: (sessionId: number, elapsedSeconds: number) =>
    apiRequest<{ success: boolean }>(`/api/sessions/${sessionId}/sync`, {
      method: 'POST',
      keepalive: true,
      body: JSON.stringify({ elapsedSeconds }),
    }),

  completeSession: (
    sessionId: number,
    answers?: Record<number, string | null>,
    elapsedSeconds?: number
  ) =>
    apiRequest<{ session: any }>(`/api/sessions/${sessionId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ answers, elapsedSeconds }),
    }),

  // Bookmarks & Dashboard
  getDashboard: () => apiRequest<any>('/api/dashboard'),

  getBookmarks: () =>
    apiRequest<{ bookmarks: any[]; answeredQuestions: any[] }>('/api/bookmarks'),

  toggleBookmark: (questionId: number, note?: string) =>
    apiRequest<{ bookmarked: boolean; questionId: number }>('/api/bookmarks/toggle', {
      method: 'POST',
      body: JSON.stringify({ questionId, note }),
    }),

  resetLectureProgress: (lectureId: number) =>
    apiRequest<{
      success: boolean;
      message: string;
      lectureId: number;
      lectureTitle: string;
    }>(`/api/lectures/${lectureId}/reset`, {
      method: 'POST',
    }),

  // Administrator Operations
  getAdminOverview: () => apiRequest<any>('/api/admin/overview'),

  saveModule: (payload: any) =>
    apiRequest<{ module: any }>('/api/admin/modules', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteModule: (moduleId: number) =>
    apiRequest<{ success: boolean }>(`/api/admin/modules/${moduleId}`, {
      method: 'DELETE',
    }),

  saveSubject: (payload: any) =>
    apiRequest<{ subject: any }>('/api/admin/subjects', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  saveLecture: (payload: any) =>
    apiRequest<{ lecture: any }>('/api/admin/lectures', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  saveQuestion: (payload: any) =>
    apiRequest<{ question: any }>('/api/admin/questions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteSubject: (subjectId: number) =>
    apiRequest<{ action: string; message: string }>(
      `/api/admin/subjects/${subjectId}`,
      {
        method: 'DELETE',
      }
    ),

  deleteLecture: (lectureId: number) =>
    apiRequest<{ action: string; message: string }>(
      `/api/admin/lectures/${lectureId}`,
      {
        method: 'DELETE',
      }
    ),

  deleteQuestionBank: (bankId: number) =>
    apiRequest<{ action: string; message: string }>(
      `/api/admin/question-banks/${bankId}`,
      {
        method: 'DELETE',
      }
    ),

  deleteOrArchiveQuestion: (questionId: number) =>
    apiRequest<{ action: string; message: string }>(
      `/api/admin/questions/${questionId}`,
      {
        method: 'DELETE',
      }
    ),

  deleteSessionAdmin: (sessionId: number) =>
    apiRequest<{ action: string; message: string }>(
      `/api/admin/sessions/${sessionId}`,
      {
        method: 'DELETE',
      }
    ),

  updateUserRole: (targetUid: string, role: 'student' | 'admin') =>
    apiRequest<{ user: UserProfile; message: string }>(
      `/api/admin/users/${encodeURIComponent(targetUid)}/role`,
      {
        method: 'PUT',
        body: JSON.stringify({ role }),
      }
    ),

  deleteUserAdmin: (targetUid: string) =>
    apiRequest<{ action: string; message: string }>(
      `/api/admin/users/${encodeURIComponent(targetUid)}`,
      {
        method: 'DELETE',
      }
    ),

  resetUserLectureProgressAdmin: (targetUid: string, lectureId: number) =>
    apiRequest<{
      success: boolean;
      message: string;
      lectureId: number;
      lectureTitle: string;
    }>(
      `/api/admin/users/${encodeURIComponent(targetUid)}/lectures/${lectureId}/reset`,
      {
        method: 'POST',
      }
    ),

  uploadPdf: async (
    file: File
  ): Promise<{ success: boolean; url: string; fileName: string; fileSize: number; id: number }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const fileData = reader.result as string;
          const result = await apiRequest<{
            success: boolean;
            url: string;
            fileName: string;
            fileSize: number;
            id: number;
          }>('/api/admin/upload-pdf', {
            method: 'POST',
            body: JSON.stringify({
              fileName: file.name,
              fileData,
              mimeType: file.type || 'application/pdf',
            }),
          });
          resolve(result);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('Failed to read PDF file for upload.'));
      reader.readAsDataURL(file);
    });
  },

  previewCsvImport: (csvContent: string, targetLectureId?: number) =>
    apiRequest<any>('/api/admin/import/preview', {
      method: 'POST',
      body: JSON.stringify({ csvContent, targetLectureId }),
    }),

  executeCsvImport: (fileName: string, csvContent: string, targetLectureId?: number) =>
    apiRequest<any>('/api/admin/import/execute', {
      method: 'POST',
      body: JSON.stringify({ fileName, csvContent, targetLectureId }),
    }),

  exportQuestionBankCsv: async (): Promise<string> => {
    const headers: Record<string, string> = {};
    if (inMemoryAuthToken) {
      headers['Authorization'] = `Bearer ${inMemoryAuthToken}`;
    }
    const res = await fetch('/api/admin/export-csv', { headers });
    if (!res.ok) throw new Error('Failed to export CSV backup.');
    return res.text();
  },
};
