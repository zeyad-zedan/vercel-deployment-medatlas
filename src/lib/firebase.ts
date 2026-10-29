import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// getAuth(app) automatically initializes Firebase Auth with:
// - popupRedirectResolver: browserPopupRedirectResolver
// - persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence]
export const auth = getAuth(app);

export const googleAuthProvider = new GoogleAuthProvider();
// Prompt account selection cleanly without force-reauthenticating active sessions
googleAuthProvider.setCustomParameters({
  prompt: 'select_account',
});
