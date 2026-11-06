# MedAtlas MCQ — Medical Education & Examination Platform

## Interface design system

The shared visual contract lives in `src/styles/design-system.css`, imported by `src/index.css`.
Use its `--ma-*` tokens and `.ma-*` primitives for new screens: evergreen primary actions,
ink text, muted neutral backgrounds, 16px cards, 10px controls, and a 4px spacing scale.
Use one prominent action per group, tabular numerals for statistics, and readable proportional
text for descriptions. Keep success/error colours for outcomes. Subject dropdowns remain native,
keyboard-accessible `details` elements; mobile layouts stack controls and honour reduced motion.
Do not introduce new literal brand colours inside components. The shared Tailwind neutral and
accent palettes also keep existing account, admin, practice, and assessment screens consistent.
Use `PageHeading` for standard workspace pages, `.ma-library-hero` for the library and
session dashboard, and `.ma-empty-state` for empty collections. Standard fields are at least
44px high; phone fields use 16px text to prevent automatic zoom. Dialogs must fit within the
dynamic viewport and scroll internally. Keep study navigation below the 76px workspace header.
The exam timer stays visible in the phone header, and question text has no decorative overlays.
Design changes must not introduce polling or additional database reads.

New accounts choose a username and faculty. Benha University is currently the only option.
Email registration collects these fields immediately; new Google accounts complete their
profile before entering the workspace. Existing accounts retain their display names and are
assigned Benha University by `supabase/migrations/20261103190330_user_academic_profiles.sql`.
The username uses the existing display-name field; sign-in remains email/password or Google.
Run `npm run test:profiles` against an isolated local database to verify this flow.

Lecture completion counts unique published questions answered across study, custom practice,
and submitted exams. Opening a full lecture restores those answers and selects its first
unanswered question; this question number may differ from the number completed. Filtered
practice stays separate. Reopening never deletes sessions or answer history, and completed
attempts remain unchanged when a new cumulative study session is needed.

Answered history is paginated at 25 questions by default (50 maximum), with subject and
answer-status filters applied in PostgreSQL. Saved bookmarks are retained when switching
history pages. Lecture reset responses identify the deleted sessions so the browser clears
only their drafts and positions. Expired exams have one automatic completion attempt and
an explicit retry on failure. Startup connection failures retain the session token and show
a connection retry screen; authentication rejections still end the session. Protected PDF
loading and rendering each retain a concurrency limit of two, with at most six waiting tasks
and a five-second queue timeout. PDF access checks and no-store delivery remain enforced.

