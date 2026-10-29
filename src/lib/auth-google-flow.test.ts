import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

// Set up mock window and storage environment for client auth tests
const mockLocalStorage: Record<string, string> = {};
const mockSessionStorage: Record<string, string> = {};

(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => mockLocalStorage[k] ?? null,
    setItem: (k: string, v: string) => {
      mockLocalStorage[k] = String(v);
    },
    removeItem: (k: string) => {
      delete mockLocalStorage[k];
    },
    clear: () => {
      for (const k of Object.keys(mockLocalStorage)) delete mockLocalStorage[k];
    },
  },
  sessionStorage: {
    getItem: (k: string) => mockSessionStorage[k] ?? null,
    setItem: (k: string, v: string) => {
      mockSessionStorage[k] = String(v);
    },
    removeItem: (k: string) => {
      delete mockSessionStorage[k];
    },
    clear: () => {
      for (const k of Object.keys(mockSessionStorage)) delete mockSessionStorage[k];
    },
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
let mockOnAuthStateChangedImpl:
  | ((auth: any, next: (user: any) => void, error?: (err: Error) => void) => () => void)
  | null = null;
let redirectInitiated = false;
let signedOut = false;

import {
  api,
  getAuthToken,
  setAuthToken,
  getCachedUserProfile,
  setCachedUserProfile,
  subscribeToAuthChanges,
  setFirebaseClientAuthHandlersForTests,
} from './api.ts';
import { auth } from './firebase.ts';

function resetTestEnvironment() {
  (globalThis as any).window.localStorage.clear();
  (globalThis as any).window.sessionStorage.clear();
  setAuthToken(null);
  setCachedUserProfile(null);
  (auth as any).currentUser = null;
  mockPopupResult = null;
  mockPopupError = null;
  mockRedirectResult = null;
  mockRedirectError = null;
  mockOnAuthStateChangedImpl = null;
  redirectInitiated = false;
  signedOut = false;

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
      (auth as any).currentUser = null;
    },
    onAuthStateChanged: (authObj: any, next: (user: any) => void, errCb?: (err: Error) => void) => {
      if (mockOnAuthStateChangedImpl) {
        return mockOnAuthStateChangedImpl(authObj, next, errCb);
      }
      queueMicrotask(() => next((authObj as any)?.currentUser ?? null));
      return () => {};
    },
  });
}

resetTestEnvironment();

test('1. Popup Sign-In Success: Uses public user.getIdToken() and establishes MedAtlas session', async () => {
  resetTestEnvironment();

  let getIdTokenCalled = false;
  mockPopupResult = {
    user: {
      uid: 'google_test_uid_123',
      email: 'student@university.edu',
      displayName: 'Student One',
      getIdToken: async () => {
        getIdTokenCalled = true;
        return 'mock_google_id_token_valid';
      },
    },
  };

  mockFetchHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') {
      const authHeader = (init?.headers as any)?.['Authorization'];
      assert.equal(authHeader, 'Bearer mock_google_id_token_valid');
      // Verify raw Firebase token was NOT persisted into localStorage before backend verification
      assert.equal(mockLocalStorage['medatlas_session_token'], undefined);
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

  assert.equal(getIdTokenCalled, true, 'Must use public user.getIdToken() API');
  assert.equal(user.email, 'student@university.edu');
  assert.equal(user.displayName, 'Student One');
  assert.equal(getAuthToken(), 'medatlas.hmac.server_session_token_abc');
  assert.equal(getCachedUserProfile()?.email, 'student@university.edu');
  assert.equal(signedOut, true, 'Client Firebase auth must be signed out after session establishment');
});

