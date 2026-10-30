import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

const resolvedProjectId =
  process.env.FIREBASE_PROJECT_ID?.trim() ||
  process.env.GCLOUD_PROJECT?.trim() ||
  firebaseConfig.projectId;

function getFirebaseAdminCredential() {
  const serviceAccountJson =
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountJson) {
    try {
      const parsed = JSON.parse(serviceAccountJson);
      return cert(parsed);
    } catch (e) {
      console.warn('[FIREBASE ADMIN INIT] Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY JSON:', e);
    }
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();

  if (clientEmail && privateKey) {
    return cert({
      projectId: resolvedProjectId,
      clientEmail,
      privateKey,
    });
  }

  return undefined;
}

let authInstance: Auth | null = null;
try {
  if (!getApps().length) {
    const credential = getFirebaseAdminCredential();
    initializeApp({
      projectId: resolvedProjectId,
      ...(credential ? { credential } : {}),
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
