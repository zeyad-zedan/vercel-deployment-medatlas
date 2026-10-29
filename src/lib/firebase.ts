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
