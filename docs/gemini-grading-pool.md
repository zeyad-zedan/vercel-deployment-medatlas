# Shared Gemini grading keys

The server supports up to **20 authorized Gemini API keys**. A configured pool replaces student-key grading for all students; an empty variable preserves the existing student-owned-key flow. No key-status polling or extra student setup is needed. Invalid pool configuration fails closed instead of silently spending a student's quota.

## Put the keys here

1. Open the **MedAtlas Vercel project → Settings → Environment Variables**.
2. Add **`GEMINI_GRADING_POOL`**, select **Production**, and choose **Secret** (or Sensitive on older dashboards).
3. Paste a JSON array in the value field, replacing the placeholders below. Add up to 20 objects; do not leave placeholder entries.
4. Save, then **redeploy Production** so the running server receives the new secret. Existing deployments do not pick up environment changes.

```json
[
  {"key":"COMPLETE_FIRST_API_KEY","project":"actual-google-project-id","rpm":5,"concurrency":2},
  {"key":"COMPLETE_SECOND_API_KEY","project":"another-google-project-id","rpm":5,"concurrency":2}
]
```

`project` is the actual Google Cloud **project ID**, not the Google account email, display name or key name. Copy it from AI Studio/Google Cloud. Keys from the **same project must have the same project ID, rpm and concurrency**. Duplicate keys and invalid configurations are rejected without disclosing their contents.

`rpm` is the pool's maximum start rate for that project/model (default 5, evenly spaced), and `concurrency` caps simultaneous grades per project (default 2). Set these at or below the project's actual available model quotas in AI Studio; token/day limits can still be reached. A pool does not increase the provider's quota. Use only projects permitted for this application, not extra accounts/projects created to circumvent limits.

Keys remain in Vercel's server environment and are sent to Google in the `x-goog-api-key` header. Never use `VITE_`/`NEXT_PUBLIC_` prefixes, a frontend settings field, chat, Telegram, a public JSON file, Git or screenshots to transfer these shared keys. Restrict each key to the Gemini/Generative Language API in Google Cloud. Use separate development keys if testing locally, and keep their environment file gitignored. This Express app loads `.env` via dotenv; it does not automatically load `.env.local`.

## Behavior

- Round-robin selection sends consecutive requests through the configured slots in order, skipping unavailable keys. The cursor and leases share one PostgreSQL row lock, so separate server instances cannot reserve the same key concurrently. The row contains hashes, counters, timestamps and leases only.
- A temporary Google server error can trigger one automatic retry with an eligible key, within the same 22-second total budget. Slow requests receive the remaining budget without a premature 12-second abort. Timeouts and uncertain network failures keep the answer saved for a student retry rather than duplicating a possibly running provider request.
- HTTP 429 alone is not proof of exhausted project quota. A structured Google `QuotaFailure` or explicit quota error pauses that project, honoring `Retry-After` and `RetryInfo` (at least 60 seconds, up to 24 hours). Other 429s pause only the affected key and make at most two provider calls per grading request. Independent healthy projects remain eligible, including after two unrelated rejections; stale global cooldowns from older deployments are ignored. A rejected or model-ineligible key pauses for ten minutes. A malformed request is reported separately. Busy keys have 30-second leases so crashed work recovers.
- Shared-pool students can retry saved answers after **10 seconds**, including after quota failures. Provider and project cooldowns remain in the pool, so a retry only uses an eligible credential. Personal-key grading retains longer provider-required waits. Feedback stays brief while preserving every rubric point and its explanation. Slow provider calls (5 seconds or more), errors and failovers emit timings and error codes without answers or credentials.
- After a student requests grading, quiz and standalone short-answer screens automatically retry temporary failures at the server-provided retry time, up to three times while the unchanged answer remains open. Editing the answer, leaving the question or unmounting cancels the scheduled retry. Opening saved answers never initiates grading. Confirmed quota/access failures are not automatically retried. This recovers transient provider failures; it cannot guarantee a fast response while Google's model is overloaded.
- If all entries are unavailable, the answer stays saved with a retry message. Student keys are not silently used as paid/shared fallbacks. Existing grades, marking rubrics and the per-student request controls remain in place.
- Grading is text-only; no question images, student names or emails are sent to Google. AI feedback still requires instructor review when uncertain.
- Dispatch logs identify only the numbered pool slot. Provider diagnostics retain status, quota metric/limit, retry interval, response-header timing and a redacted rejection explanation. Credentials and grading inputs are removed before that explanation is logged; raw response bodies are not logged.

Apply `supabase/migrations/20261106044218_gemini_grading_pool.sql` before enabling the pool. Its transient coordination table has RLS and no client-role grants. Credentials are never backed up in that table. Restore/deployment environments need their own Vercel Secret configuration.

To disable the pool, remove or empty `GEMINI_GRADING_POOL` and redeploy. Rotate a key by replacing its entry in the Secret and redeploying. The key fingerprint changes automatically; keys in the same project retain their project cooldown.

## Timed practical mock grading

New timed attempts are scheduled for grading when the exam closes, including when the student leaves the page. The worker handles up to five answered stations per batch, stores successful batches, and retries shared-pool failures after 10 seconds. The scheduler runs every minute, so a deferred batch may be picked up on a later tick. The next run can resume a batch after the worker lease expires. Students see the final result once all answered stations are graded. Older unfinished grading attempts can be queued from their result screen.

Apply `supabase/migrations/20261117212043_practical_mock_grading_queue.sql` before deploying the app. Set the server-only Vercel secret `PRACTICAL_GRADING_CRON_SECRET` and store the same value in Supabase Vault under `medatlas_practical_grading_cron`. After deployment, run `supabase/ops/schedule_practical_mock_grading.sql` on the production database. Supabase Cron checks for due attempts every minute and calls the Vercel worker when there is work. The scheduler sends only a Unix timestamp in seconds and its hex HMAC-SHA256 signature. The endpoint accepts signatures within two minutes of the server clock.

The save API reports account checks, connection wait and database round-trip time in the `Server-Timing` header. Slow saves, deferred grading batches and worker totals emit structured logs for investigating spikes. These logs exclude answers and API keys.

Run mocked-provider checks with `node --import tsx --test src/lib/gemini-grading-pool.test.ts`. No real Google calls or keys are required.
