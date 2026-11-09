import { useId, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import { useDialogFocus } from '../lib/use-dialog-focus.ts';

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let installState: InstallPrompt | 'installed' | null = null;
const listeners = new Set<() => void>();

function setInstallState(state: typeof installState) {
  installState = state;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    setInstallState(event as InstallPrompt);
  });
  window.addEventListener('appinstalled', () => setInstallState('installed'));
}

export function InstallMedAtlas({ className }: { className: string }) {
  const prompt = useSyncExternalStore(subscribe, () => installState, () => null);
  const [showGuide, setShowGuide] = useState(false);
  const dialog = useDialogFocus(showGuide, () => setShowGuide(false));
  const titleId = useId();
  if (typeof window === 'undefined' || prompt === 'installed' ||
      window.matchMedia?.('(display-mode: standalone)')?.matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone) return null;

  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(navigator.userAgent);

  async function install() {
    if (!prompt || prompt === 'installed') {
      setShowGuide(true);
      return;
    }
    setInstallState(null);
    try {
      const { outcome } = await prompt.prompt();
      if (outcome === 'accepted') setInstallState('installed');
    } catch {
      setShowGuide(true);
    }
  }

  return (
    <>
      <button type="button" className={className} onClick={install}>
        <Download size={16} aria-hidden="true" /> Install MedAtlas
      </button>
      {showGuide && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={event => { if (event.target === event.currentTarget) setShowGuide(false); }}>
          <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}
            className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-5 text-slate-900 shadow-lg">
            <h2 id={titleId} className="text-lg font-bold">Install MedAtlas</h2>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
              {ios ? <>
                <li>Open MedAtlas in Safari and tap <strong>Share</strong>.</li>
                <li>Tap <strong>Add to Home Screen</strong>.</li>
                <li>Turn on <strong>Open as Web App</strong> if shown, then tap <strong>Add</strong>.</li>
              </> : android ? <>
                <li>Open MedAtlas in Chrome and tap the three-dot menu.</li>
                <li>Tap <strong>Install and create shortcut</strong> or <strong>Add to Home screen</strong>.</li>
                <li>Choose <strong>Install</strong> or <strong>Create shortcut</strong>, then confirm.</li>
              </> : <>
                <li>Open the browser menu.</li>
                <li>Choose <strong>Install page as app</strong> or <strong>Create shortcut</strong>. In Chrome these are under <strong>Cast, save, and share</strong>.</li>
              </>}
            </ol>
            <button type="button" className="rounded-lg bg-[var(--ma-brand)] px-4 py-2 text-sm font-semibold text-white"
              onClick={() => setShowGuide(false)}>Done</button>
          </div>
        </div>, document.body)}
    </>
  );
}