PDF storage is Telegram-only. Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_ID` in
the application and local upload portal environments. Uploads must succeed in Telegram
before attachment metadata is saved. Original `/lectures/:filename` routes always return 410.
Students use authenticated `/api/documents/:opaqueReference` metadata and page endpoints.
The server fetches the original from Telegram and renders one protected WebP page.
watermarks and the viewer footer are optional and OFF by default. Administrators can change
the global setting in Admin Console → Overview → PDF security watermarks. Apply
`drizzle/0003_document_watermarks.sql` before deploying. The saved setting is read within the
existing document authorization query; there is no extra settings query per page or polling.
Changing it affects newly loaded pages. It does not disable authentication or file protection.
Original PDF bytes, filenames, and Telegram file identifiers are excluded from API responses.
Every page request checks the active account and current publication/admin permissions, even
when original bytes are cached server-side. Responses use private/no-store headers and per-user
rate limits. Zooming an already rendered page makes no additional database request.
This prevents original-file delivery, not screenshots, image capture, or reconstruction from
visible pages. It increases Vercel rendering/bandwidth work; metadata/auth queries remain small.
Never reintroduce raw-file download links or external-URL fallbacks. The original PDFs belong
in Telegram or ignored `private/lecture-originals/`; builds reject PDFs under `public/`.
Node 22.13+ is required; Vercel uses the configured Node 24 runtime. `pdfjs-dist` and native
canvas binaries/assets must be included in the function bundle, as configured in `vercel.json`.
Before production rollout, verify the native renderer on Vercel, invalidate previously public
CDN copies, and verify that earlier deployments cannot expose the old raw-file endpoint.
The bot-linked upload portal opens without a username or password, as requested by the owner.
Anyone with its tunnel URL can upload or replace PDFs and import questions. Keep that link private.
Its original-file route remains disabled, and same-origin request checks remain active.
Use HTTPS for remote portal access. Future Telegram uploads set `protect_content=true`;
keep the storage channel private and restrict membership. This flag does not change old posts.
PDF contents are never downloaded from PostgreSQL or Supabase Storage.
Existing database PDF blobs are retained for recovery but are excluded from reads and new backups.
The Telegram sync script now validates references only; missing files must be re-uploaded
from original PDFs. The activity listener reads MCQ activity from PostgreSQL on demand and
sends reports through Telegram; Telegram does not replace the MCQ database.

Database egress optimization: apply `drizzle/0002_egress_indexes.sql` statements individually
(outside a transaction), and run `npx tsx scripts/repair-legacy-attempts.ts --apply` once before
deploying the optimized dashboard. The repair is idempotent and only fills missing attempt rows.
The application egress widget is not a Supabase usage meter; use the Supabase dashboard for billing usage.

MedAtlas MCQ is a full-stack lecture-based multiple-choice question (MCQ) learning platform designed for medical students and medical curriculum administrators.

---

## 1. Project Overview

MedAtlas MCQ organizes medical educational content into a strict academic hierarchy:
**Subject → Lecture → Question Bank → Individual Questions**

Key capabilities and security controls implemented in this release:
- **Hardened Authentication, Admin Provisioning & Account Isolation**:
  - **Authoritative Password Credential**: PostgreSQL `users.password_hash` (scrypt-salted async hashing, strictly bounded to `8..128` characters and `<= 512` UTF-8 bytes before any scrypt operation) is the authoritative password credential for email/password sign-in.
  - **Synchronized Password Changes & Recovery**: Authenticated password changes (`POST /api/auth/change-password`) and password linking (`POST /api/auth/link-password`) synchronize with Firebase Authentication when a user has a mapped `firebase_uid` or provider identity, failing closed (`503`) if a required provider update fails so stale provider credentials can never overwrite a newer local password.
  - **Dedicated Session Revocation (`sessions_revoked_at`)**: Session revocation checks use `users.sessions_revoked_at` (never generic `users.updated_at`), ensuring ordinary profile edits (`displayName`, `preferences`) never invalidate active sessions even when `token_version > 1`, while password changes, password resets, logouts, role changes, and account deletions immediately revoke prior sessions.
  - **Fail-Closed Firebase Token Revocation**: `verifyFirebaseIdTokenWithRevocation` and `requireAuth` fail closed (`401`/`403`/`503`) on revoked, disabled, expired, network timeout, permission, or unknown Firebase errors. Narrow fallback when local ADC credentials are absent (`app/invalid-credential`) requires verification against PostgreSQL session/tombstone state and live Identity Toolkit `accounts:lookup`.
  - **Permanent Tombstones & Identity Mapping**: `users` and `deleted_accounts` explicitly track `firebase_uid`. Account deletion removes or disables the Firebase identity (recording `remote_cleanup_status = 'completed' | 'pending_retry'` with `reconcilePendingDeletedAccounts()` retry support) and preserves `deleted_accounts` rows permanently across re-registrations so deleted `uid` and `firebase_uid` values can never be resurrected or used for credential fallback.
- **Firebase-Native Link-Based Password Recovery**:
  - **End-to-End Synchronization**: Password reset requests (`POST /api/auth/forgot-password`) record `users.pending_recovery_at` and dispatch reset links via Firebase Identity Toolkit (`accounts:sendOobCode`) without silent fallback when `continueUrl` is rejected.
  - **Dual Action-Handler & Hosted-Reset Support**: Completing a reset via MedAtlas (`POST /api/auth/reset-password` with `oobCode` or a pasted reset link) performs a 2-phase verification and atomic database update. If a user completes the reset directly on Firebase's hosted action page (`/__/auth/action`), the active `pending_recovery_at` window immediately invalidates the old local password and synchronizes the new Firebase password into PostgreSQL (revoking prior sessions) on first sign-in.
  - **Exact Recovery Origin Allowlist**: Broad wildcard suffix matching (`*.ai.studio`, `*.run.app`) is removed. Only exact allowlisted HTTPS origins (`https://medatlas.ai.studio`, the specific MedAtlas dev/preview Cloud Run URLs, and origins in `APP_URL` / `ALLOWED_RECOVERY_ORIGINS`) are accepted, with `http://localhost` permitted only outside production.
