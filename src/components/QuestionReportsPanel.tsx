import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { QUESTION_REPORT_REASONS, type QuestionReportItem } from '../lib/question-reports.ts';

export function QuestionReportsPanel({ onEditQuestion }: { onEditQuestion: (id: number) => void }) {
  const [reports, setReports] = useState<QuestionReportItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const busy = useRef(false);
  const revision = useRef(0);
  const load = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true); setError('');
    try {
      const result = await api.getQuestionReports();
      if (request === revision.current) { setReports(result.reports); setTotal(result.totalOpen); }
    } catch (failure) {
      if (request === revision.current) setError(failure instanceof Error ? failure.message : 'Could not load reports.');
    } finally { if (request === revision.current) setLoading(false); }
  }, []);
  useEffect(() => { load(); return () => { revision.current++; }; }, [load]);

  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-xl font-semibold text-slate-900">Question reports</h2>
        <p className="mt-1 text-sm text-slate-600">{total} open reports. Review a question before marking its report resolved.</p></div>
      <button type="button" onClick={load} disabled={loading || busyId !== null} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium">Refresh reports</button>
    </div>
    {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    {loading ? <p role="status" className="ma-dashboard-panel">Loading reports…</p> : <>
      {!error && !reports.length && <div className="ma-empty-state">There are no open question reports.</div>}
      {reports.map(report => <article key={report.id} className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><span className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">{QUESTION_REPORT_REASONS.find(reason => reason.value === report.reason)?.label || report.reason}</span>
            <p className="mt-2 text-xs text-slate-500">{report.lectureTitle || 'Lecture removed'} · {report.studentName || 'Student'} · {new Date(report.createdAt).toLocaleString()}</p></div>
          <div className="flex gap-2">
            {report.questionId !== null && <button type="button" onClick={() => onEditQuestion(report.questionId!)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold">Edit question</button>}
            <button type="button" disabled={busyId !== null} onClick={async () => {
              if (busy.current) return;
              const request = revision.current;
              busy.current = true; setBusyId(report.id); setError('');
              try { await api.resolveQuestionReport(report.id); if (revision.current === request) await load(); }
              catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not resolve this report.'); }
              finally { busy.current = false; setBusyId(null); }
            }} className="rounded-lg bg-[var(--ma-brand)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
              {busyId === report.id ? 'Saving…' : 'Mark resolved'}
            </button>
          </div>
        </div>
        <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{report.questionText}</p>
      </article>)}
      {total > reports.length && <p className="text-xs text-slate-500">Showing the latest {reports.length} of {total} open reports. Earlier reports appear as these are resolved.</p>}
    </>}
  </section>;
}
