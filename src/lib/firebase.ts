import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// getAuth(app) automatically initializes Firebase Auth with:
// - popupRedirectResolver: browserPopupRedirectResolver
// - persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence]
export const auth = getAuth(app);

// Pre-warm Firebase Auth state listener and internal resolvers as soon as the app loads
// so that when the user clicks 'Continue with Google', the popup is opened synchronously
// without triggering browser popup-blocking timeouts.
if (typeof window !== 'undefined' && typeof auth.authStateReady === 'function') {
  auth.authStateReady().catch(() => {});
}

export const googleAuthProvider = new GoogleAuthProvider();
// Prompt account selection cleanly without force-reauthenticating active sessions
googleAuthProvider.setCustomParameters({
  prompt: 'select_account',
});