- **Shared PostgreSQL Rate Limiting & DoS Hardening**:
  - Authentication and password mutation endpoints use a shared PostgreSQL rate-limit store (`rate_limit_buckets`) with independent per-IP, per-account/email, and combined IP+email rules, anti-churn capacity protection (preventing single-hit `count === 1` key floods from evicting active `count > 1` blocks), and automatic in-memory fallback.
  - Default JSON body parsing is restricted to `64kb` globally, with `5mb` scoped exclusively to authenticated administrator question import routes (`/api/admin/import/preview` and `/api/admin/import/execute`).
- **Three Practice & Assessment Modes**:
  - **Mode A (Study Mode)**: Immediate feedback after submitting each question, showing the correct answer, primary synthesis explanation, and individual rationales for Options A, B, C, and D.
  - **Mode B (Exam Mode)**: Server-enforced timed exam simulation. Correct answers and explanations are stripped on the server during active exams. Authoritative exam deadlines (`started_at + time_limit_seconds`) are enforced on the server, and `completeExamSession` executes atomically inside a PostgreSQL transaction with `FOR UPDATE` row locking and a unique index (`uq_session_question_attempt`) on `(session_id, question_id)`.
  - **Mode C (Custom Practice)**: Filter by subjects, lectures, difficulty (`Easy`, `Medium`, `Hard`), or tags; shuffle questions/options (`A–D`) with key preservation; and avoid recently answered questions.
- **Strict AST-Based SVG Sanitization**:
  - Question and bookmark SVG diagrams are parsed and sanitized through a strict tag/attribute/CSS allowlist (`sanitizeSvgDiagram`) that decodes HTML/XML entities and strips `<script>`, `<foreignObject>`, event handlers, external references, and dangerous URIs.

---

## 2. Technology Stack

- **Frontend**: React 19, TypeScript (strict), Tailwind CSS v4, Lucide Icons.
- **Backend & Server Logic**: Node.js + Express (`server.ts`) compiled via `esbuild` to `dist/server.js` for production.
- **Database & ORM**: Managed PostgreSQL (Cloud SQL / Supabase compatible) with **Drizzle ORM** (`src/db/schema.ts`, `src/db/index.ts`, `src/db/repository.ts`, `drizzle/0001_security_remediation.sql`).
- **Authentication & Recovery**: Firebase Authentication (`firebase` + `firebase-admin`, Identity Toolkit) and HMAC-SHA256 local session authentication (`src/middleware/auth.ts`).

---

## 3. Production Environment Configuration & Firebase Console Setup

### Required & Optional Environment Variables

| Variable | Required | Purpose |
| :--- | :--- | :--- |
| `AUTH_SESSION_SECRET` | **Yes** | High-entropy secret (minimum 32 characters, >= 10 distinct characters) used to sign and verify HMAC-SHA256 local session tokens (`medatlas.v1.<payload>.<sig>`). Loaded automatically via `dotenv/config` before validation. Generate via: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SQL_HOST` | **Yes** | Cloud SQL Unix socket path (`/cloudsql/<instance-connection-name>`) or PostgreSQL hostname/IP. |
| `SQL_DB_NAME` | **Yes** | PostgreSQL database name (e.g., `postgres`). |
| `SQL_USER` | **Yes** | PostgreSQL runtime application user account. |
| `SQL_PASSWORD` | **Yes** | Password for `SQL_USER`. |
| `SQL_ADMIN_USER` | **Migrations** | PostgreSQL administrative user used by Drizzle Kit when applying schema migrations. |
| `SQL_ADMIN_PASSWORD` | **Migrations** | Password for `SQL_ADMIN_USER`. |
| `APP_URL` | **Runtime** | Canonical HTTPS origin of the deployed application (defaults to `https://medatlas.ai.studio`). Must not contain paths, query strings, or credentials. |
| `ALLOWED_RECOVERY_ORIGINS` | **Optional** | Comma-separated list of exact additional HTTPS origins permitted in password recovery links (no wildcards). |
| `TRUST_PROXY_HOPS` | **Optional** | Number of reverse-proxy hops to trust for rate-limiting IP extraction (`1` by default on Cloud Run/production, `0`/`false` when direct). |
| `PORT` | **Optional** | HTTP server listening port (defaults to `3000`). |

