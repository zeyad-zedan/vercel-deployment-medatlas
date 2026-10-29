import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  browserPopupRedirectResolver,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

const envAuthDomain =
  typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_AUTH_DOMAIN
    ? String((import.meta as any).env.VITE_FIREBASE_AUTH_DOMAIN).trim()
    : '';

const effectiveFirebaseConfig = {
  ...firebaseConfig,
  authDomain: envAuthDomain || firebaseConfig.authDomain,
};

const app = !getApps().length ? initializeApp(effectiveFirebaseConfig) : getApp();

// getAuth(app) automatically initializes Firebase Auth with:
// - popupRedirectResolver: browserPopupRedirectResolver
// - persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence]
export const auth = getAuth(app);

/**
 * Proactively warms up Firebase Auth state and the browser popup/redirect resolver
 * on initial page load so that clicking "Continue with Google" opens the popup
 * synchronously within the browser's user-activation window without a 1-2s iframe load delay.
 */
export function warmUpFirebaseAuth(): void {
  if (typeof window === 'undefined') return;
  if (typeof auth.authStateReady === 'function') {
    auth.authStateReady().catch(() => {});
  }
  const resolver = browserPopupRedirectResolver as any;
  if (resolver && typeof resolver._initialize === 'function') {
    try {
      resolver._initialize(auth).catch(() => {});
    } catch {
      // Ignore resolver pre-warm errors in non-browser or restricted environments
    }
  }
}

warmUpFirebaseAuth();

export const googleAuthProvider = new GoogleAuthProvider();
// Prompt account selection cleanly without force-reauthenticating active sessions
googleAuthProvider.setCustomParameters({
  prompt: 'select_account',
});
