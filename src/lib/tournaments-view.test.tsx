import React, { act } from 'react';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { api } from './api.ts';
import { tournamentsEnabled, type TournamentBoard } from './study-rewards.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
const replaced = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  HTMLDialogElement: dom.window.HTMLDialogElement,
  FormData: dom.window.FormData,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  replaced.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const { default: TournamentsView } = await import('../components/TournamentsView.tsx');
const realApi = { ...api };

after(() => {
  Object.assign(api, realApi);
  dom.window.close();
  for (const [name, descriptor] of replaced) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as any)[name];
  }
});

const host = () => dom.window.document.getElementById('root')! as HTMLElement;
const text = () => host().textContent || '';
const findButton = (label: string) => {
  const btn = [...host().querySelectorAll<HTMLButtonElement>('button')].find(
    b => b.textContent?.trim().includes(label) || b.getAttribute('aria-label') === label
  );
  assert.ok(btn, `Missing button matching: ${label}`);
  return btn;
};
function reset() {
  Object.assign(api, realApi);
  host().replaceChildren();
}

const activeEvent = {
  id: 10,
  title: 'BSF 112 Autumn Cup',
  startsAt: '2026-11-20T10:00:00.000Z',
  endsAt: '2026-11-30T10:00:00.000Z',
  cancelledAt: null,
  status: 'active' as const,
};

const upcomingEvent = {
  id: 11,
  title: 'BSF 112 Winter Cup',
  startsAt: '2026-12-10T10:00:00.000Z',
  endsAt: '2026-12-20T10:00:00.000Z',
  cancelledAt: null,
  status: 'upcoming' as const,
};

