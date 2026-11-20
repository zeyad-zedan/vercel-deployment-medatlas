import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBoundedRateLimiter, createPostgresRateLimitStore } from '../middleware/rate-limit.ts';

const hasLocalDb = Boolean(process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).port === '56350');

test('H7: in-memory saturation evicts low-count legitimate keys while strictly protecting active blocked keys', async () => {
  const scope = `h7-mem-${randomUUID()}`;
  const limiter = createBoundedRateLimiter({
    scope,
    windowMs: 60_000,
    maxRequests: 5,
    maxKeys: 10,
    keyGenerator: (req) => String((req as any).testKey),
  });
  const hit = async (testKey: string) => {
    let status = 200;
    await limiter(
      { testKey, headers: {}, socket: { remoteAddress: '127.0.0.1' }, app: { get: () => false } } as any,
      { setHeader() {}, status(c: number) { status = c; return this; }, json() { return this; } } as any,
      () => {},
    );
    return status;
  };

  // One actively blocked abuser (count = 5 == maxRequests)
  for (let i = 0; i < 5; i++) assert.equal(await hit('abuser'), 200);
  assert.equal(await hit('abuser'), 429);

  // Fill remaining 9 slots with legitimate students who each made 2 requests (count = 2 < maxRequests)
  for (let i = 0; i < 9; i++) {
    assert.equal(await hit(`student-${i}`), 200);
    assert.equal(await hit(`student-${i}`), 200);
  }

  // A brand-new legitimate student MUST be admitted by evicting a count=2 student, NOT fail-closed 429!
  assert.equal(await hit('new-student'), 200, 'Legitimate saturation must evict low-count keys instead of 429 DoS');

  // The actively blocked abuser (count >= maxRequests) MUST still be blocked!
  assert.equal(await hit('abuser'), 429, 'Actively blocked abuser must never be evicted');
});

test('H7 + Timezone: PostgreSQL rate_limit_buckets preserves UTC window math across non-UTC TZ and avoids multi-request saturation DoS', { skip: !hasLocalDb }, async () => {
  const pgStore = createPostgresRateLimitStore();
  const scope = `h7-pg-${randomUUID()}`;
  const now = Date.now();
  const windowMs = 60_000;
  try {
    // 1. Verify exact UTC resetAt regardless of Node TZ (e.g. Africa/Cairo UTC+2)
    const first = await pgStore.consume({
      key: `${scope}:tz-check`,
      scope,
      windowMs,
      maxRequests: 5,
      maxKeys: 10,
      nowMs: now,
    });
    assert.equal(first.allowed, true);
    assert.ok(
      Math.abs(first.resetAt - (now + windowMs)) < 2000,
      `Expected resetAt near now+60s (${now + windowMs}), got ${first.resetAt} (drift ${first.resetAt - (now + windowMs)}ms)`,
    );

    // Expired window resets cleanly at now + windowMs + 1000
    const afterExpiry = await pgStore.consume({
      key: `${scope}:tz-check`,
      scope,
      windowMs,
      maxRequests: 5,
      maxKeys: 10,
      nowMs: now + windowMs + 1000,
    });
    assert.equal(afterExpiry.count, 1, 'Expired bucket must reset to count=1');

    await pgStore.clear?.(scope);

    // 2. Verify saturation with count=2 legitimate keys evicts low-count keys while keeping blocked count>=maxRequests keys
    for (let i = 0; i < 5; i++) {
      await pgStore.consume({ key: `${scope}:abuser`, scope, windowMs, maxRequests: 5, maxKeys: 10, nowMs: now });
    }
    const abuserBlocked = await pgStore.consume({ key: `${scope}:abuser`, scope, windowMs, maxRequests: 5, maxKeys: 10, nowMs: now });
    assert.equal(abuserBlocked.allowed, false);

    for (let i = 0; i < 9; i++) {
      await pgStore.consume({ key: `${scope}:stu-${i}`, scope, windowMs, maxRequests: 5, maxKeys: 10, nowMs: now });
      await pgStore.consume({ key: `${scope}:stu-${i}`, scope, windowMs, maxRequests: 5, maxKeys: 10, nowMs: now });
    }

    const newStudent = await pgStore.consume({ key: `${scope}:new-stu`, scope, windowMs, maxRequests: 5, maxKeys: 10, nowMs: now });
    assert.equal(newStudent.allowed, true, 'Postgres store must evict count<maxRequests keys instead of failing closed');

    const abuserStillBlocked = await pgStore.consume({ key: `${scope}:abuser`, scope, windowMs, maxRequests: 5, maxKeys: 10, nowMs: now });
    assert.equal(abuserStillBlocked.allowed, false, 'Postgres store must keep active blocked key (count>=maxRequests)');
  } finally {
    await pgStore.clear?.(scope);
    const { pool } = await import('../db/index.ts');
    await pool.end();
  }
});
