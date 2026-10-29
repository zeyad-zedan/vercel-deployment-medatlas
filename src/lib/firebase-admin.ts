import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

let authInstance: Auth | null = null;
try {
  if (!getApps().length) {
    initializeApp({
      projectId: firebaseConfig.projectId,
    });
  }
  authInstance = getAuth();
} catch (err) {
  console.warn('[FIREBASE ADMIN INIT WARNING] Could not initialize Firebase Admin SDK:', err);
}

export const adminAuth = new Proxy({} as Auth, {
  get(_target, prop) {
    if (authInstance) {
      const val = (authInstance as any)[prop];
      return typeof val === 'function' ? val.bind(authInstance) : val;
    }
    return () => Promise.reject(new Error(`Firebase Admin SDK unavailable (property: ${String(prop)})`));
  },
});