test('TournamentsView does not auto-open the join modal and completes student registration & leaderboard flow', async () => {
  reset();
  assert.equal(tournamentsEnabled, false);
  const unjoinedBoard: TournamentBoard = {
    tournaments: [activeEvent],
    tournament: activeEvent,
    leaders: [],
    ownRank: null,
    participantCount: 0,
  };
  const joinedBoard: TournamentBoard = {
    tournaments: [activeEvent],
    tournament: activeEvent,
    leaders: [
      { rank: 1, nickname: 'PulseKeeper', points: 25 },
      { rank: 1, nickname: 'AtlasMina', points: 25 },
      { rank: 3, nickname: 'NileMedic', points: 10 },
      { rank: 4, nickname: 'ZeroUser', points: 0 },
    ],
    ownRank: { rank: 4, nickname: 'ZeroUser', points: 0 },
    participantCount: 4,
  };
  let joinPayload: { id: number; nickname: string } | null = null;
  api.getTournaments = async () => unjoinedBoard;
  api.joinTournament = async (id, nickname) => {
    joinPayload = { id, nickname };
    return { ...joinedBoard, ownRank: { rank: 4, nickname, points: 0 } };
  };

  let studied = false;
  const root = createRoot(host());
  try {
    await act(async () => root.render(<TournamentsView isAdmin={false} onStudy={() => { studied = true; }} />));
    const dialog = host().querySelector('dialog') as HTMLDialogElement | null;
    assert.ok(dialog, 'Nickname dialog element should be present');
    assert.equal(dialog.hasAttribute('open'), false, 'Join modal must NOT auto-open on initial page load');
    assert.match(text(), /Tournament entry/);
    assert.equal(host().querySelectorAll('table').length, 0, 'Non-participant must not see leaderboard table');

    // User clicks "Choose nickname" explicitly
    await act(async () => { findButton('Choose nickname').click(); });
    assert.equal(dialog.hasAttribute('open'), true, 'Dialog opens when user clicks Choose nickname');

    // Generate nickname & submit
    await act(async () => { findButton('Generate nickname').click(); });
    const input = host().querySelector('#tournament-nickname') as HTMLInputElement;
    assert.match(input.value, /^[A-Za-z]+\d{3}$/);

    const form = host().querySelector('dialog form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });

    assert.ok(joinPayload);
    assert.equal((joinPayload as any).id, 10);
    assert.match(text(), /Your standing/);
    assert.match(text(), /4 participants/);
    // Gold medals on tied rank 1, Bronze on rank 3, no medal on 0-point rank 4
    const medalTexts = [...host().querySelectorAll('.ma-medal-banner')].map(el => el.textContent?.trim());
    assert.deepEqual(medalTexts, ['Gold', 'Gold', 'Bronze']);

    await act(async () => { findButton('Start studying').click(); });
    assert.equal(studied, true);
  } finally {
    await act(async () => root.unmount());
  }
});

test('TournamentsView gives admins spectator leaderboard, non-blocking controls, edit upcoming, and two-step cancel', async () => {
  reset();
  let updatedArgs: any = null;
  let cancelledId: number | null = null;
  api.getTournaments = async () => ({
    tournaments: [upcomingEvent],
    tournament: upcomingEvent,
    leaders: [{ rank: 1, nickname: 'EarlyStudent', points: 0 }],
    ownRank: null,
    participantCount: 1,
  });
  api.updateTournament = async (id, event) => {
    updatedArgs = { id, ...event };
    return { ...upcomingEvent, title: event.title };
  };
  api.cancelTournament = async (id) => {
    cancelledId = id;
    return { ...upcomingEvent, status: 'cancelled', cancelledAt: new Date().toISOString() };
  };

  const root = createRoot(host());
  try {
    await act(async () => root.render(<TournamentsView isAdmin={true} onStudy={() => {}} />));
    const dialog = host().querySelector('dialog') as HTMLDialogElement | null;
    assert.equal(dialog?.hasAttribute('open') ?? false, false, 'Admin must not be blocked by auto-opening modal');
    assert.match(text(), /Admin overview/);
    assert.match(text(), /EarlyStudent/, 'Admin can view standings without participating');

    // Edit upcoming tournament
    await act(async () => { findButton('Edit upcoming tournament').click(); });
    const editForm = host().querySelector('#tournament-edit') as HTMLFormElement;
    assert.ok(editForm, 'Edit form should open for upcoming tournament');
    await act(async () => { editForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.equal(updatedArgs?.id, 11);

    // Two-step cancellation
    await act(async () => { findButton('Cancel tournament').click(); });
    assert.match(text(), /Confirm cancellation/);
    assert.equal(cancelledId, null, 'First click must ask for confirmation');
    await act(async () => { findButton('Confirm cancellation').click(); });
    assert.equal(cancelledId, 11);
  } finally {
    await act(async () => root.unmount());
  }
});

test('TournamentsView renders empty, error, and cancelled states cleanly', async () => {
  reset();
  api.getTournaments = async () => ({ tournaments: [], tournament: null, leaders: [], ownRank: null, participantCount: 0 });
  const root = createRoot(host());
  try {
    await act(async () => root.render(<TournamentsView isAdmin={false} onStudy={() => {}} />));
    assert.match(text(), /No tournaments yet/);

    api.getTournaments = async () => { throw new Error('Network unavailable'); };
    await act(async () => root.render(<TournamentsView key="err" isAdmin={false} onStudy={() => {}} />));
    assert.match(text(), /Network unavailable/);
    assert.ok(findButton('Try again'));

    api.getTournaments = async () => ({
      tournaments: [{ ...activeEvent, status: 'cancelled', cancelledAt: '2026-11-22T12:00:00.000Z' }],
      tournament: { ...activeEvent, status: 'cancelled', cancelledAt: '2026-11-22T12:00:00.000Z' },
      leaders: [],
      ownRank: null,
      participantCount: 0,
    });
    await act(async () => root.render(<TournamentsView key="cancelled" isAdmin={false} onStudy={() => {}} />));
    assert.match(text(), /Tournament cancelled/);
  } finally {
    await act(async () => root.unmount());
  }
});
