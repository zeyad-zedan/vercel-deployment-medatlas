import { CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import type { AnswerSaveStatus } from '../lib/answer-saves.ts';

export function AnswerSaveStatus({ status, unsavedCount, retry }: {
  status: AnswerSaveStatus; unsavedCount: number; retry: () => void;
}) {
  if (status === 'idle') return null;
  return <div className={`flex flex-wrap items-center gap-2 text-xs font-medium ${status === 'error' ? 'text-amber-800' : 'text-slate-600'}`}>
    <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
      {status === 'saving' ? <Loader2 size={14} className="animate-spin"/> : status === 'saved' ? <CheckCircle2 size={14} className="text-emerald-600"/> : <AlertTriangle size={14}/>}
      {status === 'saving' ? 'Saving answers…' : status === 'saved' ? 'All answers saved' : `${unsavedCount} ${unsavedCount === 1 ? 'answer' : 'answers'} not saved`}
    </span>
    {status === 'error' && <button type="button" onClick={retry} className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 font-semibold hover:bg-amber-100">Retry saving</button>}
  </div>;
}
