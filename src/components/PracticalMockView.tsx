import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCheck, Clock3 } from 'lucide-react';
import { api } from '../lib/api.ts';
import { maxPracticalAnswerLength, practicalStationSeconds, type PracticalMockAttempt, type PracticalMockCard } from '../lib/practical-mock.ts';
import { GradeFeedback } from './GradeFeedback.tsx';
import { PracticalMockAuthor } from './PracticalMockAuthor.tsx';
import { QuestionImages } from './QuestionImages.tsx';

const primary = 'rounded-lg bg-[var(--ma-brand)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50';
const secondary = 'rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-50';
type ActiveStation = Extract<PracticalMockAttempt, { status: 'active' }>;
type StationResult = Extract<PracticalMockAttempt, { status: 'graded' }>['stations'][number];

function PracticalMockStationResult({ station, index }: { station: StationResult; index: number }) {
  const [open, setOpen] = useState(false);
  return <details className="ma-dashboard-panel" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-semibold">Station {index + 1} · {station.grade.score}/{station.maxMarks} marks</summary>
    {open && <div className="mt-4 space-y-4">
      <QuestionImages images={station.images} />
      <h3 className="ma-question-stem whitespace-pre-wrap font-serif-academic">{station.question}</h3>
      <p className="whitespace-pre-wrap text-sm"><strong>Your answer</strong><br />{station.answer || 'Unanswered'}</p>
      <GradeFeedback grade={station.grade} modelAnswer={station.modelAnswer} />
    </div>}
  </details>;
}

function Station({ attempt, deadline, onClosed, onRefresh }: {
  attempt: ActiveStation; deadline: number; onClosed: () => void; onRefresh: () => void;
}) {
  const [seconds, setSeconds] = useState(() => Math.ceil(Math.max(0, deadline - performance.now()) / 1000));
  const [answer, setAnswer] = useState(attempt.answer);
  const [savedAnswer, setSavedAnswer] = useState(attempt.answer);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ text: string; conflict: boolean } | null>(null);
  const revision = useRef(attempt.revision);
  const pending = useRef(false);

  useEffect(() => {
    const update = () => setSeconds(Math.ceil(Math.max(0, deadline - performance.now()) / 1000));
    update();
    const ticker = window.setInterval(update, 200);
    const expiry = window.setTimeout(() => { setSeconds(0); onClosed(); }, Math.max(0, deadline - performance.now()));
    return () => { window.clearInterval(ticker); window.clearTimeout(expiry); };
  }, [deadline, onClosed]);

  const save = useCallback(async () => {
    if (pending.current || answer === savedAnswer || performance.now() >= deadline) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api.savePracticalMockAnswer(attempt.id, attempt.stationIndex, answer, revision.current);
      revision.current = result.revision;
      setSavedAnswer(answer);
    } catch (error) {
      const failure = error as Error & { status?: number };
      setError({ text: failure.message, conflict: failure.status === 409 });
    } finally { pending.current = false; setSaving(false); }
  }, [answer, savedAnswer, attempt.id, attempt.stationIndex, deadline]);

  const closeToDeadline = seconds <= 5;
  useEffect(() => {
    if (saving || error || answer === savedAnswer) return;
    const timer = window.setTimeout(() => { void save(); }, closeToDeadline ? 0 : 350);
    return () => window.clearTimeout(timer);
  }, [answer, savedAnswer, saving, error, closeToDeadline, save]);

  if (seconds === 0) return <div className="ma-dashboard-panel" role="status">Station closed. Opening the next step…</div>;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <>
    <div className="sticky top-16 z-10 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <p className="text-sm font-semibold">Station {attempt.stationIndex + 1} of {attempt.stationCount}</p>
      <span role="timer" aria-label="Time remaining" className={`inline-flex items-center gap-2 font-semibold tabular-nums ${seconds <= 15 ? 'text-red-700' : 'text-[var(--ma-brand)]'}`}><Clock3 size={17} aria-hidden="true" />{clock}</span>
    </div>
    <section className="ma-dashboard-panel space-y-4" aria-labelledby="practical-mock-question">
      <QuestionImages images={attempt.station.images} />
      <div>
        <p className="text-xs font-semibold text-[var(--ma-brand)]">Short answer · {attempt.station.maxMarks} marks</p>
        <h2 id="practical-mock-question" className="ma-question-stem mt-2 whitespace-pre-wrap font-serif-academic">{attempt.station.question}</h2>
      </div>
      <label className="block text-sm font-semibold" htmlFor="practical-mock-answer">Your answer</label>
      <textarea id="practical-mock-answer" rows={5} maxLength={maxPracticalAnswerLength} value={answer}
        className="w-full rounded-lg border border-slate-300 bg-white p-3 text-sm" placeholder="Write your answer…"
        onChange={event => setAnswer(event.target.value)} onBlur={() => { if (!error) void save(); }} />
      <p className="text-sm text-slate-600" role="status">{saving ? 'Saving…' : answer === savedAnswer ? (savedAnswer ? 'Answer saved.' : 'Your answer saves as you type.') : 'Answer awaiting save.'}</p>
      {error && <div role="alert" className="space-y-2 text-sm text-red-700"><p>{error.text}</p>
        <button type="button" className={secondary} onClick={error.conflict ? onRefresh : () => { void save(); }}>{error.conflict ? 'Reload station' : 'Retry saving'}</button>
      </div>}
    </section>
  </>;
}