test('2. Popup Blocked: Surfaces auth/popup-blocked cleanly so UI can trigger redirect fallback', async () => {
  resetTestEnvironment();
  mockPopupError = {
    code: 'auth/popup-blocked',
    message: 'Unable to establish a connection with the popup.',
  };

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

test('3. Redirect Initiation: Sets pending redirect markers in storage and calls signInWithRedirect', async () => {
  resetTestEnvironment();

  await api.loginWithGoogleRedirect();

  assert.equal(redirectInitiated, true, 'signInWithRedirect should be invoked');
  assert.equal(mockSessionStorage['medatlas_google_redirect_in_progress'], 'true');
  assert.equal(mockLocalStorage['medatlas_google_redirect_in_progress'], 'true');
});

test('4. Redirect Return (getRedirectResult returns user): Exchanges token and establishes MedAtlas session', async () => {
  resetTestEnvironment();
  mockSessionStorage['medatlas_google_redirect_in_progress'] = 'true';
  mockLocalStorage['medatlas_google_redirect_in_progress'] = 'true';

  mockRedirectResult = {
    user: {
      uid: 'google_redirect_uid_456',
      email: 'resident@hospital.org',
      displayName: 'Dr. Resident',
      getIdToken: async () => 'mock_redirect_id_token_xyz',
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
  assert.equal(mockLocalStorage['medatlas_google_redirect_in_progress'], undefined);
  assert.equal(signedOut, true);
});

test('5. Redirect Return (getRedirectResult returns null, auth.currentUser restored): Recovers session', async () => {
  resetTestEnvironment();
  mockSessionStorage['medatlas_google_redirect_in_progress'] = 'true';
  mockRedirectResult = null;

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
});

test('6. Redirect Return (onAuthStateChanged restores user after getRedirectResult returns null): Resolves authenticated user', async () => {
  resetTestEnvironment();
  mockSessionStorage['medatlas_google_redirect_in_progress'] = 'true';
  mockRedirectResult = null;
  (auth as any).currentUser = null;

  mockOnAuthStateChangedImpl = (_authObj, next) => {
    setTimeout(() => {
      next({
        uid: 'google_listener_uid_600',
        getIdToken: async () => 'mock_listener_token_600',
      });
    }, 10);
    return () => {};
  };

  mockFetchHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') {
      const authHeader = (init?.headers as any)?.['Authorization'];
      assert.equal(authHeader, 'Bearer mock_listener_token_600');
      return new Response(
        JSON.stringify({
          token: 'medatlas.hmac.listener_session_600',
          user: {
            id: 600,
            uid: 'google_listener_uid_600',
            email: 'listener@hospital.org',
            displayName: 'Listener User',
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

  const emissions: Array<any> = [];
  await new Promise<void>((resolve, reject) => {
    const unsub = subscribeToAuthChanges(
      (user) => {
        emissions.push(user);
        if (user) {
          unsub();
          resolve();
        }
      },
      (err) => {
        unsub();
        reject(err);
      }
    );
  });

  assert.equal(emissions.length, 1, 'Should only emit once with the authenticated user');
  assert.equal(emissions[0]?.email, 'listener@hospital.org');
  assert.equal(getAuthToken(), 'medatlas.hmac.listener_session_600');
});

test('7. Race Condition: Early null auth check does not overwrite or block in-flight redirect recovery', async () => {
  resetTestEnvironment();
  mockSessionStorage['medatlas_google_redirect_in_progress'] = 'true';

  // Simulate onAuthStateChanged firing null immediately while getRedirectResult is still resolving
  mockOnAuthStateChangedImpl = (_authObj, next) => {
    next(null);
    return () => {};
  };

  mockRedirectResult = {
    user: {
      uid: 'google_race_uid_700',
      getIdToken: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return 'mock_race_token_700';
      },
    },
  };

  mockFetchHandler = async (url: string) => {
    if (url === '/api/auth/me') {
      return new Response(
        JSON.stringify({
          token: 'medatlas.hmac.race_session_700',
          user: {
            id: 700,
            uid: 'google_race_uid_700',
            email: 'race@hospital.org',
            displayName: 'Race Winner',
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

  const resolvedUsers: Array<any> = [];
  await new Promise<void>((resolve) => {
    const unsub = subscribeToAuthChanges((user) => {
      resolvedUsers.push(user);
      if (user) {
        unsub();
        resolve();
      }
    });
  });

  assert.equal(resolvedUsers.length, 1, 'onUserResolved must not be called with null before redirect recovery finishes');
  assert.equal(resolvedUsers[0]?.email, 'race@hospital.org');
});

test('8. Deduplication: Concurrent getRedirectResult and onAuthStateChanged for same user call /api/auth/me only once', async () => {
  resetTestEnvironment();
  mockSessionStorage['medatlas_google_redirect_in_progress'] = 'true';

  const sharedFirebaseUser = {
    uid: 'google_dedup_uid_800',
    getIdToken: async () => 'mock_dedup_token_800',
  };

  mockRedirectResult = { user: sharedFirebaseUser };
  mockOnAuthStateChangedImpl = (_authObj, next) => {
    next(sharedFirebaseUser);
    return () => {};
  };

  let authMeRequestCount = 0;
  mockFetchHandler = async (url: string) => {
    if (url === '/api/auth/me') {
      authMeRequestCount += 1;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({
          token: 'medatlas.hmac.dedup_session_800',
          user: {
            id: 800,
            uid: 'google_dedup_uid_800',
            email: 'dedup@hospital.org',
            displayName: 'Dedup User',
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

  let userCallbackCount = 0;
  await new Promise<void>((resolve) => {
    const unsub = subscribeToAuthChanges((user) => {
      userCallbackCount += 1;
      assert.equal(user?.email, 'dedup@hospital.org');
      setTimeout(() => {
        unsub();
        resolve();
      }, 25);
    });
  });

  assert.equal(authMeRequestCount, 1, '/api/auth/me must only be called once for concurrent recovery paths');
  assert.equal(userCallbackCount, 1, 'onUserResolved must only be called once');
});

test('9. Backend /api/auth/me Failure: Does not store raw Firebase token and reports error cleanly', async () => {
  resetTestEnvironment();
  mockSessionStorage['medatlas_google_redirect_in_progress'] = 'true';
  mockRedirectResult = {
    user: {
      uid: 'google_fail_uid_900',
      getIdToken: async () => 'raw_firebase_jwt_should_never_be_saved',
    },
  };

  mockFetchHandler = async (url: string) => {
    if (url === '/api/auth/me') {
      return new Response(
        JSON.stringify({ error: 'Database connection failed' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('Not found', { status: 404 });
  };

  let capturedError: any = null;
  const resolvedUser = await new Promise<any>((resolve) => {
    const unsub = subscribeToAuthChanges(
      (user) => {
        unsub();
        resolve(user);
      },
      (err) => {
        capturedError = err;
      }
    );
  });

  assert.equal(resolvedUser, null);
  assert.notEqual(capturedError, null);
  assert.match(String(capturedError?.message), /Database connection failed/);
  assert.equal(getAuthToken(), null, 'Raw Firebase token must never be stored as the MedAtlas session token');
});

test('10. Expired or Invalid Existing Session Token: Clears token and cached profile and does not trust cache alone', async () => {
  resetTestEnvironment();
  // Seed a cached profile and an expired medatlas.* session token
  setAuthToken('medatlas.expired.token');
  setCachedUserProfile({
    id: 999,
    uid: 'stale_uid',
    email: 'stale@hospital.org',
    displayName: 'Stale Cached User',
    role: 'student',
    subscriptionTier: 'free',
    subscriptionStatus: 'active',
    emailVerified: true,
    preferences: '{}',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  mockFetchHandler = async (url: string) => {
    if (url === '/api/auth/me') {
      return new Response(
        JSON.stringify({ error: 'Session expired' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('Not found', { status: 404 });
  };

  const resolvedUser = await new Promise<any>((resolve) => {
    const unsub = subscribeToAuthChanges((user) => {
      unsub();
      resolve(user);
    });
  });

  assert.equal(resolvedUser, null, 'Must not authenticate from cached profile when token is rejected');
  assert.equal(getAuthToken(), null, 'Expired token must be cleared');
  assert.equal(getCachedUserProfile(), null, 'Stale cached user profile must be cleared');
});

test('11. Redirect Cancellation: Surfaces error and cleans up pending redirect markers', async () => {
  resetTestEnvironment();
  mockSessionStorage['medatlas_google_redirect_in_progress'] = 'true';
  mockLocalStorage['medatlas_google_redirect_in_progress'] = 'true';
  mockRedirectError = {
    code: 'auth/redirect-cancelled-by-user',
    message: 'The redirect operation has been cancelled.',
  };

  await assert.rejects(
    async () => {
      await api.handleGoogleRedirectResult();
    },
    (err: any) => {
      assert.equal(err.code, 'auth/redirect-cancelled-by-user');
      assert.equal(mockSessionStorage['medatlas_google_redirect_in_progress'], undefined);
      assert.equal(mockLocalStorage['medatlas_google_redirect_in_progress'], undefined);
      return true;
    }
  );
});

test('12. Unauthorized Domain Error: Surfaces auth/unauthorized-domain cleanly', async () => {
  resetTestEnvironment();
  mockPopupError = {
    code: 'auth/unauthorized-domain',
    message: 'This domain is not authorized for OAuth operations.',
  };

  await assert.rejects(
    async () => {
      await api.loginWithGooglePopup();
    },
    (err: any) => {
      assert.equal(err.code, 'auth/unauthorized-domain');
      return true;
    }
  );
});

test('13. Normal Startup with No Pending Redirect: Resolves null cleanly without errors', async () => {
  resetTestEnvironment();

  let redirectErrorCalled = false;
  const resolvedUser = await new Promise<any>((resolve) => {
    const unsub = subscribeToAuthChanges(
      (user) => {
        unsub();
        resolve(user);
      },
      () => {
        redirectErrorCalled = true;
      }
    );
  });

  assert.equal(resolvedUser, null);
  assert.equal(redirectErrorCalled, false);
});

test('14. Email & Password Authentication: Register and Login continue to work properly', async () => {
  resetTestEnvironment();
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

test('15. REGRESSION: Google authentication succeeds, browser returns to app, and authenticated workspace state is resolved instead of falling back to public homepage', async () => {
  resetTestEnvironment();

  // Step 1: User initiates Google redirect sign-in
  await api.loginWithGoogleRedirect();
  assert.equal(mockSessionStorage['medatlas_google_redirect_in_progress'], 'true');

  // Step 2: Browser returns from Google to MedAtlas.
  // Simulate the exact failure scenario where getRedirectResult returns null (or is delayed)
  // while Firebase restores the user via onAuthStateChanged after an initial null emission.
  mockRedirectResult = null;
  mockOnAuthStateChangedImpl = (_authObj, next) => {
    // Firebase emits null before IndexedDB/iframe persistence finishes hydrating
    queueMicrotask(() => next(null));
    // Then emits the authenticated Google user a few milliseconds later
    setTimeout(() => {
      next({
        uid: 'google_regression_uid_2026',
        email: 'doctor@medatlas.org',
        displayName: 'Dr. MedAtlas',
        getIdToken: async () => 'firebase_id_token_regression_2026',
      });
    }, 15);
    return () => {};
  };

  mockFetchHandler = async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') {
      const authHeader = (init?.headers as any)?.['Authorization'];
      assert.equal(authHeader, 'Bearer firebase_id_token_regression_2026');
      return new Response(
        JSON.stringify({
          token: 'medatlas.hmac.regression_verified_session_2026',
          user: {
            id: 2026,
            uid: 'google_regression_uid_2026',
            email: 'doctor@medatlas.org',
            displayName: 'Dr. MedAtlas',
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

  const stateTransitions: Array<any> = [];
  await new Promise<void>((resolve, reject) => {
    const unsub = subscribeToAuthChanges(
      (resolvedUser) => {
        stateTransitions.push(resolvedUser);
        if (resolvedUser) {
          unsub();
          resolve();
        }
      },
      (err) => {
        unsub();
        reject(err);
      }
    );
  });

  // Verify the app NEVER resolved `null` (which would render PublicLanding) and instead resolved the authenticated user
  assert.equal(stateTransitions.length, 1);
  assert.notEqual(stateTransitions[0], null, 'Must not render PublicLanding (user=null) when Google auth succeeds');
  assert.equal(stateTransitions[0].uid, 'google_regression_uid_2026');
  assert.equal(stateTransitions[0].email, 'doctor@medatlas.org');
  assert.equal(getAuthToken(), 'medatlas.hmac.regression_verified_session_2026');
  assert.equal(getCachedUserProfile()?.uid, 'google_regression_uid_2026');
});
