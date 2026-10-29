import { initializeApp } from 'firebase/app';
import {
  initializeAuth,
  getAuth,
  GoogleAuthProvider,
  inMemoryPersistence,
  browserPopupRedirectResolver,
  type Auth,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

// Purge any legacy cached Firebase Auth IndexedDB / localStorage state so the browser
// never attempts to call the disabled securetoken.googleapis.com endpoint on stale tokens.
if (typeof window !== 'undefined') {
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('firebase:')) {
        window.localStorage.removeItem(k);
      }
    }
  } catch {}
  try {
    for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith('firebase:')) {
        window.sessionStorage.removeItem(k);
      }
    }
  } catch {}
  try {
    window.indexedDB?.deleteDatabase?.('firebaseLocalStorageDb');
  } catch {}
}

const app = initializeApp(firebaseConfig);

let authInstance: Auth;
try {
  authInstance = initializeAuth(app, {
    persistence: inMemoryPersistence,
    popupRedirectResolver: browserPopupRedirectResolver,
  });
} catch {
  authInstance = getAuth(app);
}

export const auth = authInstance;
export const googleAuthProvider = new GoogleAuthProvider();

// Proactively initialize the Firebase popup/redirect resolver on all browsers (including desktop)
// so gapi.iframes and the hidden auth iframe are ready before the user clicks "Continue with Google".
if (typeof window !== 'undefined') {
  const warmUpPopupResolver = () => {
    try {
      const resolver = (authInstance as any)?._popupRedirectResolver;
      if (resolver && typeof resolver._initialize === 'function') {
        resolver._initialize(authInstance).catch(() => {});
      }
    } catch {}
  };
  if (typeof document !== 'undefined' && document.body) {
    warmUpPopupResolver();
  } else if (typeof window.addEventListener === 'function') {
    window.addEventListener('DOMContentLoaded', warmUpPopupResolver, { once: true });
  }
}
