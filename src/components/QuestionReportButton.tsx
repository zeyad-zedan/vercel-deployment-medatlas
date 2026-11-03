import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Flag, Loader2, X, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api.ts';
import { QUESTION_REPORT_REASONS, type QuestionReportReason } from '../lib/question-reports.ts';
import { useDialogFocus } from '../lib/use-dialog-focus.ts';

export function QuestionReportButton({ questionId }: { questionId: number }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<QuestionReportReason | ''>('');
  const [busy, setBusy] = useState(false);
  const [reported, setReported] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const headingId = useId();
  const radioName = useId();
  const close = () => { if (!pending.current) setOpen(false); };
  const dialogRef = useDialogFocus(open, close);

  return <>
    <button type="button" onClick={event => { event.stopPropagation(); setOpen(true); setError(''); setReason(''); setReported(false); }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:text-emerald-700">
      <Flag size={14}/>Report question
    </button>
    {reported && <span role="status" className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><CheckCircle2 size={14}/>Report submitted</span>}
    {open && createPortal(<div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
      onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) close(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={headingId}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-left shadow-xl">
        <div className="flex items-center justify-between gap-3">
          <h2 id={headingId} className="text-lg font-semibold text-slate-900">Report this question</h2>
          <button type="button" onClick={close} disabled={busy} aria-label="Close report dialog" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={18}/></button>
        </div>
        <p className="mt-2 text-sm text-slate-600">Choose a reason. The MedAtlas team will review your report.</p>
        <form onSubmit={async event => {
          event.preventDefault();
          if (!reason || pending.current) return;
          pending.current = true; setBusy(true); setError('');
          try {
            await api.reportQuestion(questionId, reason);
            setReported(true); setOpen(false);
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Report not sent. Please retry.');
          } finally { pending.current = false; setBusy(false); }
        }}>
          <fieldset disabled={busy} className="mt-5 space-y-3">
            <legend className="sr-only">Report reason</legend>
            {QUESTION_REPORT_REASONS.map(option => <label key={option.value}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${reason === option.value ? 'border-teal-500 bg-teal-50' : 'border-slate-200 hover:bg-slate-50'}`}>
              <input type="radio" name={radioName} required checked={reason === option.value}
                onChange={() => setReason(option.value)} className="mt-1 accent-teal-700"/>
              <span className="text-sm font-medium text-slate-800">{option.label}
                {'arabic' in option && <span lang="ar" dir="rtl" className="mt-1 block font-normal text-slate-600">{option.arabic}</span>}
              </span>
            </label>)}
          </fieldset>
          {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" onClick={close} disabled={busy} className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600">Cancel</button>
            <button type="submit" disabled={!reason || busy} className="inline-flex items-center gap-2 rounded-lg bg-[var(--ma-brand)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {busy && <Loader2 size={14} className="animate-spin"/>}{busy ? 'Sending…' : 'Send report'}
            </button>
          </div>
        </form>
      </div>
    </div>, document.body)}
  </>;
}
