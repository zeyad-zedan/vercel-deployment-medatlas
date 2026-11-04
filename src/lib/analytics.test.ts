import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAnalyticsEvent, shouldEnableAnalytics } from './analytics.ts';

test('analytics reports page names without recovery tokens, query values or private session IDs', () => {
  const page = sanitizeAnalyticsEvent({ type: 'pageview', url: 'https://medatlas-exam.vercel.app/session/1234?oobCode=PRIVATE&key=SECRET#student' });
  assert.equal(page?.url, 'https://medatlas-exam.vercel.app/session');
  assert.equal(sanitizeAnalyticsEvent({ type: 'pageview', url: 'https://medatlas-exam.vercel.app/lectures?subject=1' })?.url, 'https://medatlas-exam.vercel.app/lectures');
  assert.equal(sanitizeAnalyticsEvent({ type: 'pageview', url: 'https://medatlas-exam.vercel.app/api/documents/private-reference' }), null);
  assert.equal(sanitizeAnalyticsEvent({ type: 'pageview', url: 'invalid' }), null);
});

test('local and temporary previews do not inflate visitor counts', () => {
  assert.equal(shouldEnableAnalytics(true, 'medatlas-exam.vercel.app'), true);
  assert.equal(shouldEnableAnalytics(false, 'medatlas-exam.vercel.app'), false);
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'sauce-ver-singer-math.trycloudflare.com']) assert.equal(shouldEnableAnalytics(true, host), false);
});