const timedView = (attempt: PracticalMockAttempt) => ({
  attempt,
  deadline: performance.now() + (attempt.status === 'active' ? attempt.remainingMs : attempt.status === 'graded' ? 0 : attempt.retryInMs),
});

function PracticalMockRunner({ initial, onExit }: { initial: PracticalMockAttempt; onExit: () => void }) {
  const [{ attempt, deadline }, setView] = useState(() => timedView(initial));
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState('');
  const [retryReady, setRetryReady] = useState(false);
  const requestedGrade = useRef(false);
  const inFlight = useRef(false);
  const id = attempt.id;

  const request = useCallback(async (grade = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError('');
    if (grade) setGrading(true);
    const controller = new AbortController();
    const timer = grade ? window.setTimeout(() => controller.abort(), 30_000) : undefined;
    try { setView(timedView(await (grade ? api.gradePracticalMock(id, controller.signal) : api.getPracticalMock(id)))); }
    catch (error) { setError(controller.signal.aborted ? 'Your answers are saved. Check for results again shortly.' : (error as Error).message); }
    finally { window.clearTimeout(timer); inFlight.current = false; if (grade) setGrading(false); }
  }, [id]);
  const refresh = useCallback(() => { void request(); }, [request]);

  useEffect(() => {
    if (attempt.status === 'finished' && !attempt.gradingError && !requestedGrade.current) {
      requestedGrade.current = true;
      void request(true);
    }
    if (attempt.status === 'grading' && !error) {
      const poll = window.setTimeout(refresh, 2000);
      return () => window.clearTimeout(poll);
    }
  }, [attempt, error, refresh, request]);

  useEffect(() => {
    if (attempt.status !== 'finished') return;
    setRetryReady(attempt.retryInMs <= 0);
    const timer = window.setTimeout(() => setRetryReady(true), Math.max(0, deadline - performance.now()));
    return () => window.clearTimeout(timer);
  }, [attempt, deadline]);

  return <div className="max-w-3xl space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold">{attempt.title}</h1>
      {attempt.status !== 'active' && <button type="button" className={secondary} onClick={onExit}>Back to exams</button>}
    </header>
    {error && <div className="ma-dashboard-panel space-y-2 text-sm text-red-700" role="alert"><p>{error}</p>
      <button type="button" className={secondary} onClick={refresh}>Retry connection</button>
    </div>}
    {attempt.status === 'active' && <Station key={`${attempt.stationIndex}:${attempt.revision}`} attempt={attempt} deadline={deadline} onClosed={refresh} onRefresh={refresh} />}
    {(grading || attempt.status === 'grading') && <p className="ma-dashboard-panel text-sm" role="status">Grading all stations…</p>}
    {!grading && attempt.status === 'finished' && <div className="ma-dashboard-panel space-y-3">
      <h2 className="text-lg font-semibold">Exam finished</h2>
      <p className="text-sm text-slate-600">{attempt.gradingError || 'Your answers are saved.'}</p>
      <button type="button" className={primary} disabled={!retryReady} onClick={() => { void request(true); }}>Grade answers</button>
    </div>}
    {attempt.status === 'graded' && <>
      <div className="ma-dashboard-panel" role="status">
        <h2 className="text-lg font-semibold">Exam results</h2>
        <p className="mt-1 text-2xl font-bold tabular-nums">{attempt.stations.reduce((sum, station) => sum + station.grade.score, 0)}/{attempt.stations.reduce((sum, station) => sum + station.maxMarks, 0)} marks</p>
      </div>
      {attempt.stations.map((station, index) => <PracticalMockStationResult key={index} station={station} index={index} />)}
    </>}
  </div>;
}

