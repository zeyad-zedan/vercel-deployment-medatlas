import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

// Set up mock window and storage environment for client auth tests
const mockLocalStorage: Record<string, string> = {};
const mockSessionStorage: Record<string, string> = {};

(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => mockLocalStorage[k] ?? null,
    setItem: (k: string, v: string) => { mockLocalStorage[k] = String(v); },
    removeItem: (k: string) => { delete mockLocalStorage[k]; },
    clear: () => { for (const k of Object.keys(mockLocalStorage)) delete mockLocalStorage[k]; },
  },
  sessionStorage: {
    getItem: (k: string) => mockSessionStorage[k] ?? null,
    setItem: (k: string, v: string) => { mockSessionStorage[k] = String(v); },
    removeItem: (k: string) => { delete mockSessionStorage[k]; },
    clear: () => { for (const k of Object.keys(mockSessionStorage)) delete mockSessionStorage[k]; },
  },
  location: {
    origin: 'https://medatlas-exam.vercel.app',
    pathname: '/',
    search: '',
  },
};

(globalThis as any).localStorage = (globalThis as any).window.localStorage;
(globalThis as any).sessionStorage = (globalThis as any).window.sessionStorage;

// Mock fetch for apiRequest
let mockFetchHandler: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
(globalThis as any).fetch = (url: string, init?: RequestInit) => {
  if (mockFetchHandler) {
    return mockFetchHandler(url, init);
  }
  return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
};

// Mock handlers state
let mockPopupResult: any = null;
let mockPopupError: any = null;
let mockRedirectResult: any = null;
let mockRedirectError: any = null;
let redirectInitiated = false;
let signedOut = false;

import {
  api,
  getAuthToken,
  getCachedUserProfile,
  subscribeToAuthChanges,
  setFirebaseClientAuthHandlersForTests,
} from './api.ts';
import { auth } from './firebase.ts';

// Connect test handlers
setFirebaseClientAuthHandlersForTests({
  signInWithPopup: async () => {
    if (mockPopupError) throw mockPopupError;
    return mockPopupResult;
  },
  signInWithRedirect: async () => {
    redirectInitiated = true;
  },
  getRedirectResult: async () => {
    if (mockRedirectError) throw mockRedirectError;
    return mockRedirectResult;
  },
  signOut: async () => {
    signedOut = true;
  },
});

