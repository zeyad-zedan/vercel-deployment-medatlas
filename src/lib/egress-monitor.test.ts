import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordPdfEgress,
  isPlanBActive,
  setPlanBOverride,
  getEgressStatus,
  _resetEgressStateForTesting,
  EGRESS_THRESHOLD_BYTES,
  SUPABASE_MONTHLY_QUOTA_BYTES,
} from './egress-monitor.js';

beforeEach(() => {
  _resetEgressStateForTesting();
  setPlanBOverride(null);
  delete process.env.FORCE_TELEGRAM_PDF_FALLBACK;
  process.env.TELEGRAM_BOT_TOKEN = 'mock:token';
  process.env.TELEGRAM_CHANNEL_ID = '-100mock';
});

test('starts in normal mode with 0 bytes and Plan B inactive', () => {
  const status = getEgressStatus();
  assert.equal(status.currentBytes, 0);
  assert.equal(status.isPlanBActive, false);
  assert.equal(status.thresholdPercent, 85);
  assert.equal(isPlanBActive(), false);
});

test('tracks cumulative egress bytes accurately', () => {
  recordPdfEgress(1024 * 1024); // 1 MB
  recordPdfEgress(2 * 1024 * 1024); // 2 MB
  const status = getEgressStatus();
  assert.equal(status.currentBytes, 3 * 1024 * 1024);
  assert.equal(status.isPlanBActive, false);
});

test('automatically activates Plan B when egress reaches or exceeds 85%', () => {
  // Add 4.25 GB
  recordPdfEgress(EGRESS_THRESHOLD_BYTES);
  assert.equal(isPlanBActive(), true);

  const status = getEgressStatus();
  assert.equal(status.isPlanBActive, true);
  assert.match(status.statusMessage, /Plan B Active/);
});

test('admin can force-enable Plan B regardless of current egress', () => {
  assert.equal(isPlanBActive(), false);
  setPlanBOverride(true);
  assert.equal(isPlanBActive(), true);

  const status = getEgressStatus();
  assert.equal(status.isPlanBActive, true);
  assert.equal(status.forcedOverride, true);

  // Reset back to auto
  setPlanBOverride(null);
  assert.equal(isPlanBActive(), false);
});

test('admin can force-disable Plan B even if above 85%', () => {
  recordPdfEgress(EGRESS_THRESHOLD_BYTES + 100);
  assert.equal(isPlanBActive(), true);

  setPlanBOverride(false);
  assert.equal(isPlanBActive(), false);
});

test('isPlanBActive returns false if Telegram credentials are not configured', () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  setPlanBOverride(true);
  assert.equal(isPlanBActive(), false);
});
