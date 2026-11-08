# Impulse 46 private quizzes

Publisher workspace: `/impulse/upload`. Student links: `/impulse/quiz/<random-slug>`.
Student links render inside the existing MedAtlas React workspace, preserving the top bar,
sidebar and normal sign-in dialog. Signed-in users see only the quiz-password prompt.
The Impulse-branded standalone page is the publisher workspace only. No course item is added
to the normal sidebar or catalog, and private quiz paths are excluded from visitor analytics.
These pages are not linked from the MedAtlas catalog. Quiz data is in the separate,
non-exposed `impulse` Postgres schema; it never creates public lectures or questions.

## Publisher workflow

1. Enter the separate team publisher password.
2. Choose **New quiz** and enter a title and student quiz password (8–128 characters).
3. Add a question photo, then write the question below it.
4. Choose **Short answer** and add model-answer points with marks, or **MCQ** and
   enter answer choices and select the correct one. Photos are optional for either type.
5. Use **Add question** for the next question; types can be mixed in one quiz.
6. Preview, save a draft, or publish. **Copy quiz link** appears in the quiz list.
7. **Edit / password** opens an existing quiz. Leaving the password blank preserves it.
   A draft save does not replace the published version; publishing creates a new immutable version.

Publisher access lasts 24 hours. Its password is independent of student quiz passwords.
Passwords are scrypt hashes on the server; publishers cannot retrieve plaintext quiz passwords.

## Student workflow and persistence

Students sign in to their normal MedAtlas account and enter the quiz password.
Their attempt is keyed by account UID and quiz, not browser storage. A second browser/device
unlocks the same attempt after account sign-in and quiz-password verification. Question content
loads six at a time. Next/Previous saves the current response before moving. MCQ selections save
immediately; written answers have Save and Save & grade controls. Unsaved written drafts also
stay in account-scoped local storage, and closing the page warns about unsaved work.

Submitted answers are immutable. Saved feedback is reused. Grading uses the existing server-side
Gemini pool and sends text only, never photos or account details. Images use the existing validated
Telegram upload/cache service and authenticated, quiz-scoped delivery; no image bytes enter Postgres.

Publishing edits affects new students; existing attempts remain on their original version.
Changing a quiz password requires re-unlocking, but does not replace the account's saved attempt.
No polling or analytics events are added to private quiz pages.

## Deployment preparation

- Apply `supabase/migrations/20261108000140_impulse_private_quizzes.sql` once to the intended database.
  It is additive; there are no changes to existing MedAtlas users, sessions, bookmarks or question banks.
- Provision server-only `IMPULSE_PUBLISHER_PASSWORD_HASH` using `hashPasswordAsync` from the auth module.
  Store the result as a Vercel Secret, and share only the plaintext publisher password with the authorized team.
- Preserve `AUTH_SESSION_SECRET` and existing `GEMINI_GRADING_POOL` settings.
- The schema deliberately has no `anon`, `authenticated` or PUBLIC grants and uses RLS on every table.
  Normal signed-in MedAtlas students do not gain publisher access.
- The publisher password is shared by the Impulse team; this implementation is one partner workspace,
  not a multi-organization CMS. Avoid sharing the publisher password with students.

## Local preview

The git-ignored `private/start-impulse-preview.ts` serves port 4060 with an isolated local Postgres
database on 56350. It checks MedAtlas account tokens through the production `/api/auth/me` endpoint;
the preview uses an independent cookie-signing secret and publisher password. Email/password sign-in
is proxied to MedAtlas. Google sign-in return navigation is integrated in the main application for deployment;
the standalone preview does not host the full Google sign-in flow. Preview quiz data remains local.

Run `src/lib/impulse.test.ts` with `DATABASE_URL=postgres://postgres@127.0.0.1:56350/impulse_preview`.
The test refuses other ports and verifies password gates, CSRF protection, account separation,
cross-device resume, six-question batches, grade caching, version preservation and submitted-answer locking.