### Required Manual Firebase Console Configuration

To ensure Firebase password-reset emails deliver users directly to the MedAtlas reset handler (or allow authorized `continueUrl` redirects):
1. Open **Firebase Console** (`gen-lang-client-0798026854`) → **Authentication** → **Settings** → **Authorized domains** and verify the following domains are listed:
   - `medatlas.ai.studio`
   - `ais-dev-5mhsafvm6orewiuxge6ast-323922691346.europe-west1.run.app`
   - `ais-pre-5mhsafvm6orewiuxge6ast-323922691346.europe-west1.run.app`
2. Open **Firebase Console** → **Authentication** → **Templates** → **Password reset** → click **Customize action URL** and set the custom Action URL to:
   - `https://medatlas.ai.studio/?mode=resetPassword`
   *(When configured as the custom Action URL, Firebase appends `&oobCode=<code...>&apiKey=<...>` directly to `https://medatlas.ai.studio/?mode=resetPassword`, which `PublicLanding.tsx` automatically detects, pre-fills, and strips from the browser URL bar. Even if the default Firebase hosted `/__/auth/action` page is used instead, MedAtlas tracks `pending_recovery_at`, immediately invalidates the old local password, and synchronizes the new password on sign-in.)*

### Commands
1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Start development server (port 3000)**:
   ```bash
   npm run dev
   ```
3. **Run type-checking (`tsc --noEmit`)**:
   ```bash
   npm run lint
   ```
4. **Run unit & security regression tests**:
   ```bash
   npm test
   ```
5. **Build production frontend (`dist/`) and compiled server bundle (`dist/server.js`)**:
   ```bash
   npm run build
   ```
6. **Start compiled production server (`NODE_ENV=production node dist/server.js`)**:
   ```bash
   npm run start
   ```



## JSON question imports and Telegram figures

In Admin Console → Bulk JSON Import, choose a target lecture (or use the subject/lecture fields in the file), select one `.json` file and any referenced PNG/JPEG/WebP files together, then validate. The preview shows missing files, duplicates, answer choices, figures and tags. Fix all invalid questions before confirming; duplicate questions are skipped. You can add source tags to one question or the entire batch. The downloadable image example includes a ready-to-use JSON file and a small illustrative figure.

The input is a question array or `{ "subject": "Histology", "lecture": "Cell structure", "questions": [...] }`. Each question has `question_text`, `options` with A/B/C/D keys (or an array of four strings), `correct_answer`, and `explanation`. Optional fields are `difficulty`, `tags`, `special_tags`, `page_number`, `status`, `explanation_a` through `explanation_d`, `images`, and `explanation_images`. Image entries are local filenames or `{ "file": "cell-diagram.png", "alt": "Description of the figure" }`. Filenames must match exactly. URLs, SVG files and base64 image payloads are rejected. See `public/templates/mcq-text-example.json` and the image example ZIP.

Limits: 4 MB JSON / 2,000 questions per batch; 100 selected image files; 2 MB per image; up to four question figures and four explanation figures per MCQ. Images must be no larger than 6,000 pixels per side and 16 megapixels. The uploader preserves the original image quality. Large batches are inserted in chunks, and concurrent imports are serialized to prevent duplicate questions.

Referenced images are uploaded as Telegram documents (without photo compression). PostgreSQL stores only small file references and alt text in `questions.images` and `questions.explanation_images`. Apply `supabase/migrations/20261103075415_question_images_json_import.sql` before running the updated backend. No new environment variables are required: the existing Telegram channel/bot and `AUTH_SESSION_SECRET` are reused. The encrypted full database backup includes these references; the legacy text-only CSV export does not include figures. Back up the Telegram channel too: a database backup cannot recover a file deleted from Telegram.

