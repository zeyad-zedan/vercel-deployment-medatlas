import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  initializeAuth,
  getAuth,
  GoogleAuthProvider,
  browserLocalPersistence,
  browserSessionPersistence,
  indexedDBLocalPersistence,
  type Auth,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

let authInstance: Auth;
try {
  // Use official browser storage persistence hierarchy (IndexedDB -> localStorage -> sessionStorage)
  // so redirect authentication results survive cross-page navigation.
  authInstance = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
  });
} catch {
  authInstance = getAuth(app);
}

export const auth = authInstance;
export const googleAuthProvider = new GoogleAuthProvider();
// Prompt account selection cleanly without force-reauthenticating active sessions
googleAuthProvider.setCustomParameters({
  prompt: 'select_account',
});
