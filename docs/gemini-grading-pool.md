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

- Least-recently-used selection distributes work across eligible keys. Separate server instances coordinate through a small PostgreSQL row; it contains hashes, timestamps and leases only.
- One provider call per grading attempt; no automatic retry with another key after a quota or uncertain network failure. The next explicit grading request can select an eligible project.
- A Google 429 pauses **every configured key in that project**, honoring `Retry-After` (at least 60 seconds, up to 24 hours). A rejected key pauses for ten minutes. Busy keys have 30-second leases so crashed work recovers.
- If all entries are unavailable, the answer stays saved with a retry message. Student keys are not silently used as paid/shared fallbacks. Existing grades, marking rubrics and the per-student request controls remain in place.
- Grading is text-only; no question images, student names or emails are sent to Google. AI feedback still requires instructor review when uncertain.

Apply `supabase/migrations/20261106044218_gemini_grading_pool.sql` before enabling the pool. Its transient coordination table has RLS and no client-role grants. Credentials are never backed up in that table. Restore/deployment environments need their own Vercel Secret configuration.

To disable the pool, remove or empty `GEMINI_GRADING_POOL` and redeploy. Rotate a key by replacing its entry in the Secret and redeploying. The key fingerprint changes automatically; keys in the same project retain their project cooldown.

Run mocked-provider checks with `node --import tsx --test src/lib/gemini-grading-pool.test.ts`. No real Google calls or keys are required.