Student sessions fetch full MCQ content in batches of six. The initial response retains lightweight IDs and answer status for the whole navigator; question text, options, explanations and image references are selected from PostgreSQL only for the requested six. Study resumes in the batch containing the next unanswered question. Reaching the sixth question in a batch prefetches the next six, while jumping elsewhere fetches that batch directly. Loaded batches stay in browser memory; concurrent requests are deduplicated and failures require an explicit retry. Answers and bookmarks keep their existing immediate-save paths, independently of content loading. Submission grades all question IDs using small keys, snapshots only answered questions, and returns a six-question review. Completed mock-exam review fetches further content on demand. Older clients without `batchSize=6` retain their existing response format. No migration or progress reset is needed. Savings depend on how much of a set is opened; completing everything still transfers all content with some extra per-request overhead.

When a question batch loads, the browser fetches its distinct question figures through authenticated server routes, four at a time, and keeps temporary object URLs until the session closes. Moving between loaded questions reuses those images. In Study, explanation figures preload too; in an active exam they are withheld until submission. Telegram downloads are deduplicated and cached in bounded server memory. No image bytes are fetched from Supabase. Opening another session or refreshing the page can fetch images again. Image delivery still uses application hosting bandwidth. The app provides a retry button if a figure is temporarily unavailable.

Stored Telegram identifiers never reach the browser: responses mint encrypted opaque references. The image route requires sign-in and verifies the reference and downloaded SHA-256. It does not perform per-image database queries, apart from the application's existing authentication checks. Rotating the session secret invalidates open browser references; reopening a set mints fresh ones from the unchanged stored Telegram metadata.

The bot-linked upload portal also provides the same JSON/image importer at `/mcqs` (local address `http://localhost:4050/mcqs`). Open the bot portal and choose **Upload MCQs**. It includes lecture search, JSON editing/formatting, image thumbnails, answer/explanation previews, source badges and topic tags for individual rows or a whole batch, duplicate checks and upload progress. Imports default to **Save as draft**, keeping questions hidden from students during review. Choose **Use the status in the JSON file** when publishing is intended. The portal requires no username or password and retains same-origin checks; imports run under the existing active owner administrator and are recorded in the admin audit log. No student sign-in token or database password is placed in the portal frontend. The importer bundles its own local script and CSS, so it does not need an external UI CDN.

The PDF portal shares the MCQ page's local design system and provides subject dropdowns, lecture search, PDF status filters, attached/missing totals, per-lecture upload progress, and compression controls. ILovePDF configuration stays on the server; only a configured/not-configured flag and requested balance are returned. QR codes are generated in the browser without an external QR service. Upload confirmation JSON contains metadata and compression statistics, never the compressed PDF buffer itself.

### Student-owned Gemini API keys

**Shared grading pool:** configure the server-only `GEMINI_GRADING_POOL` Vercel Secret to use up to 20 authorized keys for all students. When empty, the personal-key flow below remains active. See [secure setup and project quota grouping](docs/gemini-grading-pool.md). Pool credentials never enter client responses or the database. Apply `supabase/migrations/20261106044218_gemini_grading_pool.sql` before enabling it.

Profile & Settings provides optional Save, Replace and Remove controls for a student's own Gemini API key. Keys are not validated against Google on save and saving consumes no provider quota. Short-answer grading uses only the authenticated student's stored key; their Google project's quota and billing apply.

Apply `supabase/migrations/20261104022545_student_gemini_keys.sql` before enabling this backend. Configure a dedicated server-only `STUDENT_API_KEY_ENCRYPTION_KEY` containing 64 random hexadecimal characters (32 bytes), separate from session and backup secrets. Do not expose it through Vite variables or commit it. The app uses AES-256-GCM with a fresh IV and the student's account ID as authenticated context. There is no plaintext-key retrieval endpoint; the settings API reads only saved status, the final four characters and update time. It is queried only when opening settings or after key changes, not during MCQ activity.

The new table has RLS enabled with no client policies and no anon/authenticated grants. Existing user/profile responses do not include credential fields. Account deletion cascades to the credential row. Remove deletes the active saved copy; it does not revoke the Google key or erase historical encrypted backups. Students can revoke their key in Google AI Studio. Full encrypted backups include the credential ciphertext; separately preserve the server encryption secret to recover it. Do not regenerate the secret on server restarts or deployments. Changing it requires re-encrypting existing records with the old secret first. If secure storage is unconfigured, save/replace fail closed while removal stays available.

### Numbered image matching

