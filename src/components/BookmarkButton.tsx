import React, { useRef, useState } from 'react';
import { Bookmark, Loader2 } from 'lucide-react';
import { api } from '../lib/api.ts';

// Independent of answering or completing a session. Saved means the server acknowledged it.
export function BookmarkButton({questionId, saved, onSaved}: {
  questionId: number; saved: boolean; onSaved?: (saved: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  return <span className="inline-flex flex-col items-start gap-1">
    <button type="button" disabled={busy} aria-pressed={saved}
      aria-label={saved ? 'Remove bookmark' : 'Save bookmark'}
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-60 ${saved ? 'bg-sky-50 border-sky-200 text-sky-800' : 'bg-white border-slate-200 text-slate-600'}`}
      onClick={async () => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setError('');
        try { const result = await api.toggleBookmark(questionId, undefined, !saved); onSaved?.(result.bookmarked); }
        catch { setError('Bookmark not saved. Check your connection and retry.'); }
        finally { pending.current = false; setBusy(false); }
      }}>
      {busy ? <Loader2 size={14} className="animate-spin"/> : <Bookmark size={14} fill={saved ? 'currentColor' : 'none'}/>}
      {busy ? 'Saving…' : error ? 'Retry saving' : saved ? 'Saved' : 'Save'}
    </button>
    {error && <span role="alert" className="max-w-52 text-xs text-rose-700">{error}</span>}
  </span>;
}
