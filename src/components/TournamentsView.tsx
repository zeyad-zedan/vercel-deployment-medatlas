import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Ban, CalendarDays, ChevronDown, Medal, Pencil, RefreshCw, Shuffle, Trophy, Users, X } from 'lucide-react';
import { api } from '../lib/api.ts';
import type { TournamentBoard, Tournament } from '../lib/study-rewards.ts';

const cairoDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo',
});
const cairoInputParts = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Africa/Cairo',
});
const pointFormat = new Intl.NumberFormat('en');
const statusLabel: Record<Tournament['status'], string> = {
  active: 'Live',
  upcoming: 'Upcoming',
  completed: 'Finished',
  cancelled: 'Cancelled',
};
const medals = ['Gold', 'Silver', 'Bronze'] as const;
const nicknamePrefixes = ['Atlas', 'Pulse', 'Synapse', 'Cortex', 'Neuron', 'Aorta', 'Suture', 'Vessel', 'Axon', 'Cardio', 'Med', 'Vita'];
const nicknameSuffixes = ['Falcon', 'Fox', 'Lynx', 'Owl', 'Heron', 'Otter', 'Wolf', 'Ibis', 'Raven', 'Kite', 'Finch', 'Swift'];

function formatEventDates({ startsAt, endsAt }: Tournament) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  return cairoDate.formatRange?.(start, end) ?? `${cairoDate.format(start)} – ${cairoDate.format(end)}`;
}