In the bot-linked MCQ portal, choose **Create matching image question**, select an image with its numbers already printed on it, then enter each number and its correct name. Each label can have its own explanation. Add optional extra answer names, choose **Add matching labels to this batch**, select the target lecture, then validate, preview, tag and import using the existing workflow. No image annotation or connecting lines are needed. The builder generates JSON for you; an editable example is in `public/templates/matching-question-example.json`.

A matching entry uses `question_type: "matching"`, `question_text`, one `images` filename, and `matches: [{ "number": "1", "answer": "Head", "explanation": "Optional explanation" }]`. Optional `distractors` add extra answer names. Difficulty, tags and publication status use the ordinary JSON fields. A group supports 1–30 unique numbered labels and up to 20 extra names; at least two distinct answer names are required. Students select names from dropdowns. A name can be reused for different labels.

Each numbered label becomes one independently scored question, with its own immediate answer save, bookmark and progress record. Mock-exam keys stay hidden until submission. Shared figures retain the Telegram-only delivery and browser image cache, and content still loads six questions at a time. Matching answer-bank text is stored in PostgreSQL, so this feature does not make database egress zero. Full encrypted backups include matching definitions and selected names. The standard MCQ CSV export excludes matching labels; retain the original matching JSON and full backups.

Apply `supabase/migrations/20261104004202_matching_questions.sql` before running this backend. It adds nullable columns without replacing existing student data. During a preview, `MATCHING_PREVIEW_ONLY=true` on the upload portal forces matching imports to remain drafts even if their JSON says published. Disable this flag only after the matching-capable student website is deployed.

### Lectures and practical sections

Apply `supabase/migrations/20261104053621_practical_sections.sql` before this backend. Existing lecture rows default to `content_type='lecture'`; IDs, questions, answers, sessions and bookmarks remain intact. Practical sections use the same records with `content_type='practical'`, preserving the six-question fetch and immediate-save paths. The Practical page groups published sections by subject and offers matching practice, short answers and protected PDFs. The Lectures page filters out practical sections; its subject-wide study/exam actions use the displayed lecture IDs. Short-answer counts are calculated in the existing cached catalog query using indexed metadata; no polling or image/PDF bytes are added to catalog reads.

Create entries in **Admin Console → Lectures & Sections → New Lecture / Section**, then choose **Lecture** or **Practical — Section**. New sections default to draft. Both matching/MCQ and short-answer upload pages also have **Create a new lecture or practical section** below the target selector; creation selects the new destination automatically. Choose that section for subsequent imports. Publish its questions and change the section's publication status to Published in Admin Console when ready. Existing entries can change type without recreating their question banks or deleting progress. Full encrypted backups preserve the classification. Keep new practical content in draft in the main database until this website update is deployed; the isolated local preview supports a full published trial without affecting students.

### Short-answer practice and Gemini grading

Short-answer questions can include up to four PNG/JPEG/WebP figures, 2 MB each. In the manual builder select **Question images (optional)** in Step 1; thumbnails can be removed before adding the question to the batch. Images upload only on Confirm import and reuse the existing Telegram upload and authenticated image-delivery routes. PostgreSQL stores file references only, including in historical answer snapshots. JSON supports `images: ["diagram.png"]` or `{ "file": "diagram.png", "alt": "Description" }` entries; select those files with **Images referenced by JSON**. **Gemini receives text only**: the written question, complete model answer, rubric and student answer. The grading service neither downloads the figures nor sends image references or image bytes to Google. Opening saved answers displays their figures to the student using the existing image cache.

The upload portal also supports guided authoring alongside JSON. For matching, open `/mcqs?matching=1`: choose the numbered image and instructions, enter each label's correct name and optional explanation, then add extra choices and topic tags. Add the labels to the batch and use the existing Validate & preview / Confirm import workflow. For short answers, open `/short-answers`, choose **Build step by step**, enter the question and model answer, add marking points with marks, then review and add tags. **Add short answer to batch** preserves questions already in the JSON editor. Repeat to build a batch, then validate and confirm. Both guided builders create drafts and use the existing import validators; file-based JSON imports remain available.

