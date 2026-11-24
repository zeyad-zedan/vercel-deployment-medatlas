import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.ts';
import { QuestionImages } from './QuestionImages.tsx';

const primary = 'rounded-lg bg-[var(--ma-brand)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50';
const secondary = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50';

type AttemptRow = { uid: string; name: string; email: string; startedAt: string; status: 'solving' | 'pending' | 'graded'; score: number | null; maxMarks: number };
type RubricPoint = { id: string; description: string; maxUnits: number; maxMarks: number };
type AdminStation = {
  index: number; questionType: 'mcq' | 'short_answer'; question: string; images: any[];
  options?: Record<string, string>; correctOption?: string; modelAnswer: string;
  rubric: RubricPoint[]; answer: string;
  gradeUnits: Array<{ id: string; awardedUnits: number; feedback: string }> | null;
  feedback: string;
};

export function PracticalMockGrader({ examId, examTitle, onBack }: { examId: string; examTitle: string; onBack: () => void }) {
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [filter, setFilter] = useState<'pending' | 'graded' | 'all'>('pending');
  const [selectedUid, setSelectedUid] = useState<string>('');
  const [detail, setDetail] = useState<{ name: string; email: string; markUnit: number; stations: AdminStation[] } | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [feedbacks, setFeedbacks] = useState<Record<number, string>>({});
  const [showMcqs, setShowMcqs] = useState(false);
  const [bulkInput, setBulkInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadList = useCallback(async (keepUid?: string) => {
    setError('');
    try {
      const data = await api.adminListPracticalMockAttempts(examId);
      setAttempts(data.attempts || []);
      const list: AttemptRow[] = data.attempts || [];
      if (keepUid && list.some(a => a.uid === keepUid)) setSelectedUid(keepUid);
      else {
        const firstPending = list.find(a => a.status === 'pending') ?? list[0];
        setSelectedUid(firstPending?.uid ?? '');
      }
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [examId]);

  useEffect(() => { void loadList(); }, [loadList]);

  useEffect(() => {
    if (!selectedUid) { setDetail(null); return; }
    let active = true;
    setMessage('');
    setError('');
    api.adminGetPracticalMockAttempt(examId, selectedUid).then(data => {
      if (!active) return;
      setDetail(data);
      const nextScores: Record<string, number> = {};
      const nextFb: Record<number, string> = {};
      for (const st of data.stations as AdminStation[]) {
        nextFb[st.index] = st.feedback || '';
        for (const p of st.rubric) {
          const existing = st.gradeUnits?.find(g => g.id === p.id);
          nextScores[`${st.index}:${p.id}`] = existing ? existing.awardedUnits : 0;
        }
      }
      setScores(nextScores);
      setFeedbacks(nextFb);
      setBulkInput('');
    }).catch(err => { if (active) setError((err as Error).message); });
    return () => { active = false; };
  }, [examId, selectedUid]);

  const filtered = useMemo(() => attempts.filter(a => filter === 'all' ? true : a.status === filter), [attempts, filter]);
  const currentIdx = filtered.findIndex(a => a.uid === selectedUid);

  const totals = useMemo(() => {
    if (!detail) return { mcq: 0, mcqMax: 0, written: 0, writtenMax: 0, total: 0, max: 0 };
    let mcq = 0, mcqMax = 0, written = 0, writtenMax = 0;
    for (const st of detail.stations) {
      for (const p of st.rubric) {
        const val = (scores[`${st.index}:${p.id}`] ?? 0) * detail.markUnit;
        if (st.questionType === 'mcq') { mcq += val; mcqMax += p.maxMarks; }
        else { written += val; writtenMax += p.maxMarks; }
      }
    }
    return { mcq, mcqMax, written, writtenMax, total: mcq + written, max: mcqMax + writtenMax };
  }, [detail, scores]);

  function applyBulkScores() {
    if (!detail) return;
    const writtenStations = detail.stations.filter(s => s.questionType !== 'mcq');
    const tokens = bulkInput.trim().split(/[\s,;]+/).filter(Boolean);
    if (!tokens.length) { setError('Paste at least one score first.'); return; }
    const parsed = tokens.map(Number);
    if (parsed.some(n => !Number.isFinite(n) || n < 0)) { setError('Every entry must be a valid non-negative number (e.g. 0.5, 1.5, 0.25).'); return; }
    setError('');
    setScores(prev => {
      const next = { ...prev };
      const count = Math.min(parsed.length, writtenStations.length);
      for (let i = 0; i < count; i++) {
        const st = writtenStations[i];
        let remainingUnits = Math.round(parsed[i] / detail.markUnit);
        for (const p of st.rubric) {
          const give = Math.max(0, Math.min(p.maxUnits, remainingUnits));
          next[`${st.index}:${p.id}`] = give;
          remainingUnits -= give;
        }
      }
      return next;
    });
    setMessage(`Applied ${Math.min(parsed.length, writtenStations.length)} of ${writtenStations.length} written station scores.`);
  }

  async function save(goNext: boolean) {
    if (!detail || !selectedUid) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const stations = detail.stations.filter(s => s.questionType !== 'mcq').map(st => ({
        index: st.index,
        feedback: feedbacks[st.index] ?? '',
        points: st.rubric.map(p => ({ id: p.id, awardedUnits: scores[`${st.index}:${p.id}`] ?? 0 })),
      }));
      const res = await api.adminSavePracticalMockGrades(examId, selectedUid, { stations });
      setMessage(`Saved! Final score: ${res.score}/${res.maxScore} marks.`);
      const nextCandidate = goNext ? (filtered[currentIdx + 1]?.uid ?? attempts.find(a => a.status === 'pending' && a.uid !== selectedUid)?.uid) : selectedUid;
      await loadList(nextCandidate || selectedUid);
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  const pendingCount = attempts.filter(a => a.status === 'pending').length;
  const gradedCount = attempts.filter(a => a.status === 'graded').length;

  return <div className="max-w-5xl space-y-4 pb-24">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold">Manual Grading · {examTitle}</h1>
        <p className="text-sm text-slate-600">{pendingCount} needs grading · {gradedCount} graded · {attempts.length} total</p>
      </div>
      <div className="flex gap-2">
        <button type="button" className={secondary} onClick={() => { void loadList(selectedUid); }}>Refresh list</button>
        <button type="button" className={secondary} onClick={onBack}>Back</button>
      </div>
    </header>

    <div className="ma-dashboard-panel flex flex-wrap items-center gap-3">
      <div className="flex gap-1.5">
        {(['pending', 'graded', 'all'] as const).map(tab => (
          <button key={tab} type="button" onClick={() => setFilter(tab)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${filter === tab ? 'bg-[var(--ma-brand)] text-white' : 'bg-slate-100 text-slate-700'}`}>
            {tab === 'pending' ? `Needs grading (${pendingCount})` : tab === 'graded' ? `Graded (${gradedCount})` : `All (${attempts.length})`}
          </button>
        ))}
      </div>
      <select className="min-w-64 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={selectedUid} onChange={e => setSelectedUid(e.target.value)}>
        {filtered.length === 0 && <option value="">No students in this filter</option>}
        {filtered.map((a, i) => (
          <option key={a.uid} value={a.uid}>
            {i + 1}. {a.name} ({a.status}{a.score !== null ? ` · ${a.score}/${a.maxMarks}` : ''})
          </option>
        ))}
      </select>
      <div className="flex gap-1.5">
        <button type="button" className={secondary} disabled={currentIdx <= 0} onClick={() => setSelectedUid(filtered[currentIdx - 1].uid)}>Prev</button>
        <button type="button" className={secondary} disabled={currentIdx < 0 || currentIdx >= filtered.length - 1} onClick={() => setSelectedUid(filtered[currentIdx + 1].uid)}>Next</button>
      </div>
    </div>

    {error && <div className="ma-dashboard-panel text-sm text-red-700" role="alert">{error}</div>}
    {message && <div className="ma-dashboard-panel bg-emerald-50 text-sm font-semibold text-emerald-800" role="status">{message}</div>}
    {loading && <p className="text-sm text-slate-600">Loading students…</p>}

    {detail && <>
      <div className="ma-dashboard-panel flex flex-wrap items-center justify-between gap-3 bg-blue-50/60">
        <div>
          <p className="text-sm font-bold text-slate-900">{detail.name} <span className="font-normal text-slate-600">({detail.email})</span></p>
          <p className="text-sm text-slate-700">MCQs auto-graded: <strong>{totals.mcq}/{totals.mcqMax}</strong> · Written: <strong>{totals.written}/{totals.writtenMax}</strong> · Total: <strong>{totals.total}/{totals.max}</strong></p>
        </div>
        <button type="button" className={secondary} onClick={() => setShowMcqs(v => !v)}>{showMcqs ? 'Hide MCQs' : 'Show auto-graded MCQs'}</button>
      </div>

      <div className="ma-dashboard-panel space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="bulk-scores-input" className="text-sm font-bold text-slate-900">
            Quick paste written grades in order ({detail.stations.filter(s => s.questionType !== 'mcq').length} written stations)
          </label>
          <button type="button" className={primary} onClick={applyBulkScores}>Apply grades</button>
        </div>
        <textarea id="bulk-scores-input" rows={4} value={bulkInput} onChange={e => setBulkInput(e.target.value)}
          placeholder={"0.5\n1.5\n0.25\n..."}
          className="w-full rounded-lg border border-slate-300 bg-white p-2.5 font-mono text-sm" />
      </div>

      {detail.stations.filter(st => showMcqs || st.questionType !== 'mcq').map(st => {
        const isMcq = st.questionType === 'mcq';
        const stScore = st.rubric.reduce((s, p) => s + (scores[`${st.index}:${p.id}`] ?? 0) * detail.markUnit, 0);
        const stMax = st.rubric.reduce((s, p) => s + p.maxMarks, 0);
        return <section key={st.index} className="ma-dashboard-panel space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
            <h3 className="font-bold">Station {st.index + 1} · {isMcq ? 'MCQ (Auto-graded)' : 'Written'} · <span className="text-[var(--ma-brand)]">{stScore}/{stMax}</span></h3>
            {!isMcq && <div className="flex gap-1.5">
              <button type="button" className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white"
                onClick={() => setScores(prev => { const next = { ...prev }; st.rubric.forEach(p => { next[`${st.index}:${p.id}`] = p.maxUnits; }); return next; })}>Full marks</button>
              <button type="button" className="rounded bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-800"
                onClick={() => setScores(prev => { const next = { ...prev }; st.rubric.forEach(p => { next[`${st.index}:${p.id}`] = 0; }); return next; })}>0 marks</button>
            </div>}
          </div>
          <QuestionImages images={st.images} />
          <p className="whitespace-pre-wrap text-sm text-slate-800">{st.question}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-sm">
              <p className="text-xs font-bold uppercase text-blue-900">Student Answer</p>
              <p className="mt-1 whitespace-pre-wrap text-slate-900">{st.answer || <em className="text-slate-400">Unanswered</em>}</p>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 text-sm">
              <p className="text-xs font-bold uppercase text-emerald-900">Model Answer</p>
              <p className="mt-1 whitespace-pre-wrap text-slate-900">{st.modelAnswer}</p>
            </div>
          </div>
          {!isMcq && <div className="space-y-2 pt-1">
            {st.rubric.map(p => {
              const key = `${st.index}:${p.id}`;
              const current = scores[key] ?? 0;
              return <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <span className="flex-1 text-slate-800">{p.description} <strong className="text-slate-600">({p.maxMarks})</strong></span>
                <div className="flex flex-wrap gap-1">
                  {Array.from({ length: p.maxUnits + 1 }, (_, u) => (
                    <button key={u} type="button" onClick={() => setScores(prev => ({ ...prev, [key]: u }))}
                      className={`min-w-10 rounded px-2 py-1 text-xs font-bold ${current === u ? 'bg-[var(--ma-brand)] text-white' : 'border border-slate-300 bg-white text-slate-700'}`}>
                      {u * detail.markUnit}
                    </button>
                  ))}
                </div>
              </div>;
            })}
            <input type="text" placeholder="Optional note for student…" value={feedbacks[st.index] ?? ''}
              onChange={e => setFeedbacks(prev => ({ ...prev, [st.index]: e.target.value }))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs" />
          </div>}
        </section>;
      })}

      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-bold">Total: <span className="text-[var(--ma-brand)]">{totals.total} / {totals.max} marks</span> (MCQs {totals.mcq} + Written {totals.written})</p>
          <div className="flex gap-2">
            <button type="button" className={secondary} disabled={saving} onClick={() => { void save(false); }}>{saving ? 'Saving…' : 'Save'}</button>
            <button type="button" className={primary} disabled={saving} onClick={() => { void save(true); }}>{saving ? 'Saving…' : 'Save & Next Student'}</button>
          </div>
        </div>
      </div>
    </>}
  </div>;
}
