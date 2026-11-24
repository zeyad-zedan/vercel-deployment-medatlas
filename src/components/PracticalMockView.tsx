import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCheck, Clock3 } from 'lucide-react';
import { api } from '../lib/api.ts';
import { maxPracticalAnswerLength, practicalStationSeconds, type PracticalMockAttempt, type PracticalMockCard } from '../lib/practical-mock.ts';
import { GradeFeedback } from './GradeFeedback.tsx';
import { PracticalMockAuthor } from './PracticalMockAuthor.tsx';
import { PracticalMockGrader } from './PracticalMockGrader.tsx';
import { QuestionImages } from './QuestionImages.tsx';

const primary = 'rounded-lg bg-[var(--ma-brand)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50';
const secondary = 'rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-50';
const saveIdleMs = 900;
const maxDraftAgeMs = 3000;
const saveImmediatelySeconds = 8;
type ActiveStation = Extract<PracticalMockAttempt, { status: 'active' }>;
type StationResult = Extract<PracticalMockAttempt, { status: 'graded' }>['stations'][number];

function PracticalMockStationResult({ station, index }: { station: StationResult; index: number }) {
  const [open, setOpen] = useState(false);
  const isMcq = station.questionType === 'mcq' && Boolean(station.options);
  const selectedKey = station.answer.trim().toUpperCase();
  return <details className="ma-dashboard-panel" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-semibold">Station {index + 1} · {isMcq ? 'MCQ · ' : ''}{station.grade.score}/{station.maxMarks} marks</summary>
    {open && <div className="mt-4 space-y-4">
      <QuestionImages images={station.images} />
      <h3 className="ma-question-stem whitespace-pre-wrap font-serif-academic">{station.question}</h3>
      {isMcq && station.options ? <div className="space-y-2">
        {Object.entries(station.options).map(([key, text]) => {
          const isCorrect = key === station.correctOption;
          const isPicked = key === selectedKey;
          const style = isCorrect
            ? 'border-emerald-500 bg-emerald-50 text-emerald-950'
            : isPicked
              ? 'border-red-400 bg-red-50 text-red-950'
              : 'border-slate-200 bg-white text-slate-700';
          return <div key={key} className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-sm ${style}`}>
            <span className="font-bold">{key})</span>
            <span className="flex-1">{text}</span>
            {isCorrect && <span className="text-xs font-semibold text-emerald-700">Correct</span>}
            {isPicked && !isCorrect && <span className="text-xs font-semibold text-red-700">Your choice</span>}
          </div>;
        })}
        {!selectedKey && <p className="text-sm text-slate-600">Unanswered</p>}
      </div> : <p className="whitespace-pre-wrap text-sm"><strong>Your answer</strong><br />{station.answer || 'Unanswered'}</p>}
      <GradeFeedback grade={station.grade} modelAnswer={station.modelAnswer} />
    </div>}
  </details>;
}

function Station({ attempt, deadline, onClosed, onRefresh, onSkipped }: {
  attempt: ActiveStation; deadline: number; onClosed: () => void; onRefresh: () => void; onSkipped: (next: PracticalMockAttempt) => void;
}) {
  const [seconds, setSeconds] = useState(() => Math.ceil(Math.max(0, deadline - performance.now()) / 1000));
  const [answer, setAnswer] = useState(attempt.answer);
  const [savedAnswer, setSavedAnswer] = useState(attempt.answer);
  const [saving, setSaving] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<{ text: string; conflict: boolean } | null>(null);
  const revision = useRef(attempt.revision);
  const pending = useRef<Promise<boolean> | null>(null);
  const unacknowledged = useRef<{ text: string; revision: number } | null>(null);
  const latestAnswer = useRef(attempt.answer);
  const latestSaved = useRef(attempt.answer);
  const draftStartedAt = useRef<number | null>(null);

  const save = useCallback(async (allowGrace = false): Promise<boolean> => {
    while (pending.current) {
      const ok = await pending.current;
      if (!ok) return false;
    }
    const previous = unacknowledged.current;
    if (!previous && latestAnswer.current === latestSaved.current) return true;
    if (performance.now() >= deadline + (allowGrace ? 3000 : 0)) return false;
    // A response can be lost after the server commits. Replay that exact write before sending new text.
    const write = previous ?? { text: latestAnswer.current, revision: revision.current };
    unacknowledged.current = write;
    const run = (async () => {
      setSaving(true);
      setError(null);
      if (!previous) draftStartedAt.current = null;
      try {
        const result = await api.savePracticalMockAnswer(attempt.id, attempt.stationIndex, write.text, write.revision);
        revision.current = result.revision;
        unacknowledged.current = null;
        latestSaved.current = write.text;
        setSavedAnswer(write.text);
        return true;
      } catch (error) {
        const failure = error as Error & { status?: number };
        setError({ text: failure.message, conflict: failure.status === 409 });
        return false;
      } finally { pending.current = null; setSaving(false); }
    })();
    pending.current = run;
    const saved = await run;
    return saved && previous && latestAnswer.current !== latestSaved.current ? save(allowGrace) : saved;
  }, [attempt.id, attempt.stationIndex, deadline]);

  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    let active = true;
    const update = () => setSeconds(Math.ceil(Math.max(0, deadline - performance.now()) / 1000));
    update();
    const ticker = window.setInterval(update, 200);
    const expiry = window.setTimeout(() => {
      if (!active) return;
      setSeconds(0);
      void saveRef.current(true).finally(() => { if (active) onClosed(); });
    }, Math.max(0, deadline - performance.now()));
    return () => { active = false; window.clearInterval(ticker); window.clearTimeout(expiry); };
  }, [deadline, onClosed]);

  const skip = useCallback(async () => {
    if (skipping || performance.now() >= deadline) return;
    setSkipping(true);
    setError(null);
    try {
      const saved = await save();
      if (!saved) {
        setConfirmSkip(false);
        return;
      }
      const next = await api.skipPracticalMock(attempt.id, attempt.stationIndex);
      onSkipped(next);
    } catch (error) {
      const failure = error as Error & { status?: number };
      if (failure.status === 409) {
        onRefresh();
        return;
      }
      setConfirmSkip(false);
      setError({ text: failure.message, conflict: false });
    } finally { setSkipping(false); }
  }, [attempt.id, attempt.stationIndex, deadline, onRefresh, onSkipped, save, skipping]);

  const isMcq = attempt.station.questionType === 'mcq' && Boolean(attempt.station.options);
  const closeToDeadline = seconds <= saveImmediatelySeconds;
  useEffect(() => {
    if (saving || skipping || error || answer === savedAnswer) return;
    const age = performance.now() - (draftStartedAt.current ?? performance.now());
    const delay = isMcq || closeToDeadline ? 0 : Math.max(0, Math.min(saveIdleMs, maxDraftAgeMs - age));
    const timer = window.setTimeout(() => { void save(); }, delay);
    return () => window.clearTimeout(timer);
  }, [answer, savedAnswer, saving, skipping, error, closeToDeadline, isMcq, save]);

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
        <p className="text-xs font-semibold text-[var(--ma-brand)]">{isMcq ? 'Multiple choice' : 'Short answer'} · {attempt.station.maxMarks} marks</p>
        <h2 id="practical-mock-question" className="ma-question-stem mt-2 whitespace-pre-wrap font-serif-academic">{attempt.station.question}</h2>
      </div>
      {isMcq && attempt.station.options ? <div role="radiogroup" aria-labelledby="practical-mock-question" className="space-y-2.5">
        {Object.entries(attempt.station.options).map(([key, text]) => {
          const selected = answer.trim().toUpperCase() === key;
          return <button key={key} type="button" role="radio" aria-checked={selected} disabled={skipping || seconds === 0}
            className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left text-sm transition ${selected ? 'border-[var(--ma-brand)] bg-blue-50/70 ring-1 ring-[var(--ma-brand)]' : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50'}`}
            onClick={() => {
              latestAnswer.current = key;
              if (key === latestSaved.current && !pending.current) draftStartedAt.current = null;
              else draftStartedAt.current ??= performance.now();
              setAnswer(key);
            }}>
            <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${selected ? 'bg-[var(--ma-brand)] text-white' : 'border border-slate-300 bg-slate-50 text-slate-700'}`}>{key}</span>
            <span className="flex-1 pt-0.5 leading-snug text-slate-900">{text}</span>
          </button>;
        })}
      </div> : <>
        <label className="block text-sm font-semibold" htmlFor="practical-mock-answer">Your answer</label>
        <textarea id="practical-mock-answer" rows={5} maxLength={maxPracticalAnswerLength} value={answer}
          className="w-full rounded-lg border border-slate-300 bg-white p-3 text-sm" placeholder="Write your answer…"
          onChange={event => {
            const text = event.target.value;
            latestAnswer.current = text;
            if (text === latestSaved.current && !pending.current) draftStartedAt.current = null;
            else draftStartedAt.current ??= performance.now();
            setAnswer(text);
          }}
          onBlur={() => { if (!error && !skipping) void save(); }} />
      </>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600" role="status">{saving ? 'Saving…' : answer === savedAnswer ? (savedAnswer ? 'Answer saved.' : isMcq ? 'Select an option.' : 'Your answer saves as you type.') : 'Answer awaiting save.'}</p>
        {!confirmSkip && <button type="button" className={secondary} disabled={skipping || seconds === 0}
          onClick={() => setConfirmSkip(true)}>Skip slide</button>}
      </div>
      {confirmSkip && <div role="region" aria-label="Confirm skip station" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-slate-900">
        <p className="font-medium">Are you sure you want to skip this slide? You cannot go back once you skip.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primary} disabled={skipping} onClick={() => { void skip(); }}>{skipping ? 'Skipping…' : 'Confirm skip'}</button>
          <button type="button" className={secondary} disabled={skipping} onClick={() => setConfirmSkip(false)}>Cancel</button>
        </div>
      </div>}
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
  const [pollFinished, setPollFinished] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const requestedGrade = useRef(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const activeController = useRef<AbortController | null>(null);
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;
  const id = attempt.id;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      activeController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const request = useCallback(async (grade = false, manual = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (manual) setError('');
    if (grade) setGrading(true);
    const controller = new AbortController();
    activeController.current = controller;
    const timer = window.setTimeout(() => controller.abort(), grade ? 30_000 : 20_000);
    try {
      const next = await (grade ? api.gradePracticalMock(id, controller.signal) : api.getPracticalMock(id, controller.signal));
      if (!alive.current) return;
      setError('');
      setPollFinished(false);
      setView(timedView(next));
    } catch (error) {
      if (!alive.current) return;
      setError(controller.signal.aborted ? 'Your answers are saved. Check for results again shortly.' : (error as Error).message);
      setPollTick(tick => tick + 1);
      if (grade && attemptRef.current.status === 'finished') setPollFinished(true);
    } finally {
      window.clearTimeout(timer);
      if (activeController.current === controller) activeController.current = null;
      inFlight.current = false;
      if (alive.current && grade) setGrading(false);
    }
  }, [id]);
  const refresh = useCallback(() => { void request(false, false); }, [request]);
  const manualRefresh = useCallback(() => { void request(false, true); }, [request]);

  useEffect(() => {
    if (attempt.status === 'finished' && !attempt.gradingError && !requestedGrade.current) {
      requestedGrade.current = true;
      void request(true, false);
      return;
    }
    if (!visible) return;
    if (attempt.status === 'grading' || (attempt.status === 'finished' && pollFinished)) {
      const delay = attempt.status === 'grading'
        ? Math.min(30_000, Math.max(attempt.retryInMs, error ? 10_000 : 5000))
        : 5000;
      const poll = window.setTimeout(refresh, delay + Math.random() * 2000);
      return () => window.clearTimeout(poll);
    }
  }, [attempt, error, pollFinished, pollTick, visible, refresh, request]);

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
      <button type="button" className={secondary} onClick={manualRefresh}>Retry connection</button>
    </div>}
    {attempt.status === 'active' && <Station key={`${attempt.stationIndex}:${attempt.revision}`} attempt={attempt} deadline={deadline} onClosed={refresh} onRefresh={refresh} onSkipped={next => setView(timedView(next))} />}
    {(attempt.status === 'grading' || attempt.status === 'finished') && (() => {
      const stations = attempt.stations ?? [];
      const mcqStations = stations.filter(s => s.questionType === 'mcq' && s.grade);
      const mcqScore = mcqStations.reduce((sum, s) => sum + (s.grade?.score ?? 0), 0);
      const mcqMax = mcqStations.reduce((sum, s) => sum + s.maxMarks, 0);
      return <>
        <div className="ma-dashboard-panel space-y-2" role="status">
          <h2 className="text-lg font-semibold">Exam submitted</h2>
          {mcqStations.length > 0 && (
            <p className="text-xl font-bold tabular-nums text-[var(--ma-brand)]">MCQ score: {mcqScore}/{mcqMax} marks</p>
          )}
          <p className="text-sm text-slate-600">All written model answers and your MCQ results are shown below for review.</p>
        </div>
        {stations.map((station, index) => {
          const isMcq = station.questionType === 'mcq' && Boolean(station.options);
          const selectedKey = station.answer.trim().toUpperCase();
          return <details key={index} open={!isMcq} className="ma-dashboard-panel">
            <summary className="cursor-pointer font-semibold">
              Station {index + 1} · {isMcq ? `MCQ · ${station.grade ? `${station.grade.score}/${station.maxMarks} marks` : ''}` : `Written · ${station.maxMarks} marks`}
            </summary>
            <div className="mt-4 space-y-4">
              <QuestionImages images={station.images} />
              <h3 className="ma-question-stem whitespace-pre-wrap font-serif-academic">{station.question}</h3>
              {isMcq && station.options ? <div className="space-y-2">
                {Object.entries(station.options).map(([key, text]) => {
                  const isCorrect = key === station.correctOption;
                  const isPicked = key === selectedKey;
                  const style = isCorrect ? 'border-emerald-500 bg-emerald-50 text-emerald-950' : isPicked ? 'border-red-400 bg-red-50 text-red-950' : 'border-slate-200 bg-white text-slate-700';
                  return <div key={key} className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-sm ${style}`}>
                    <span className="font-bold">{key})</span>
                    <span className="flex-1">{text}</span>
                    {isCorrect && <span className="text-xs font-semibold text-emerald-700">Correct</span>}
                    {isPicked && !isCorrect && <span className="text-xs font-semibold text-red-700">Your choice</span>}
                  </div>;
                })}
                {!selectedKey && <p className="text-sm text-slate-600">Unanswered</p>}
              </div> : <p className="whitespace-pre-wrap text-sm"><strong>Your answer</strong><br />{station.answer || 'Unanswered'}</p>}
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-sm">
                <p className="font-semibold text-emerald-900">Model answer</p>
                <p className="mt-1 whitespace-pre-wrap text-slate-900">{station.modelAnswer}</p>
              </div>
            </div>
          </details>;
        })}
      </>;
    })()}
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
  const exam = new URLSearchParams(window.location.search).get('exam') || undefined;
  const [cards, setCards] = useState<PracticalMockCard[] | null>(null);
  const [attempt, setAttempt] = useState<PracticalMockAttempt | null>(null);
  const [authoring, setAuthoring] = useState(false);
  const [gradingExam, setGradingExam] = useState<{ id: string; title: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try { setCards(await api.getPracticalMocks(exam)); }
    catch (error) { setError((error as Error).message); }
  }, [exam]);
  useEffect(() => { void load(); }, [load]);

  async function open(card: PracticalMockCard) {
    setOpening(card.id);
    setError('');
    try { setAttempt(await (card.status === 'ready' ? api.startPracticalMock(card.id) : api.getPracticalMock(card.id))); }
    catch (error) { setError((error as Error).message); }
    finally { setOpening(null); setConfirm(null); }
  }

  if (gradingExam) return <PracticalMockGrader examId={gradingExam.id} examTitle={gradingExam.title} onBack={() => { setGradingExam(null); void load(); }} />;
  if (attempt) return <PracticalMockRunner initial={attempt} onExit={() => { setAttempt(null); void load(); }} />;
  if (authoring) return <div className="max-w-3xl"><PracticalMockAuthor onCancel={() => setAuthoring(false)} onPublished={() => { setAuthoring(false); void load(); }} /></div>;
  return <div className="max-w-4xl space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-bold">Practical Mock Exams</h1>
        <p className="mt-2 text-sm text-slate-600">Answer each slide before its timer ends. Slides advance automatically.</p></div>
      {isAdmin && <button type="button" className={primary} onClick={() => setAuthoring(true)}>Create exam</button>}
    </header>
    {error && <div className="ma-dashboard-panel space-y-2" role="alert"><p className="text-sm text-red-700">{error}</p>
      <button type="button" className={secondary} onClick={() => { void load(); }}>Try again</button></div>}
    {!cards && !error && <p role="status">Loading exams…</p>}
    {cards?.length === 0 && <div className="ma-dashboard-panel text-sm text-slate-600">{exam ? 'This exam is unavailable.' : 'No practical mock exams have been published yet.'}</div>}
    <div className="grid gap-4 sm:grid-cols-2">
      {cards?.map(card => <article key={card.id} className="ma-session-card gap-3">
        <ClipboardCheck size={22} className="text-[var(--ma-brand)]" aria-hidden="true" />
        <h2 className="text-lg font-bold">{card.title}</h2>
        <p className="text-sm text-slate-600">{card.stationCount} {card.stationCount === 1 ? 'station' : 'stations'} · {card.stationSeconds ?? practicalStationSeconds} seconds per slide · {card.stationCount * (card.stationSeconds ?? practicalStationSeconds) / 60} minutes</p>
        {confirm === card.id ? <div className="mt-auto space-y-3 pt-2">
          <p className="text-sm">The timer keeps running if you leave. Stations advance automatically, and answers are sent to Gemini for grading after the last station.</p>
          <div className="flex flex-wrap gap-2"><button type="button" className={primary} disabled={Boolean(opening)} onClick={() => { void open(card); }}>Begin timed exam</button>
            <button type="button" className={secondary} disabled={Boolean(opening)} onClick={() => setConfirm(null)}>Cancel</button></div>
        </div> : <div className="mt-auto flex flex-wrap gap-2 pt-2"><button type="button" className={primary} disabled={Boolean(opening)}
          onClick={() => { if (card.status === 'ready') setConfirm(card.id); else void open(card); }}>
          {opening === card.id ? 'Opening…' : { ready: 'Start exam', active: 'Resume exam', finished: 'View grading', graded: 'Review results' }[card.status]}
        </button>{isAdmin && <button type="button" className={secondary} onClick={() => setGradingExam({ id: card.id, title: card.title })}>Grade students</button>}</div>}
      </article>)}
    </div>
  </div>;
}