test('1. Google Popup Sign-In: Successful authentication establishes session and profile', async () => {
  delete mockLocalStorage['medatlas_session_token'];
  delete mockLocalStorage['medatlas_cached_user_profile'];
  mockPopupError = null;
  signedOut = false;

  mockPopupResult = {
    user: {
      uid: 'google_test_uid_123',
      email: 'student@university.edu',
      displayName: 'Student One',
      getIdToken: async () => 'mock_google_id_token_valid',
    },
    _tokenResponse: {
      idToken: 'mock_google_id_token_valid',
    },
  };

  mockFetchHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') {
      const authHeader = (init?.headers as any)?.['Authorization'];
      assert.equal(authHeader, 'Bearer mock_google_id_token_valid');
      return new Response(
        JSON.stringify({
          token: 'medatlas.hmac.server_session_token_abc',
          user: {
            id: 101,
            uid: 'google_test_uid_123',
            email: 'student@university.edu',
            displayName: 'Student One',
            role: 'student',
            subscriptionTier: 'free',
            subscriptionStatus: 'active',
            emailVerified: true,
            preferences: '{}',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  const user = await api.loginWithGooglePopup();

  assert.equal(user.email, 'student@university.edu');
  assert.equal(user.displayName, 'Student One');
  assert.equal(getAuthToken(), 'medatlas.hmac.server_session_token_abc');
  assert.equal(getCachedUserProfile()?.email, 'student@university.edu');
  assert.equal(signedOut, true, 'Client Firebase auth must be signed out to prevent background token polling');
});

test('2. Google Popup Sign-In: Detects popup-blocked error cleanly without crashing', async () => {
  mockPopupResult = null;
  mockPopupError = { code: 'auth/popup-blocked', message: 'Unable to establish a connection with the popup.' };

  await assert.rejects(
    async () => {
      await api.loginWithGooglePopup();
    },
    (err: any) => {
      assert.equal(err.code, 'auth/popup-blocked');
      return true;
    }
  );
});

test('3. Google Redirect Sign-In: Initiates redirect and sets pending state in sessionStorage', async () => {
  redirectInitiated = false;
  delete mockSessionStorage['medatlas_google_redirect_in_progress'];

  await api.loginWithGoogleRedirect();

  assert.equal(redirectInitiated, true, 'signInWithRedirect should be invoked');
  assert.equal(mockSessionStorage['medatlas_google_redirect_in_progress'], 'true');
});

test('4. Google Redirect Result: Successfully processes return from Google and establishes MedAtlas session', async () => {
  mockSessionStorage['medatlas_google_redirect_in_progress'] = 'true';
  mockRedirectError = null;
  signedOut = false;

  mockRedirectResult = {
    user: {
      uid: 'google_redirect_uid_456',
      email: 'resident@hospital.org',
      displayName: 'Dr. Resident',
      getIdToken: async () => 'mock_redirect_id_token_xyz',
    },
    _tokenResponse: {
      idToken: 'mock_redirect_id_token_xyz',
    },
  };

  mockFetchHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') {
      const authHeader = (init?.headers as any)?.['Authorization'];
      assert.equal(authHeader, 'Bearer mock_redirect_id_token_xyz');
      return new Response(
        JSON.stringify({
          token: 'medatlas.hmac.server_session_token_redirect_999',
          user: {
            id: 202,
            uid: 'google_redirect_uid_456',
            email: 'resident@hospital.org',
            displayName: 'Dr. Resident',
            role: 'student',
            subscriptionTier: 'premium',
            subscriptionStatus: 'active',
            emailVerified: true,
            preferences: '{}',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  const user = await api.handleGoogleRedirectResult();

  assert.notEqual(user, null);
  assert.equal(user?.email, 'resident@hospital.org');
  assert.equal(getAuthToken(), 'medatlas.hmac.server_session_token_redirect_999');
  assert.equal(mockSessionStorage['medatlas_google_redirect_in_progress'], undefined);
  assert.equal(signedOut, true);
});

test('5. Google Redirect Result: Returns null when no redirect was pending without throwing', async () => {
  delete mockSessionStorage['medatlas_google_redirect_in_progress'];
  mockRedirectResult = null;
  mockRedirectError = null;

  const result = await api.handleGoogleRedirectResult();
  assert.equal(result, null);
});

test('5b. Google Redirect Result: Recovers session when getRedirectResult returns null but auth.currentUser is present', async () => {
  mockSessionStorage['medatlas_google_redirect_in_progress'] = 'true';
  mockRedirectResult = null;
  mockRedirectError = null;

  // Simulate Firebase auth.currentUser populated asynchronously after redirect
  (auth as any).currentUser = {
    uid: 'google_recovered_uid_888',
    getIdToken: async () => 'mock_recovered_id_token_888',
  };

  mockFetchHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') {
      const authHeader = (init?.headers as any)?.['Authorization'];
      assert.equal(authHeader, 'Bearer mock_recovered_id_token_888');
      return new Response(
        JSON.stringify({
          token: 'medatlas.hmac.server_session_token_recovered_888',
          user: {
            id: 888,
            uid: 'google_recovered_uid_888',
            email: 'recovered@hospital.org',
            displayName: 'Recovered User',
            role: 'student',
            subscriptionTier: 'free',
            subscriptionStatus: 'active',
            emailVerified: true,
            preferences: '{}',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('Not found', { status: 404 });
  };

  const user = await api.handleGoogleRedirectResult();
  assert.notEqual(user, null);
  assert.equal(user?.email, 'recovered@hospital.org');
  assert.equal(getAuthToken(), 'medatlas.hmac.server_session_token_recovered_888');

  // Cleanup
  (auth as any).currentUser = null;
});

test('6. Google Redirect Result: Handles redirect cancellation and surfaces error while cleaning up state', async () => {
  mockSessionStorage['medatlas_google_redirect_in_progress'] = 'true';
  mockRedirectResult = null;
  mockRedirectError = { code: 'auth/redirect-cancelled-by-user', message: 'The redirect operation has been cancelled.' };

  await assert.rejects(
    async () => {
      await api.handleGoogleRedirectResult();
    },
    (err: any) => {
      assert.equal(err.code, 'auth/redirect-cancelled-by-user');
      assert.equal(mockSessionStorage['medatlas_google_redirect_in_progress'], undefined);
      return true;
    }
  );
});

test('7. Email & Password Authentication: Register and Login continue to work properly', async () => {
  mockFetchHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/register') {
      const body = JSON.parse(init?.body as string);
      assert.equal(body.email, 'newstudent@med.edu');
      return new Response(
        JSON.stringify({
          token: 'medatlas.hmac.register_token_111',
          user: {
            id: 303,
            uid: 'usr_local_test_303',
            email: 'newstudent@med.edu',
            displayName: 'New Student',
            role: 'student',
            subscriptionTier: 'free',
            subscriptionStatus: 'active',
            emailVerified: true,
            preferences: '{}',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url === '/api/auth/login') {
      const body = JSON.parse(init?.body as string);
      assert.equal(body.email, 'newstudent@med.edu');
      return new Response(
        JSON.stringify({
          token: 'medatlas.hmac.login_token_222',
          user: {
            id: 303,
            uid: 'usr_local_test_303',
            email: 'newstudent@med.edu',
            displayName: 'New Student',
            role: 'student',
            subscriptionTier: 'free',
            subscriptionStatus: 'active',
            emailVerified: true,
            preferences: '{}',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  const regUser = await api.registerWithEmail('newstudent@med.edu', 'SecurePassword123!', 'New Student');
  assert.equal(regUser.email, 'newstudent@med.edu');
  assert.equal(getAuthToken(), 'medatlas.hmac.register_token_111');

  const loginUser = await api.loginWithEmail('newstudent@med.edu', 'SecurePassword123!');
  assert.equal(loginUser.email, 'newstudent@med.edu');
  assert.equal(getAuthToken(), 'medatlas.hmac.login_token_222');
});

test('8. subscribeToAuthChanges: Resolves redirect user first on startup', async () => {
  mockSessionStorage['medatlas_google_redirect_in_progress'] = 'true';
  mockRedirectError = null;
  mockRedirectResult = {
    user: {
      uid: 'google_redirect_sub_789',
      email: 'substudent@med.edu',
      displayName: 'Sub Student',
      getIdToken: async () => 'mock_sub_token',
    },
    _tokenResponse: { idToken: 'mock_sub_token' },
  };

  mockFetchHandler = async (url: string) => {
    if (url === '/api/auth/me') {
      return new Response(
        JSON.stringify({
          token: 'medatlas.hmac.sub_resolved_token',
          user: {
            id: 404,
            uid: 'google_redirect_sub_789',
            email: 'substudent@med.edu',
            displayName: 'Sub Student',
            role: 'student',
            subscriptionTier: 'free',
            subscriptionStatus: 'active',
            emailVerified: true,
            preferences: '{}',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  await new Promise<void>((resolve) => {
    const unsub = subscribeToAuthChanges((user) => {
      if (user) {
        assert.equal(user.email, 'substudent@med.edu');
        unsub();
        resolve();
      }
    });
  });
});
