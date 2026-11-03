import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NODE_ENV = 'test';
const { api, subscribeToBookmarkChanges } = await import('./api.ts');

test('bookmark saves immediately, keeps the request alive, and invalidates cached lists once', async () => {
  const original = globalThis.fetch;
  let calls = 0, changes = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const unsubscribe = subscribeToBookmarkChanges(() => { changes++; });
  globalThis.fetch = (async (path: any, options: any) => {
    calls++;
    assert.equal(path, '/api/bookmarks/toggle');
    assert.equal(options.keepalive, true);
    assert.deepEqual(JSON.parse(options.body), {questionId:123});
    await waiting;
    return new Response(JSON.stringify({bookmarked:true,questionId:123}), {status:200});
  }) as typeof fetch;
  try {
    const first = api.toggleBookmark(123);
    const second = api.toggleBookmark(123);
    assert.equal(calls, 1, 'rapid repeat clicks must not issue two toggles');
    assert.equal(changes, 0, 'never claim Saved before the server acknowledges it');
    release();
    assert.deepEqual(await first, {bookmarked:true,questionId:123});
    await second;
    assert.equal(changes, 1);
  } finally { release(); unsubscribe(); globalThis.fetch = original; }
});

test('failed bookmark saves do not invalidate the list or report success and can be retried', async () => {
  const original = globalThis.fetch;
  let changes = 0;
  const unsubscribe = subscribeToBookmarkChanges(() => { changes++; });
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({error:'Unavailable'}), {status:503})) as typeof fetch;
    await assert.rejects(api.toggleBookmark(456), /Unavailable/);
    assert.equal(changes, 0);
    globalThis.fetch = (async () => new Response(JSON.stringify({bookmarked:true,questionId:456}), {status:200})) as typeof fetch;
    assert.equal((await api.toggleBookmark(456)).bookmarked, true);
    assert.equal(changes, 1);
  } finally { unsubscribe(); globalThis.fetch = original; }
});