function toCairoDateTimeInput(iso: string): string {
  const parts = Object.fromEntries(
    cairoInputParts.formatToParts(new Date(iso)).map(part => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export default function TournamentsView({ isAdmin, onStudy }: { isAdmin: boolean; onStudy: () => void }) {
  const [board, setBoard] = useState<TournamentBoard | null>(null);
  const [selection, setSelection] = useState<number>();
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nickname, setNickname] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');
  const leaderboardHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterJoin = useRef(false);
  const nicknameDialog = useRef<HTMLDialogElement>(null);
  const nicknameInput = useRef<HTMLInputElement>(null);
  const joinButton = useRef<HTMLButtonElement>(null);
  const event = board?.tournament;
  const canJoin = Boolean(event && (event.status === 'upcoming' || event.status === 'active') && !board?.ownRank);
  const canViewBoard = Boolean(event && board && (board.ownRank || isAdmin));

  function openNicknameDialog() {
    const dialog = nicknameDialog.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
      nicknameInput.current?.focus();
    }
  }

  function closeNicknameDialog() {
    const dialog = nicknameDialog.current;
    if (!dialog) return;
    if (dialog.open) {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
        joinButton.current?.focus();
      }
    }
  }

  useEffect(() => {
    const request = new AbortController();
    const timeout = window.setTimeout(() => {
      request.abort();
      setError('Tournaments is taking longer than expected to load.');
      setLoading(false);
    }, 15_000);
    api.getTournaments(selection, request.signal).then(result => {
      if (!request.signal.aborted) setBoard(result);
    }).catch(err => {
      if (!request.signal.aborted) setError(err.message);
    }).finally(() => {
      window.clearTimeout(timeout);
      if (!request.signal.aborted) setLoading(false);
    });
    return () => {
      window.clearTimeout(timeout);
      request.abort();
    };
  }, [selection, reload]);

  useEffect(() => {
    if (board?.ownRank && focusAfterJoin.current) {
      focusAfterJoin.current = false;
      leaderboardHeading.current?.focus();
    }
  }, [board]);

  function selectBoard(id?: number) {
    closeNicknameDialog();
    setSelection(id);
    setError('');
    setJoinError('');
    if (id !== event?.id) setNickname('');
    setLoading(true);
    setReload(value => value + 1);
  }

  function generateNickname() {
    const prefix = nicknamePrefixes[Math.floor(Math.random() * nicknamePrefixes.length)];
    const suffix = nicknameSuffixes[Math.floor(Math.random() * nicknameSuffixes.length)];
    const number = 100 + Math.floor(Math.random() * 900);
    const suggestion = `${prefix}${suffix}${number}`;
    setNickname(current => current === suggestion
      ? `${prefix}${suffix}${number === 999 ? 100 : number + 1}`
      : suggestion);
    setJoinError('');
  }

  async function join(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!event) return;
    setJoining(true);
    setJoinError('');
    try {
      const joined = await api.joinTournament(event.id, nickname);
      focusAfterJoin.current = true;
      closeNicknameDialog();
      setBoard(joined);
      setNickname('');
    } catch (err) {
      setJoinError((err as Error).message);
    } finally { setJoining(false); }
  }

  const eventHeader = event && board && (
    <div className="ma-tournament-event" aria-busy={loading}>
      <div className="ma-event-content">
        <span className={`ma-event-status ma-event-status-${event.status}`}>{statusLabel[event.status]}</span>
        <h1>{event.title}</h1>
        <p><CalendarDays size={16} aria-hidden="true" /> <span>{formatEventDates(event)} · Cairo time</span></p>
      </div>
      {board.tournaments.length > 1 && (
        <label className="ma-tournament-select">Tournament
          <select value={event.id} disabled={loading || joining} onChange={e => selectBoard(Number(e.target.value))}>
            {board.tournaments.map(item => <option key={item.id} value={item.id}>{item.title} · {statusLabel[item.status]}</option>)}
          </select>
        </label>
      )}
    </div>
  );

  const joinDialog = canJoin && (
    <dialog ref={nicknameDialog} aria-labelledby="nickname-dialog-title" aria-describedby="nickname-dialog-description"
      onClose={() => joinButton.current?.focus()} onCancel={e => { if (joining) e.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-lg backdrop:bg-slate-900/50 backdrop:backdrop-blur-xs">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="nickname-dialog-title" className="text-lg font-bold">Join tournament</h2>
        <button type="button" aria-label="Close nickname dialog" disabled={joining}
          onClick={closeNicknameDialog}
          className="cursor-pointer rounded-lg p-1.5 text-slate-500 hover:text-slate-700">
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <form onSubmit={join}>
        <p id="nickname-dialog-description">Choose the nickname other students will see on the leaderboard.</p>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <label htmlFor="tournament-nickname">Nickname</label>
          <button type="button" className="ma-text-button min-h-9" disabled={joining || loading}
            onClick={generateNickname}><Shuffle size={15} aria-hidden="true" /> Generate nickname</button>
        </div>
        <input id="tournament-nickname" ref={nicknameInput} value={nickname} onChange={e => setNickname(e.target.value)} dir="auto"
          minLength={3} maxLength={24} required autoComplete="off" placeholder="e.g. AtlasMedic" disabled={joining || loading} />
        {joinError && <p role="alert" className="ma-reward-error">{joinError}</p>}
        <button type="submit" className="ma-reward-button ma-reward-primary" disabled={joining || loading}>
          {joining ? 'Joining…' : 'Join tournament'} <ArrowRight size={16} aria-hidden="true" />
        </button>
      </form>
    </dialog>
  );

  return (
    <div className="ma-tournament-page">
      {error && <div className="ma-tournament-message" role="alert">
        <p>{error}</p><button type="button" className="ma-reward-button" onClick={() => selectBoard(selection)}>Try again</button>
      </div>}
      {loading && !board && <p className="ma-tournament-message" role="status">Loading tournaments…</p>}
      {!loading && !error && !event && <div className="ma-tournament-message">
        <span className="ma-reward-icon"><Trophy size={20} aria-hidden="true" /></span>
        <div><h1>No tournaments yet</h1><p>Come back here when the next tournament is announced.</p></div>
      </div>}
      {event && board && !canViewBoard && (
        <>
          {eventHeader}
          <section className="ma-tournament-panel ma-tournament-gate" aria-labelledby="tournament-entry-heading">
            {event.status === 'cancelled' ? (
              <><h2 id="tournament-entry-heading">Tournament cancelled</h2><p>This tournament was cancelled. Check back for the next scheduled event.</p></>
            ) : event.status === 'completed' ? (
              <><h2 id="tournament-entry-heading">Entries are closed</h2><p>Participants can view the final standings. Check back for the next tournament.</p></>
            ) : (
              <>
                <h2 id="tournament-entry-heading">Tournament entry</h2>
                <p>Join with a nickname to enter the competition and view the leaderboard.</p>
                <button type="button" className="ma-reward-button ma-reward-primary mt-3" ref={joinButton}
                  disabled={loading} onClick={openNicknameDialog}>Choose nickname</button>
              </>
            )}
          </section>
        </>
      )}
      {event && board && canViewBoard && (
        <div className="ma-tournament-grid">
          <section className="ma-leaderboard" aria-labelledby="tournament-rank-heading" aria-busy={loading || joining}>
            {eventHeader}
            <header>
              <div><h2 id="tournament-rank-heading" ref={leaderboardHeading} tabIndex={-1}>Leaderboard</h2>
                <p><Users size={15} aria-hidden="true" /> {pointFormat.format(board.participantCount)} {board.participantCount === 1 ? 'participant' : 'participants'}</p>
              </div>
              <button type="button" className="ma-reward-button" disabled={loading || joining} onClick={() => selectBoard(event.id)}>
                <RefreshCw size={15} aria-hidden="true" /> {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </header>
            {board.leaders.length ? (
              <table>
                <thead><tr><th scope="col">Rank</th><th scope="col">Nickname</th><th scope="col">Points</th></tr></thead>
                <tbody>
                  {board.leaders.map(entry => {
                    const medal = entry.points > 0 ? medals[entry.rank - 1] : undefined;
                    const own = entry.nickname === board.ownRank?.nickname;
                    return (
                      <tr key={entry.nickname} className={medal ? `ma-medal-row ma-medal-${medal.toLowerCase()}` : own ? 'ma-rank-own' : undefined}>
                        <td><span className="ma-rank-number">{entry.rank}</span></td>
                        <th scope="row">
                          <bdi>{entry.nickname}</bdi>{own && <span className="ma-rank-you">You</span>}
                          {medal && <span className="ma-medal-banner"><Medal size={14} aria-hidden="true" />{medal}</span>}
                        </th>
                        <td>{pointFormat.format(entry.points)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="ma-leaderboard-empty">
                {event.status === 'cancelled'
                  ? 'This tournament was cancelled before any participants joined.'
                  : event.status === 'completed'
                    ? 'This tournament had no participants.'
                    : 'The first nickname to join will appear here.'}
              </p>
            )}
            {board.participantCount > board.leaders.length && <p className="ma-leaderboard-empty">Showing the top {board.leaders.length} participants.</p>}
          </section>
          <section className="ma-tournament-panel ma-tournament-entry" aria-label="Tournament entry">
            {board.ownRank ? (
              <>
                <h2>Your standing</h2>
                <p className="ma-tournament-nickname"><bdi>{board.ownRank.nickname}</bdi></p>
                <dl className="ma-personal-rank">
                  <div><dt>Rank</dt><dd>#{board.ownRank.rank}</dd></div>
                  <div><dt>Points</dt><dd>{pointFormat.format(board.ownRank.points)}</dd></div>
                </dl>
                {event.status === 'cancelled' && <p>This tournament was cancelled. Recorded points remain frozen.</p>}
                {event.status === 'active' && <button type="button" className="ma-reward-button ma-reward-primary" onClick={onStudy}>
                  Start studying <ArrowRight size={16} aria-hidden="true" />
                </button>}
              </>
            ) : (
              <>
                <h2>Admin overview</h2>
                <p>You are viewing standings without participating.</p>
                {canJoin && (
                  <button type="button" className="ma-reward-button mt-3" ref={joinButton} disabled={loading} onClick={openNicknameDialog}>
                    Join as participant
                  </button>
                )}
              </>
            )}
          </section>
          <section className="ma-tournament-panel ma-tournament-rules">
            <h2>How scoring works</h2>
            <dl className="ma-point-scale">
              <div><dt>Easy</dt><dd>+2</dd></div><div><dt>Medium</dt><dd>+3</dd></div><div><dt>Hard</dt><dd>+5</dd></div>
            </dl>
            <p>Each question earns points the first time you get it right after joining. Short answers earn points at full marks. Questions without a difficulty count as medium.</p>
          </section>
        </div>
      )}
      {joinDialog}
      {isAdmin && (
        <AdminTournamentControls
          event={event ?? null}
          onChanged={selectBoard}
        />
      )}
    </div>
  );
}

function AdminTournamentControls({ event, onChanged }: { event: Tournament | null; onChanged: (id?: Tournament['id']) => void }) {
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setEditOpen(false);
    setConfirmCancel(false);
    setError('');
  }, [event?.id, event?.status]);

  async function schedule(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setError('');
    try {
      const { id } = await api.createTournament({
        title: String(form.get('title')), startsAt: String(form.get('startsAt')), endsAt: String(form.get('endsAt')),
      });
      setScheduleOpen(false);
      onChanged(id);
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  async function saveEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!event) return;
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setError('');
    try {
      const updated = await api.updateTournament(event.id, {
        title: String(form.get('title')), startsAt: String(form.get('startsAt')), endsAt: String(form.get('endsAt')),
      });
      setEditOpen(false);
      onChanged(updated.id);
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  async function handleCancel() {
    if (!event) return;
    setSaving(true);
    setError('');
    try {
      const cancelled = await api.cancelTournament(event.id);
      setConfirmCancel(false);
      onChanged(cancelled.id);
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  const canEdit = event?.status === 'upcoming';
  const canCancel = event?.status === 'upcoming' || event?.status === 'active';

  return (
    <section className="ma-tournament-admin" aria-label="Tournament administration">
      <div className="ma-tournament-admin-actions">
        <button type="button" className="ma-reward-button" aria-expanded={scheduleOpen} aria-controls="tournament-schedule"
          onClick={() => { setScheduleOpen(!scheduleOpen); setEditOpen(false); setConfirmCancel(false); setError(''); }}>
          Schedule a tournament <ChevronDown size={16} aria-hidden="true" />
        </button>
        {canEdit && (
          <button type="button" className="ma-reward-button" aria-expanded={editOpen} aria-controls="tournament-edit"
            onClick={() => { setEditOpen(!editOpen); setScheduleOpen(false); setConfirmCancel(false); setError(''); }}>
            <Pencil size={15} aria-hidden="true" /> Edit upcoming tournament
          </button>
        )}
        {canCancel && (
          <button type="button" className="ma-reward-button" aria-expanded={confirmCancel}
            onClick={() => { setConfirmCancel(!confirmCancel); setScheduleOpen(false); setEditOpen(false); setError(''); }}>
            <Ban size={15} aria-hidden="true" /> Cancel tournament
          </button>
        )}
      </div>

      {scheduleOpen && (
        <form id="tournament-schedule" onSubmit={schedule}>
          <label>Name<input name="title" required minLength={3} maxLength={80} /></label>
          <label>Starts · Cairo time<input name="startsAt" type="datetime-local" required /></label>
          <label>Ends · Cairo time<input name="endsAt" type="datetime-local" required /></label>
          <button className="ma-reward-button ma-reward-primary" type="submit" disabled={saving}>{saving ? 'Scheduling…' : 'Schedule'}</button>
          {error && <p className="ma-reward-error" role="alert">{error}</p>}
        </form>
      )}

      {editOpen && event && (
        <form id="tournament-edit" key={event.id} onSubmit={saveEdit}>
          <label>Name<input name="title" defaultValue={event.title} required minLength={3} maxLength={80} /></label>
          <label>Starts · Cairo time<input name="startsAt" type="datetime-local" defaultValue={toCairoDateTimeInput(event.startsAt)} required /></label>
          <label>Ends · Cairo time<input name="endsAt" type="datetime-local" defaultValue={toCairoDateTimeInput(event.endsAt)} required /></label>
          <button className="ma-reward-button ma-reward-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
          {error && <p className="ma-reward-error" role="alert">{error}</p>}
        </form>
      )}

      {confirmCancel && event && (
        <div className="ma-tournament-panel mt-2" role="alertdialog" aria-labelledby="cancel-tournament-heading">
          <h2 id="cancel-tournament-heading">Cancel “{event.title}”?</h2>
          <p>Cancelling stops new entries and freezes scoring immediately. Historical participant records are preserved.</p>
          <div className="ma-tournament-admin-actions mt-3">
            <button type="button" className="ma-reward-button ma-reward-primary" disabled={saving} onClick={handleCancel}>
              {saving ? 'Cancelling…' : 'Confirm cancellation'}
            </button>
            <button type="button" className="ma-reward-button" disabled={saving} onClick={() => setConfirmCancel(false)}>
              Keep tournament
            </button>
          </div>
          {error && <p className="ma-reward-error mt-2" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}