Apply `supabase/migrations/20261104043925_short_answer_grading.sql`. The new question and attempt tables have RLS enabled and no client grants. They do not change MCQ scores, session ordering, progress, bookmarks or PDF delivery. Full encrypted backups include short-answer definitions, saved answers and grades.

In the bot-linked upload portal, open **Upload MCQs → Upload short answers** (local `http://localhost:4050/short-answers`). Select a lecture, load the example or upload JSON, add tags, validate the model answer and rubric, and confirm. Each rubric item has `description` and integer `marks` (1–10). A question supports 1–15 points, up to 100 marks total, and partial integer credit within each point. The importer accepts 1–200 text questions per batch and skips duplicates. See `public/templates/short-answer-example.json`. Manage saved questions to publish reviewed drafts or return questions to draft; historical answers stay saved. `SHORT_ANSWER_PREVIEW_ONLY=true` forces draft imports and blocks publishing until the student website release is deployed. Disable it after deployment.

Students open **Short Answers**, select a lecture, then write and save an answer. Unsubmitted typing is retained locally per account/question; Save stores the answer on the server. Save & grade first saves the answer, then calls Gemini with the student's stored key after the student confirms sending the answer and marking guide to Google. Names, email addresses and other account records are not sent. The model answer and marking guide stay server-side until grading returns feedback. AI grading is practice feedback, not an authoritative examination grade.

Performance: the Short Answers screen loads on demand, lists six question stems at a time and keeps the active list in browser memory. History loads 20 rows at a time. Each grading request sends only one question, its rubric and answer, with a 1,800-token output cap and minimal thinking. Default model: `gemini-3.5-flash-lite` (override `GEMINI_GRADING_MODEL` with a compatible minimal-thinking Gemini model). There are no background Gemini requests or automatic paid fallbacks. Existing saved grades are reused for the same account/question/normalized answer. A database lease prevents concurrent grading of the same answer across processes; crashed claims expire after 45 seconds. At most two grades per student run concurrently, with a six-starts-per-minute check. Database transactions finish before the provider request starts. Provider requests time out after 22 seconds.

Server validation checks every criterion ID, rejects duplicated/missing points and out-of-range or fractional awards, and computes totals itself. Quota errors, invalid keys, malformed grades and timeouts leave the saved answer available for explicit retry, with cooldowns. A network failure after Google processes a request can still consume quota; a later retry may consume another request. Reopening an already saved grade consumes no Gemini quota. Practice requires a valid student key and model access; automated tests mock Google to avoid spending quota, so actual provider latency and grading quality must be checked with a real key and instructor-marked examples before release.

### Editing images on existing questions

On either question upload page, select the target lecture or practical section, choose **Edit saved questions**, then **Load questions**. Search by question text; results load 30 at a time only when requested. Use **Add images** or **Edit images**, choose local PNG/JPEG/WebP files (up to 2 MB each), add optional descriptions, and **Save images**. Regular MCQs support up to four question images and four explanation images. Short answers support up to four question images; Gemini continues to receive text only. Matching questions require one numbered image and changes apply atomically to every label in the same group and destination. Removing then adding a file replaces an image. Changes remain local to the editor until Save, and unsaved edits prompt before dismissal.

This updates existing question IDs and preserves publication status, choices, answer keys, marking guides, original import identity, progress and bookmarks. Historical answer snapshots/grades remain unchanged; newly loaded question content uses the edited images. A revision check rejects overwriting concurrent edits. All files are validated and stored on Telegram using the existing upload path; PostgreSQL receives only protected-file metadata. No schema migration, student polling or new student-side request is added. Editor list/detail/image routes are served by the private bot-linked upload portal, not the student web server. The upload pages keep guided forms and JSON imports; switching between Upload and Edit does not clear an in-progress JSON batch.

Database integration tests share fixtures (including the portal owner), so the full test command runs files sequentially to avoid one test temporarily removing another test's owner account.

### Mixed quizzes

MCQs, numbered matching labels and short answers share the same lecture/section quiz, question navigator and six-question batches. The separate student Short Answers navigation item is removed; old `/short-answers` links open Lectures. The upload page offers an inline question-type choice and guided builders. Old short-answer upload links redirect to the written-question builder on that same page. JSON imports may mix `mcq`, `matching` and `short_answer` entries in one questions array.

