import {
  signInWithPopup,
  signOut,
  browserPopupRedirectResolver,
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
  return inMemoryAuthToken;
}

export function subscribeToAuthChanges(
  onUserResolved: (user: UserProfile | null) => void
): () => void {
  let cancelled = false;

  (async () => {
    try {
      const existingToken = getAuthToken();
      if (existingToken) {
        const data = await api.getCurrentUser();
        if (data.token) {
          setAuthToken(data.token);
        }
        setCachedUserProfile(data.user);
        if (!cancelled) onUserResolved(data.user);
      } else {
        if (!cancelled) onUserResolved(null);
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.message?.includes('401')) {
        setAuthToken(null);
        if (!cancelled) onUserResolved(null);
      } else {
        console.warn('Transient network delay during session verification:', err);
        if (!cancelled) onUserResolved(getCachedUserProfile());
      }
    }
  })();

  return () => {
    cancelled = true;
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

  if (inMemoryAuthToken) {
    headers['Authorization'] = `Bearer ${inMemoryAuthToken}`;
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

  loginWithGooglePopup: async () => {
    // Ensure any previous in-memory Firebase state is cleared before popup
    await signOut(auth).catch(() => {});
    const result = await signInWithPopup(
      auth,
      googleAuthProvider,
      browserPopupRedirectResolver
    );
    // Extract the freshly issued ID token directly from the signInWithIdp response
    // WITHOUT calling getIdToken(true), which would hit securetoken.googleapis.com
    const idToken: string =
      (result as any)?._tokenResponse?.idToken ||
      (result.user as any)?.stsTokenManager?.accessToken ||
      (await result.user.getIdToken(false));
    setAuthToken(idToken);
    const data = await apiRequest<{ token?: string; user: UserProfile }>('/api/auth/me');
    if (data.token) {
      setAuthToken(data.token);
    }
    setCachedUserProfile(data.user);
    // Immediately clear in-memory Firebase client user so Firebase never attempts
    // a background refresh against securetoken.googleapis.com after 1 hour
    await signOut(auth).catch(() => {});
    return data.user;
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
    setAuthToken(null);
    try {
      await signOut(auth);
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