export function PracticalMockView({ isAdmin }: { isAdmin: boolean }) {
  const [cards, setCards] = useState<PracticalMockCard[] | null>(null);
  const [attempt, setAttempt] = useState<PracticalMockAttempt | null>(null);
  const [authoring, setAuthoring] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try { setCards(await api.getPracticalMocks()); }
    catch (error) { setError((error as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function open(card: PracticalMockCard) {
    setOpening(card.id);
    setError('');
    try { setAttempt(await (card.status === 'ready' ? api.startPracticalMock(card.id) : api.getPracticalMock(card.id))); }
    catch (error) { setError((error as Error).message); }
    finally { setOpening(null); setConfirm(null); }
  }

  if (attempt) return <PracticalMockRunner initial={attempt} onExit={() => { setAttempt(null); void load(); }} />;
  if (authoring) return <div className="max-w-3xl"><PracticalMockAuthor onCancel={() => setAuthoring(false)} onPublished={() => { setAuthoring(false); void load(); }} /></div>;
  return <div className="max-w-4xl space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-bold">Practical Mock Exams</h1>
        <p className="mt-2 text-sm text-slate-600">Identify what you see in each photo and write your answer before the two-minute timer ends.</p></div>
      {isAdmin && <button type="button" className={primary} onClick={() => setAuthoring(true)}>Create exam</button>}
    </header>
    {error && <div className="ma-dashboard-panel space-y-2" role="alert"><p className="text-sm text-red-700">{error}</p>
      <button type="button" className={secondary} onClick={() => { void load(); }}>Try again</button></div>}
    {!cards && !error && <p role="status">Loading exams…</p>}
    {cards?.length === 0 && <div className="ma-dashboard-panel text-sm text-slate-600">No practical mock exams have been published yet.</div>}
    <div className="grid gap-4 sm:grid-cols-2">
      {cards?.map(card => <article key={card.id} className="ma-session-card gap-3">
        <ClipboardCheck size={22} className="text-[var(--ma-brand)]" aria-hidden="true" />
        <h2 className="text-lg font-bold">{card.title}</h2>
        <p className="text-sm text-slate-600">{card.stationCount} {card.stationCount === 1 ? 'station' : 'stations'} · {card.stationCount * practicalStationSeconds / 60} minutes</p>
        {confirm === card.id ? <div className="mt-auto space-y-3 pt-2">
          <p className="text-sm">The timer keeps running if you leave. Stations advance automatically, and answers are sent to Gemini for grading after the last station.</p>
          <div className="flex flex-wrap gap-2"><button type="button" className={primary} disabled={Boolean(opening)} onClick={() => { void open(card); }}>Begin timed exam</button>
            <button type="button" className={secondary} disabled={Boolean(opening)} onClick={() => setConfirm(null)}>Cancel</button></div>
        </div> : <button type="button" className={`${primary} mt-auto self-start`} disabled={Boolean(opening)}
          onClick={() => { if (card.status === 'ready') setConfirm(card.id); else void open(card); }}>
          {opening === card.id ? 'Opening…' : { ready: 'Start exam', active: 'Resume exam', finished: 'View grading', graded: 'Review results' }[card.status]}
        </button>}
      </article>)}
    </div>
  </div>;
}
