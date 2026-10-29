import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

function resolveFirebaseAuthDomain(): string {
  const envAuthDomain =
    typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_AUTH_DOMAIN
      ? String((import.meta as any).env.VITE_FIREBASE_AUTH_DOMAIN).trim()
      : '';
  if (envAuthDomain) {
    return envAuthDomain;
  }

  // Use the current same-origin host in production browsers so Firebase Auth
  // uses the /__/auth/* proxy in vercel.json instead of cross-domain third-party storage.
  if (typeof window !== 'undefined' && window.location?.host && process.env.NODE_ENV !== 'test') {
    const hostname = window.location.hostname || '';
    const isLocalhost =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname.endsWith('.local');
    if (hostname && !isLocalhost) {
      return window.location.host;
    }
  }

  return firebaseConfig.authDomain;
}

const effectiveFirebaseConfig = {
  ...firebaseConfig,
  authDomain: resolveFirebaseAuthDomain(),
};

const app = !getApps().length ? initializeApp(effectiveFirebaseConfig) : getApp();

export const auth = getAuth(app);

/**
 * Proactively warms up Firebase Auth state and the browser popup/redirect resolver instance
 * on initial page load so that clicking "Continue with Google" opens the popup
 * synchronously within the browser's user-activation window without a 1-2s iframe load delay.
 */
export function warmUpFirebaseAuth(): void {
  if (typeof window === 'undefined') return;
  if (typeof auth.authStateReady === 'function') {
    auth.authStateReady().catch(() => {});
  }
  const resolver = (auth as any)?._popupRedirectResolver;
  if (resolver && typeof resolver._initialize === 'function') {
    try {
      resolver._initialize(auth).catch(() => {});
    } catch {
      // Ignore resolver pre-warm errors in non-browser or restricted environments
    }
  }
  if (resolver && typeof resolver._originValidation === 'function') {
    try {
      resolver._originValidation(auth).catch(() => {});
    } catch {
      // Ignore origin validation pre-warm errors
    }
  }
}

warmUpFirebaseAuth();

export const googleAuthProvider = new GoogleAuthProvider();
googleAuthProvider.setCustomParameters({
  prompt: 'select_account',
});
