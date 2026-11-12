import type { ImportImageFile, QuestionImage } from './question-images.ts';
import type { PracticalMockAttempt, PracticalMockCard, PracticalStationUpload } from './practical-mock.ts';
import type { DailyGoal, DailyGoalTarget, TournamentBoard } from './study-rewards.ts';
import { clearResetSessionStorage } from './session-progress.ts';
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

let inMemoryAuthToken: string | null = null;
try {
  if (typeof window !== 'undefined') inMemoryAuthToken = window.localStorage.getItem(STORAGE_TOKEN_KEY);
} catch { /* Storage can be unavailable in private or restricted browsers. */ }

function importRequestBody(payload: unknown): string {
  const body=JSON.stringify(payload);
  if(new TextEncoder().encode(body).byteLength>4*1024*1024)throw new Error('This JSON batch is too large to send. Split it into smaller JSON files.');
  return body;
}

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
  onRedirectError?: (error: Error) => void,
  onSessionUnavailable?: (error: Error) => void
): () => void {
  let cancelled = false;
  let hasResolvedAuthenticatedUser = false;
  let pendingListenerExchange: Promise<UserProfile | null> | null = null;
  let resolveInitialAuthState: ((user: any) => void) | null = null;
  const wasRedirectExpected = hasPendingRedirectMarker();
  const restoringServerSession = !wasRedirectExpected && Boolean(getAuthToken()?.startsWith('medatlas.'));
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
          if (cancelled || !firebaseUser || restoringServerSession) {
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
      // A saved MedAtlas session is independent of Google's redirect iframe/storage.
      // Only process Google first when a sign-in was explicitly started, or no
      // server session exists. The session is still verified by /api/auth/me below.
      if (!restoringServerSession) {
       try {
        const redirectUser = await api.handleGoogleRedirectResult();
        if (redirectUser) {
          emitAuthenticatedUser(redirectUser);
          return;
        }
      } catch (redirectErr: any) {
        console.warn('Google redirect resolution error:', redirectErr);
        // A failed Google attempt must not hide an independently valid login.
        if (!getAuthToken()?.startsWith('medatlas.')) {
          if (!cancelled) {
            onRedirectError?.(
              redirectErr instanceof Error
                ? redirectErr
                : new Error(redirectErr?.message || 'Google sign-in via redirect failed.')
            );
            if (!hasResolvedAuthenticatedUser) onUserResolved(null);
          }
          return;
        }
       }
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

      if (!cancelled && !hasResolvedAuthenticatedUser) {
        onUserResolved(null);
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.status === 403 || err?.message?.includes('401')) {
        setAuthToken(null);
        if (!cancelled && !hasResolvedAuthenticatedUser) onUserResolved(null);
      } else {
        console.warn('Error verifying existing MedAtlas session:', err);
        if (!cancelled && !hasResolvedAuthenticatedUser) {
          // Retain the token, route and drafts; only a server rejection ends a session.
          (onSessionUnavailable || onRedirectError)?.(new Error('Could not connect to MedAtlas. Your session is saved. Please retry when your connection returns.'));
        }
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
    // A rejected Google credential or an old in-flight request cannot invalidate
    // a different MedAtlas session established in the meantime (including another tab).
    if (res.status === 401 && currentToken &&
        headers.Authorization === `Bearer ${currentToken}` && getAuthToken() === currentToken) {
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
  faculty?: string;
  profileCompleted?: boolean;
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

export interface ReviewQuery { page: number; subjectId?: number; status: string }

const bookmarkListeners = new Set<() => void>();
export function subscribeToBookmarkChanges(listener: () => void): () => void {
  bookmarkListeners.add(listener);
  return () => { bookmarkListeners.delete(listener); };
}
const pendingBookmarks = new Map<number, Promise<{bookmarked: boolean; questionId: number}>>();
function saveBookmarkImmediately(questionId: number, note?: string, bookmarked?: boolean) {
  const pending = pendingBookmarks.get(questionId);
  if (pending) return pending;
  const request = apiRequest<{bookmarked: boolean; questionId: number}>('/api/bookmarks/toggle', {
    method: 'POST', keepalive: true, body: JSON.stringify({questionId, note, bookmarked}),
  }).then((result) => {
    for (const listener of bookmarkListeners) listener();
    return result;
  }).finally(() => { pendingBookmarks.delete(questionId); });
  pendingBookmarks.set(questionId, request);
  return request;
}

export const api = {
  getPracticalMocks: () => apiRequest<PracticalMockCard[]>('/api/practical-mocks'),
  publishPracticalMock: (id: string, title: string, stations: PracticalStationUpload[]) =>
    apiRequest<{ id: string }>('/api/practical-mocks', { method: 'POST', body: JSON.stringify({ id, title, stations }) }),
  startPracticalMock: (id: string) => apiRequest<PracticalMockAttempt>(`/api/practical-mocks/${id}/start`, { method: 'POST' }),
  getPracticalMock: (id: string) => apiRequest<PracticalMockAttempt>(`/api/practical-mocks/${id}`),
  savePracticalMockAnswer: (id: string, stationIndex: number, answer: string, revision: number) =>
    apiRequest<{ revision: number }>(`/api/practical-mocks/${id}/answer`, { method: 'PUT', body: JSON.stringify({ stationIndex, answer, revision }) }),
  gradePracticalMock: (id: string, signal: AbortSignal) =>
    apiRequest<PracticalMockAttempt>(`/api/practical-mocks/${id}/grade`, { method: 'POST', signal }),
  // Public Catalog
  getCatalog: () =>
    apiRequest<{
      subjects: any[];
      lectures: any[];
      totalPublishedQuestions: number;
    }>('/api/catalog'),

  // Authentication
  registerWithEmail: async (email: string, password: string, displayName: string, faculty?: string) => {
    const data = await apiRequest<{ token: string; user: UserProfile }>(
      '/api/auth/register',
      {
        method: 'POST',
        body: JSON.stringify({ email, password, displayName, faculty }),
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

      // Wait for Firebase authStateReady and check auth.currentUser directly without
      // requiring redirect storage markers to be present.
      if (typeof auth.authStateReady === 'function') {
        await auth.authStateReady();
      }
      if (auth.currentUser) {
        return await exchangeFirebaseUserForSession(auth.currentUser);
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
    apiRequest<{ token?: string; user: UserProfile }>('/api/auth/me', {
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : undefined,
    }),

  updateProfile: async (displayName: string, preferences?: Record<string, unknown>, faculty?: string) => {
    const data = await apiRequest<{ user: UserProfile }>('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({ displayName, preferences, faculty }),
    });
    setCachedUserProfile(data.user);
    return data;
  },

  getGeminiKeyStatus: () => apiRequest<{configured:boolean;maskedKey:string|null;updatedAt:string|null;available:boolean}>('/api/auth/gemini-key'),
  saveQuizShortAnswer:(sessionId:number,questionId:number,answer:string)=>apiRequest<any>(`/api/sessions/${sessionId}/short-answer`,{method:'POST',body:JSON.stringify({questionId,answer})}),
  gradeQuizShortAnswer:(sessionId:number,questionId:number)=>apiRequest<any>(`/api/sessions/${sessionId}/short-answer/grade`,{method:'POST',body:JSON.stringify({questionId,consent:true})}),
  saveAndGradeQuizShortAnswer:(sessionId:number,questionId:number,answer:string)=>apiRequest<any>(`/api/sessions/${sessionId}/short-answer/grade`,{method:'POST',body:JSON.stringify({questionId,answer,consent:true})}),
  shortAnswerCatalog: () => apiRequest<any>('/api/short-answers/catalog'),
  shortAnswerQuestions: (lectureId:number,after?:number) => apiRequest<any>(`/api/short-answers/questions?lectureId=${lectureId}${after?'&after='+after:''}`),
  shortAnswerHistory: (before?:number) => apiRequest<any>('/api/short-answers/history'+(before?'?before='+before:'')),
  saveShortAnswer: (questionId:number,answer:string) => apiRequest<any>('/api/short-answers/answers',{method:'POST',body:JSON.stringify({questionId,answer})}),
  getShortAnswer: (id:number) => apiRequest<any>(`/api/short-answers/answers/${id}`),
  gradeShortAnswer: (id:number) => apiRequest<any>(`/api/short-answers/answers/${id}/grade`,{method:'POST',body:JSON.stringify({consent:true})}),
  saveGeminiKey: (apiKey:string) => apiRequest<{configured:boolean;maskedKey:string|null;updatedAt:string|null;available:boolean}>('/api/auth/gemini-key',{method:'PUT',body:JSON.stringify({apiKey})}),
  removeGeminiKey: () => apiRequest<{configured:boolean;maskedKey:string|null;updatedAt:string|null;available:boolean}>('/api/auth/gemini-key',{method:'DELETE'}),

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
    specialTags?: string[];
    requestedCount?: number;
    shuffleQuestions?: boolean;
    shuffleOptions?: boolean;
    avoidRecent?: boolean;
    onlyMistakes?: boolean;
    timeLimitMinutes?: number | null;
  }) =>
    apiRequest<{ session: any; shortfallNotice: string | null }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ ...params, batchSize: 6 }),
    }),

  getSession: (sessionId: number, review = false) =>
    apiRequest<{ session: any }>(`/api/sessions/${sessionId}?batchSize=6${review ? "&review=1" : ""}`),

  getSessionQuestionBatch: (sessionId: number, offset: number) =>
    apiRequest<{ session: any }>(`/api/sessions/${sessionId}?batchSize=6&offset=${offset}`, {
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20000) : undefined,
    }),

  submitQuestionAnswer: (
    sessionId: number,
    questionId: number,
    selectedOption: string | null,
    lockAnswer: boolean,
    elapsedSeconds?: number,
    slim = true,
    matchingChoiceId?: string | null
  ) =>
    apiRequest<{ session: any }>(`/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      keepalive: true,
      body: JSON.stringify({
        questionId,
        selectedOption,
        lockAnswer,
        elapsedSeconds,
        slim,
        matchingChoiceId,
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
      body: JSON.stringify({ answers, elapsedSeconds, batchSize: 6 }),
    }),

  // Bookmarks & Dashboard
  getDashboard: () => apiRequest<any>('/api/dashboard'),
  getDailyGoal: () => apiRequest<DailyGoal>('/api/study-goal'),
  setDailyGoal: (target: DailyGoalTarget) => apiRequest<DailyGoal>('/api/study-goal', {
    method: 'PUT', body: JSON.stringify({ target }),
  }),
  getTournaments: (id?: number, signal?: AbortSignal) => apiRequest<TournamentBoard>(
    id ? `/api/tournaments?id=${id}` : '/api/tournaments', { signal },
  ),
  joinTournament: (id: number, nickname: string) => apiRequest<TournamentBoard>(`/api/tournaments/${id}/join`, {
    method: 'POST', body: JSON.stringify({ nickname }),
  }),
  createTournament: (event: { title: string; startsAt: string; endsAt: string }) => apiRequest<{ id: number }>('/api/admin/tournaments', {
    method: 'POST', body: JSON.stringify(event),
  }),

  getBookmarks: (savedOnly = false, review?: ReviewQuery) => {
    const query = new URLSearchParams({ view: savedOnly ? 'saved' : review ? 'answered' : 'all', page: String(review?.page || 1), pageSize: '25' });
    if (review?.subjectId) query.set('subjectId', String(review.subjectId));
    if (review?.status) query.set('status', review.status);
    return apiRequest<{ bookmarks: any[]; answeredQuestions: any[]; answeredCount: number; bookmarkCount: number;
      reviewPagination?: { page: number; pageSize: number; totalCount: number; hasMore: boolean } }>('/api/bookmarks?' + query);
  },

  toggleBookmark: saveBookmarkImmediately,

  reportQuestion: (questionId: number, reason: import('./question-reports.ts').QuestionReportReason) =>
    apiRequest<{ reported: boolean; alreadyReported: boolean }>('/api/question-reports', {
      method: 'POST', body: JSON.stringify({ questionId, reason }),
    }),

  getQuestionReports: () => apiRequest<{ reports: import('./question-reports.ts').QuestionReportItem[]; totalOpen: number }>('/api/admin/question-reports'),

  resolveQuestionReport: (reportId: number) => apiRequest<{ resolved: boolean }>(`/api/admin/question-reports/${reportId}/resolve`, { method: 'POST' }),

  resetLectureProgress: async (lectureId: number) => {
    const result = await apiRequest<{
      success: boolean;
      message: string;
      lectureId: number;
      lectureTitle: string;
      resetSessionIds?: number[];
    }>(`/api/lectures/${lectureId}/reset`, {
      method: 'POST',
    });
    if (result.success) clearResetSessionStorage(result.resetSessionIds || []);
    return result;
  },

  // Administrator Operations
  getAdminOverview: () => apiRequest<any>('/api/admin/overview'),
  setDocumentWatermarks: (watermarksEnabled: boolean) =>
    apiRequest<{documentSecurity:{watermarksEnabled:boolean}}>('/api/admin/document-security', {
      method:'PUT', body:JSON.stringify({watermarksEnabled}),
    }),
  getEgressStatus: () => apiRequest<any>('/api/admin/egress-status'),
  setEgressFallback: (forceFallback: boolean | null) =>
    apiRequest<any>('/api/admin/egress-fallback', {
      method: 'POST',
      body: JSON.stringify({ forceFallback }),
    }),

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
    file: File,
    lectureId?: number
  ): Promise<{ success: boolean; url: string; fileName: string; fileSize: number; id: number; lecture?: any }> => {
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
            lecture?: any;
          }>('/api/admin/upload-pdf', {
            method: 'POST',
            body: JSON.stringify({
              fileName: file.name,
              fileData,
              mimeType: file.type || 'application/pdf',
              lectureId,
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

  attachPdfToLecture: async (
    lectureId: number,
    fileOrUrl: File | string
  ): Promise<{ success: boolean; url: string | null; lecture: any; message: string }> => {
    if (typeof fileOrUrl === 'string') {
      return apiRequest<{ success: boolean; url: string | null; lecture: any; message: string }>(
        `/api/admin/lectures/${lectureId}/attach-pdf`,
        {
          method: 'POST',
          body: JSON.stringify({ pdfUrl: fileOrUrl }),
        }
      );
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const fileData = reader.result as string;
          const result = await apiRequest<{
            success: boolean;
            url: string | null;
            lecture: any;
            message: string;
          }>(`/api/admin/lectures/${lectureId}/attach-pdf`, {
            method: 'POST',
            body: JSON.stringify({
              fileName: fileOrUrl.name,
              fileData,
              mimeType: fileOrUrl.type || 'application/pdf',
            }),
          });
          resolve(result);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('Failed to read PDF file for upload.'));
      reader.readAsDataURL(fileOrUrl);
    });
  },

  uploadQuestionImage: async (file: File): Promise<QuestionImage> => {
    const token=getAuthToken();
    const response=await fetch('/api/admin/import/image?name='+encodeURIComponent(file.name),{
      method:'POST',headers:{'Content-Type':'application/octet-stream',...(token?{Authorization:`Bearer ${token}`}:{})},body:file,
    });
    const result=await response.json().catch(()=>({error:'Image upload failed. Please retry.'}));
    if(!response.ok)throw new Error(result.error || 'Image upload failed.');
    return result;
  },
  previewJsonImport: (jsonContent:string,targetLectureId?:number,imageFiles:ImportImageFile[]=[]) =>
    apiRequest<any>('/api/admin/import/preview',{method:'POST',body:importRequestBody({jsonContent,targetLectureId,imageFiles})}),
  executeJsonImport: (fileName:string,jsonContent:string,targetLectureId:number|undefined,rowOverrides:Record<number,{specialTags?:string;tags?:string}>|undefined,imageFiles:ImportImageFile[],uploadedImages:Record<string,QuestionImage>) =>
    apiRequest<any>('/api/admin/import/execute',{method:'POST',body:importRequestBody({fileName,jsonContent,targetLectureId,rowOverrides,imageFiles,uploadedImages})}),

  previewCsvImport: (csvContent: string, targetLectureId?: number) =>
    apiRequest<any>('/api/admin/import/preview', {
      method: 'POST',
      body: JSON.stringify({ csvContent, targetLectureId }),
    }),

  executeCsvImport: (
    fileName: string,
    csvContent: string,
    targetLectureId?: number,
    rowOverrides?: Record<number, { specialTags?: string; tags?: string }>
  ) =>
    apiRequest<any>('/api/admin/import/execute', {
      method: 'POST',
      body: JSON.stringify({ fileName, csvContent, targetLectureId, rowOverrides }),
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
