import type { QuestionImage } from '../lib/question-images.ts';
import type { MatchingQuestionDefinition } from '../lib/matching-questions.ts';
import { relations } from 'drizzle-orm';
import {
  boolean,
  jsonb,
  integer,
  index,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  booleanValue: boolean('boolean_value').notNull().default(false),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', {withTimezone:true}).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  firebaseUid: text('firebase_uid'),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  faculty: text('faculty').notNull().default('Benha University'),
  profileCompleted: boolean('profile_completed').notNull().default(false),
  passwordHash: text('password_hash'),
  authProvider: text('auth_provider').notNull().default('local'), // 'local' | 'firebase' | 'both' | 'linked'
  tokenVersion: integer('token_version').notNull().default(1),
  passwordUpdatedAt: timestamp('password_updated_at'),
  pendingRecoveryAt: timestamp('pending_recovery_at'),
  sessionsRevokedAt: timestamp('sessions_revoked_at'),
  accountStatus: text('account_status').notNull().default('active'), // 'active' | 'deleted' | 'suspended'
  deletedAt: timestamp('deleted_at'),
  role: text('role').notNull().default('student'), // 'student' | 'admin'
  subscriptionTier: text('subscription_tier').notNull().default('free_trial'), // 'free_trial' | 'free' | 'premium_monthly' | 'premium_annual'
  subscriptionStatus: text('subscription_status').notNull().default('active'), // 'active' | 'trialing' | 'expired' | 'canceled'
  subscriptionExpiresAt: timestamp('subscription_expires_at'),
  emailVerified: boolean('email_verified').notNull().default(false),
  preferences: text('preferences').notNull().default('{}'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [check('users_faculty_allowed', sql`${table.faculty} = 'Benha University'`)]);

export const studentGeminiKeys = pgTable('student_gemini_keys', {
  userUid: text('user_uid').primaryKey().references(() => users.uid, {onDelete:'cascade'}),
  encryptedKey: text('encrypted_key').notNull(),
  keySuffix: text('key_suffix').notNull(),
  updatedAt: timestamp('updated_at', {withTimezone:true}).notNull().defaultNow(),
});

export const shortAnswerQuestions = pgTable('short_answer_questions', {
  id:serial('id').primaryKey(),lectureId:integer('lecture_id').notNull().references(()=>lectures.id,{onDelete:'cascade'}),
  definition:jsonb('definition').notNull(),contentHash:text('content_hash').notNull(),maxScore:integer('max_score').notNull(),
  status:text('status').notNull().default('draft'),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},table=>[uniqueIndex('short_answer_questions_lecture_hash').on(table.lectureId,table.contentHash),index('short_answer_questions_lecture_status').on(table.lectureId,table.status,table.id)]);
export const shortAnswerAttempts = pgTable('short_answer_attempts', {
  id:serial('id').primaryKey(),userUid:text('user_uid').notNull().references(()=>users.uid,{onDelete:'cascade'}),
  questionId:integer('question_id').notNull().references(()=>shortAnswerQuestions.id,{onDelete:'cascade'}),
  answer:text('answer').notNull(),answerHash:text('answer_hash').notNull(),snapshot:jsonb('snapshot').notNull(),status:text('status').notNull().default('saved'),
  excludedFromQuizProgress:boolean('excluded_from_quiz_progress').notNull().default(false),
  result:jsonb('result'),errorCode:text('error_code'),model:text('model'),leaseId:text('lease_id'),gradeStartedAt:timestamp('grade_started_at',{withTimezone:true}),retryAt:timestamp('retry_at',{withTimezone:true}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},table=>[uniqueIndex('short_answer_attempts_owner_question_hash').on(table.userUid,table.questionId,table.answerHash),index('short_answer_attempts_owner_question').on(table.userUid,table.questionId,table.id),index('short_answer_attempts_owner_started').on(table.userUid,table.gradeStartedAt)]);

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: serial('id').primaryKey(),
  userUid: text('user_uid').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const deletedAccounts = pgTable('deleted_accounts', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  firebaseUid: text('firebase_uid'),
  emailHash: text('email_hash').notNull(),
  remoteCleanupStatus: text('remote_cleanup_status').notNull().default('completed'), // 'completed' | 'pending_retry' | 'not_applicable'
  lastCleanupError: text('last_cleanup_error'),
  deletedAt: timestamp('deleted_at').defaultNow().notNull(),
});

export const rateLimitBuckets = pgTable('rate_limit_buckets', {
  key: text('key').primaryKey(),
  scope: text('scope').notNull(),
  count: integer('count').notNull().default(1),
  resetAt: timestamp('reset_at').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const modules = pgTable('modules', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(), // e.g. 'BSF 112'
  title: text('title').notNull(),        // e.g. 'Basic Structure & Function (BSF 112)'
  description: text('description').notNull().default(''),
  displayOrder: integer('display_order').notNull().default(1),
  status: text('status').notNull().default('published'), // 'draft' | 'published' | 'archived'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const subjects = pgTable('subjects', {
  id: serial('id').primaryKey(),
  moduleId: integer('module_id').references(() => modules.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  displayOrder: integer('display_order').notNull().default(1),
  status: text('status').notNull().default('published'), // 'draft' | 'published' | 'archived'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const lectures = pgTable('lectures', {
  id: serial('id').primaryKey(),
  subjectId: integer('subject_id')
    .references(() => subjects.id, { onDelete: 'cascade' })
    .notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  lectureNumber: integer('lecture_number').notNull().default(1),
  contentType: text('content_type').notNull().default('lecture'),
  educationalNotes: text('educational_notes').notNull().default(''),
  estimatedMinutes: integer('estimated_minutes').notNull().default(30),
  pdfUrl: text('pdf_url'),
  status: text('status').notNull().default('published'), // 'draft' | 'published' | 'archived'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
},table=>[check('lectures_content_type_allowed',sql`${table.contentType} IN ('lecture','practical')`)]);

export const lectureFiles = pgTable('lecture_files', {
  id: serial('id').primaryKey(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull().default('application/pdf'),
  fileSize: integer('file_size').notNull().default(0),
  dataBase64: text('data_base64').notNull(),
  url: text('url').notNull().unique(),
  telegramFileId: text('telegram_file_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const questionBanks = pgTable('question_banks', {
  id: serial('id').primaryKey(),
  subjectId: integer('subject_id')
    .references(() => subjects.id, { onDelete: 'cascade' })
    .notNull(),
  lectureId: integer('lecture_id')
    .references(() => lectures.id, { onDelete: 'cascade' })
    .notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  bankType: text('bank_type').notNull().default('practice'), // 'practice' | 'mock_exam'
  timeLimitMinutes: integer('time_limit_minutes'),
  isPremium: boolean('is_premium').notNull().default(false),
  status: text('status').notNull().default('published'), // 'draft' | 'published' | 'archived'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const questions = pgTable('questions', {
  id: serial('id').primaryKey(),
  subjectId: integer('subject_id')
    .references(() => subjects.id, { onDelete: 'cascade' })
    .notNull(),
  lectureId: integer('lecture_id')
    .references(() => lectures.id, { onDelete: 'cascade' })
    .notNull(),
  questionBankId: integer('question_bank_id').references(() => questionBanks.id, {
    onDelete: 'set null',
  }),
  questionText: text('question_text').notNull(),
  optionA: text('option_a').notNull(),
  optionB: text('option_b').notNull(),
  optionC: text('option_c').notNull(),
  optionD: text('option_d').notNull(),
  correctAnswer: text('correct_answer').notNull(), // 'A' | 'B' | 'C' | 'D'
  explanation: text('explanation').notNull(),
  explanationA: text('explanation_a').notNull().default(''),
  explanationB: text('explanation_b').notNull().default(''),
  explanationC: text('explanation_c').notNull().default(''),
  explanationD: text('explanation_d').notNull().default(''),
  difficulty: text('difficulty').notNull().default('Medium'), // 'Easy' | 'Medium' | 'Hard'
  tags: text('tags').notNull().default(''),
  specialTags: text('special_tags').notNull().default(''),
  diagramSvg: text('diagram_svg').notNull().default(''),
  images: jsonb('images').$type<QuestionImage[]>().notNull().default([]),
  explanationImages: jsonb('explanation_images').$type<QuestionImage[]>().notNull().default([]),
  matching: jsonb('matching').$type<MatchingQuestionDefinition>(),
  shortAnswerId: integer('short_answer_id').references(()=>shortAnswerQuestions.id,{onDelete:'cascade'}).unique(),
  shortAnswerMaxMarks: integer('short_answer_max_marks').notNull().default(1),
  pageNumber: integer('page_number'),
  status: text('status').notNull().default('published'), // 'draft' | 'published' | 'archived'
  version: integer('version').notNull().default(1),
  contentHash: text('content_hash').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const examSessions = pgTable('exam_sessions', {
  id: serial('id').primaryKey(),
  userUid: text('user_uid').notNull(),
  title: text('title').notNull(),
  mode: text('mode').notNull(), // 'study' | 'exam' | 'custom'
  subjectId: integer('subject_id').references(() => subjects.id, { onDelete: 'set null' }),
  lectureId: integer('lecture_id').references(() => lectures.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('in_progress'), // 'in_progress' | 'completed' | 'abandoned'
  totalQuestions: integer('total_questions').notNull(),
  correctCount: integer('correct_count').notNull().default(0),
  incorrectCount: integer('incorrect_count').notNull().default(0),
  unansweredCount: integer('unanswered_count').notNull().default(0),
  scorePercentage: integer('score_percentage').notNull().default(0),
  timeLimitSeconds: integer('time_limit_seconds'),
  elapsedSeconds: integer('elapsed_seconds').notNull().default(0),
  shuffleOptions: boolean('shuffle_options').notNull().default(false),
  questionOrderJson: text('question_order_json').notNull(),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
}, (table) => [index('idx_session_user_started').on(table.userUid, table.startedAt.desc())]);

export const questionAttempts = pgTable(
  'question_attempts',
  {
    id: serial('id').primaryKey(),
    sessionId: integer('session_id')
      .references(() => examSessions.id, { onDelete: 'cascade' })
      .notNull(),
    userUid: text('user_uid').notNull(),
    questionId: integer('question_id').references(() => questions.id, { onDelete: 'set null' }),
    subjectId: integer('subject_id'),
    lectureId: integer('lecture_id'),
    selectedOption: text('selected_option'), // 'A' | 'B' | 'C' | 'D' | null
    matchingChoiceId: text('matching_choice_id'),
    gradingStatus:text('grading_status'),
    correctOptionSnapshot: text('correct_option_snapshot').notNull(),
    isCorrect: boolean('is_correct').notNull().default(false),
    questionSnapshotJson: text('question_snapshot_json').notNull(),
    timeSpentSeconds: integer('time_spent_seconds').notNull().default(0),
    answeredAt: timestamp('answered_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_session_question_attempt').on(table.sessionId, table.questionId),
    index('idx_attempt_user_question_latest').on(table.userUid, table.questionId, table.answeredAt.desc(), table.id.desc()),
    index('idx_attempt_answered_at').on(table.answeredAt),
  ]
);

export const bookmarks = pgTable('bookmarks', {
  id: serial('id').primaryKey(),
  userUid: text('user_uid').notNull(),
  questionId: integer('question_id')
    .references(() => questions.id, { onDelete: 'cascade' })
    .notNull(),
  note: text('note').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const importBatches = pgTable('import_batches', {
  id: serial('id').primaryKey(),
  adminUid: text('admin_uid').notNull(),
  fileName: text('file_name').notNull(),
  fileHash: text('file_hash').notNull(),
  totalRows: integer('total_rows').notNull(),
  importedCount: integer('imported_count').notNull(),
  skippedCount: integer('skipped_count').notNull(),
  failedCount: integer('failed_count').notNull(),
  summaryJson: text('summary_json').notNull().default('{}'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const adminAuditLogs = pgTable('admin_audit_logs', {
  id: serial('id').primaryKey(),
  adminUid: text('admin_uid').notNull(),
  adminEmail: text('admin_email').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  details: text('details').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const questionReports = pgTable('question_reports', {
  id: serial('id').primaryKey(),
  userUid: text('user_uid').notNull().references(() => users.uid, { onDelete: 'cascade' }),
  questionId: integer('question_id').references(() => questions.id, { onDelete: 'set null' }),
  lectureId: integer('lecture_id').references(() => lectures.id, { onDelete: 'set null' }),
  reason: text('reason').$type<'wrong_answer' | 'outside_syllabus'>().notNull(),
  questionText: text('question_text').notNull(),
  status: text('status').$type<'open' | 'resolved'>().notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: text('resolved_by').references(() => users.uid, { onDelete: 'set null' }),
}, table => [
  uniqueIndex('uq_question_report_open').on(table.userUid, table.questionId, table.reason).where(sql`${table.status} = 'open'`),
  index('idx_question_report_status_created').on(table.status, table.createdAt.desc()),
  index('idx_question_report_question').on(table.questionId),
  index('idx_question_report_user').on(table.userUid),
  index('idx_question_report_lecture').on(table.lectureId),
  index('idx_question_report_resolved_by').on(table.resolvedBy),
  check('question_report_reason_check', sql`${table.reason} IN ('wrong_answer', 'outside_syllabus')`),
  check('question_report_status_check', sql`${table.status} IN ('open', 'resolved')`),
]);

// Relations
export const modulesRelations = relations(modules, ({ many }) => ({
  subjects: many(subjects),
}));

export const subjectsRelations = relations(subjects, ({ one, many }) => ({
  module: one(modules, {
    fields: [subjects.moduleId],
    references: [modules.id],
  }),
  lectures: many(lectures),
  questionBanks: many(questionBanks),
  questions: many(questions),
}));

export const lecturesRelations = relations(lectures, ({ one, many }) => ({
  subject: one(subjects, {
    fields: [lectures.subjectId],
    references: [subjects.id],
  }),
  questionBanks: many(questionBanks),
  questions: many(questions),
}));

export const questionBanksRelations = relations(questionBanks, ({ one, many }) => ({
  subject: one(subjects, {
    fields: [questionBanks.subjectId],
    references: [subjects.id],
  }),
  lecture: one(lectures, {
    fields: [questionBanks.lectureId],
    references: [lectures.id],
  }),
  questions: many(questions),
}));

export const questionsRelations = relations(questions, ({ one, many }) => ({
  subject: one(subjects, {
    fields: [questions.subjectId],
    references: [subjects.id],
  }),
  lecture: one(lectures, {
    fields: [questions.lectureId],
    references: [lectures.id],
  }),
  questionBank: one(questionBanks, {
    fields: [questions.questionBankId],
    references: [questionBanks.id],
  }),
  bookmarks: many(bookmarks),
}));

export const examSessionsRelations = relations(examSessions, ({ many }) => ({
  attempts: many(questionAttempts),
}));

export const questionAttemptsRelations = relations(questionAttempts, ({ one }) => ({
  session: one(examSessions, {
    fields: [questionAttempts.sessionId],
    references: [examSessions.id],
  }),
  question: one(questions, {
    fields: [questionAttempts.questionId],
    references: [questions.id],
  }),
}));