Apply `supabase/migrations/20261104203408_mixed_quiz_short_answers.sql` with this code release. It adds public quiz-bank entries linked to the existing private short-answer definitions without changing existing question IDs or deleting saved answers/grades. Model answers/rubrics stay in the private table. Imports, publication and image edits synchronize the linked quiz entry. The student quiz retrieves written responses only for its loaded six-question window. Legacy saved written answers remain accessible inside the new quiz.

Typing stays local and does not call the database per keystroke. Save answer stores the response without a Gemini key. Quiz submission saves dirty written responses before finalizing; failed saves block finalization and retain local drafts. Gemini grading is explicit and uses the student's own encrypted key. Mock exam grading is blocked until submission, including the legacy grading endpoint for an answer linked to an active exam. Images are never sent to Gemini. Grades are reused for the same saved answer; historical quiz responses remain tied to their original immutable attempt.

MCQs/matching labels are worth one mark each; written questions use their rubric marks and can receive partial credit. Results show earned/available marks and explicitly label ungraded saved responses as pending/provisional. Pending responses are not counted as wrong in progress analytics. The mixed-quiz migration is additive and must be applied with the student code release.


### Tagged questions first

Fresh lecture Study sets prioritize questions with topic tags or special source tags (for example, Important or Old Exams). Ordering stays stable within each group. Filtered lecture Study sets apply the priority before the requested-count limit and preserve it when shuffling. Mock exams and custom practice keep their existing ordering rules. Resuming an existing study set preserves its order, answers, option permutations and bookmarks; newly published questions append without moving existing questions. The cumulative-study query returns only a tag-presence boolean, and question content still loads six at a time.


### PDF viewer performance

The viewer requests its page image directly; `X-Document-Total-Pages` returns the count in that same response. The metadata endpoint remains compatible with older clients. Out-of-range slide references recover once using the available page count. Page retries and zoom keep their existing behavior; zoom redraws locally.

With watermarks off, rendered WebP pages reuse a private in-process LRU cache (24 MB / 128 pages, 10-minute TTL). Concurrent requests for the same Telegram file/page share one render. A cached page skips both PDF downloading and rendering. Immutable Telegram file IDs separate replaced files. PDF.js initialization overlaps a required Telegram source download. Metadata counts reuse the already parsed source where available. Watermarked account-specific images bypass the shared cache. Every page request still authenticates the user, checks current lecture availability and reads the current watermark setting before any cache lookup. Responses remain private/no-store; original PDF and Telegram URLs remain server-only. No speculative next-page downloading, schema change, storage migration or student-progress write is added. Cold server instances still depend on Telegram download time.

Study/review Next and Previous controls live in a fixed bottom navigation bar, outside question/explanation content. Safe-area spacing and reserved bottom padding prevent content from being hidden. PDF and submission dialogs hide the bar; navigation uses the existing handlers and adds no network requests.


### Visitor analytics

Vercel Web Analytics (`@vercel/analytics/react`) records visits and page views on the deployed site. Enable Web Analytics for the existing Vercel project before the release. Localhost and temporary Cloudflare previews do not send analytics. The client removes query strings and fragments and groups `/session/:id` as `/session`; API/document URLs are excluded. No answer text, API key, username or custom student event is sent. Analytics uses Vercel endpoints and adds no Supabase queries or tables. View visitors, page views and traffic breakdowns in the project's Analytics dashboard; collection starts after setup rather than backfilling old visits.


### Arabic Gemini setup guide

When quiz grading returns `KEY_MISSING`, the saved response stays in place and a lazy-loaded Arabic RTL guide opens. Five project-local SVG illustrations explain Google sign-in, key creation/project choice, copying the complete key and saving it inside the quiz. They are explicitly labelled as illustrations, not screenshots. The final action saves the student's key using the existing encrypted endpoint and resumes their requested grading. Closing the guide or a failed key save preserves the answer; closing during a key save prevents automatic grading after dismissal. Quota/access errors do not open onboarding. No per-grade key-status polling, database migration, extra Google validation request or question-image download is introduced. Tutorial illustrations are static website assets and never use Supabase storage. The support button opens `https://t.me/MedAtlasMCQ?direct`; the guide tells students never to send their secret key in support messages. Ordinary grading still requires just the grade button, without an extra checkbox.
