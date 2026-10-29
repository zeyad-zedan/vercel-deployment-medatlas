import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
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

export const auth = getAuth(app);

let warmUpPromise: Promise<void> | null = null;

/**
 * Proactively warms up Firebase Auth state and the browser popup/redirect resolver instance
 * on initial page load so that clicking "Continue with Google" opens the popup
 * synchronously within the browser's user-activation window without a 1-2s iframe load delay.
 */
export function warmUpFirebaseAuth(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (warmUpPromise) return warmUpPromise;

  warmUpPromise = (async () => {
    try {
      if (typeof auth.authStateReady === 'function') {
        await auth.authStateReady().catch(() => {});
      }
      const resolver = (auth as any)?._popupRedirectResolver;
      if (resolver && typeof resolver._initialize === 'function') {
        await Promise.all([
          resolver._initialize(auth).catch(() => {}),
          typeof resolver._originValidation === 'function'
            ? resolver._originValidation(auth).catch(() => {})
            : Promise.resolve(),
        ]);
      }
    } catch {
      // Ignore resolver pre-warm errors in non-browser or restricted environments
    }
  })();

  return warmUpPromise;
}

warmUpFirebaseAuth();

export const googleAuthProvider = new GoogleAuthProvider();
googleAuthProvider.setCustomParameters({
  prompt: 'select_account',
});
