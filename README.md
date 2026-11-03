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
