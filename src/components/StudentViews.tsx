import { MatchingAnswerReview } from './MatchingQuestion.tsx';
import { QuestionImages } from './QuestionImages.tsx';
import { AcademicProfileFields } from './AcademicProfileFields.tsx';
import { GeminiKeySettings } from './GeminiKeySettings.tsx';
import { DEFAULT_FACULTY } from '../lib/academic-profile.ts';
import { groupLectureModules } from '../lib/lecture-modules.ts';
import {useLectureLinkId,useScrollToLecture} from '../lib/use-lecture-link.ts';
import {subjectLibraryTab} from '../lib/subject-library.ts';
import { ExamCompletionGate } from '../lib/exam-completion.ts';
import { QuestionReportButton } from './QuestionReportButton.tsx';
import { BookmarkButton } from './BookmarkButton.tsx';
import { PageHeading } from './PageHeading.tsx';
import React, { useState, useEffect } from 'react';
import {
  BookOpen,
  Bookmark,
  CheckCircle2,
  Clock,
  Play,
  SlidersHorizontal,
  TrendingUp,
  AlertTriangle,
  History,
  User,
  Trash2,
  FileText,
  XCircle,
  ArrowRight,
  ArrowLeft,
  RotateCcw,
  Award,
  Layers,
  ChevronRight,
  ExternalLink,
  HelpCircle,
  AlertCircle,
  Upload,
  Tag,
  Search,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
} from 'lucide-react';
import { api, type UserProfile, type ReviewQuery } from '../lib/api.ts';
import { parseAllQuestionTags, parseSpecialTags } from '../lib/mcq-engine.ts';
import { PdfViewerModal } from './PdfViewerModal.tsx';
import { UploadPdfModal } from './UploadPdfModal.tsx';

// ============================================================================
// 1. STUDENT DASHBOARD & ANALYTICS VIEW
// ============================================================================
export const DashboardView: React.FC<{
  dashboardData: any;
  loading: boolean;
  onStartQuickSession: (params: any) => void;
  onOpenSession: (sessionId: number) => void;
  onNavigateTab: (tab: string) => void;
  onOpenSubject?: (subjectId: number) => void;
}> = ({
  dashboardData,
  loading,
  onStartQuickSession,
  onOpenSession,
  onNavigateTab,
  onOpenSubject,
}) => {
  if (loading || !dashboardData) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((n) => (
            <div
              key={n}
              className="h-28 bg-white rounded-xl border border-slate-200 p-5 animate-pulse"
            />
          ))}
        </div>
        <div className="h-64 bg-white rounded-xl border border-slate-200 p-6 animate-pulse" />
      </div>
    );
  }

  const { subjectProgress = [], history = [] } = dashboardData;
  const summary = { totalPublishedQuestions: 0, totalPublishedLectures: 0, uniqueQuestionsAttempted: 0,
    totalQuestionsAnswered: 0, totalCorrectAnswers: 0, totalIncorrectAnswers: 0,
    overallAccuracy: 0, accuracyPercentage: 0, ...dashboardData.summary };

  return (
    <div className="space-y-8">
      {/* Header & Primary Action */}
      <PageHeading eyebrow="Your workspace" title="A little progress, every day."
        description="Pick up where you left off, explore a lecture, or revisit a question.">
        <div className="flex flex-wrap items-center gap-3">
          {summary.totalIncorrectAnswers > 0 && (
            <button
              type="button"
              onClick={() =>
                onStartQuickSession({
                  mode: 'study',
                  title: 'Review Mistakes (All Modules)',
                  onlyMistakes: true,
                })
              }
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Review Mistakes ({summary.totalIncorrectAnswers})
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigateTab('lectures')}
            className="order-first w-full sm:order-none sm:w-auto px-4 py-2 text-xs font-semibold text-white bg-[var(--ma-brand)] hover:bg-[var(--ma-brand-hover)] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            start studying
          </button>
        </div>
      </PageHeading>

      {/* Welcome / Empty State message when no questions have been attempted */}
      {summary.totalQuestionsAnswered === 0 && (
        <div className="p-5 bg-sky-50 border border-sky-200 rounded-xl flex items-start gap-3.5 text-xs text-sky-950">
          <AlertCircle className="w-5 h-5 text-[var(--ma-brand)] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-bold text-sm text-[var(--ma-brand)]">
              Welcome to your Medical Curriculum &amp; Question Bank!
            </p>
            <p className="text-slate-600 leading-relaxed">
              You haven't attempted any questions yet. Choose a module card below or select start studying to browse your lectures and begin tracking your progress.
            </p>
          </div>
        </div>
      )}

      {/* Summary KPI Grid: Total, Unique, Correct, Incorrect, Accuracy, Unanswered */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3.5 font-mono-tabular">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs font-sans text-slate-500 font-medium">Total questions</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">
            {summary.totalPublishedQuestions}
          </p>
          <p className="text-[11px] font-sans text-slate-500 mt-1">
            Across {summary.totalPublishedLectures} lectures
          </p>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs font-sans text-slate-500 font-medium">Unique Attempted</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">
            {summary.uniqueQuestionsAttempted}
          </p>
          <p className="text-[11px] font-sans text-slate-500 mt-1">
            {summary.totalPublishedQuestions > 0
              ? `${Math.round((summary.uniqueQuestionsAttempted / summary.totalPublishedQuestions) * 100)}% coverage`
              : '0% coverage'}
          </p>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs font-sans text-slate-500 font-medium">Correct Answers</p>
          <p className="text-2xl font-bold text-emerald-600 mt-1">
            {summary.totalCorrectAnswers ?? 0}
          </p>
          <p className="text-[11px] font-sans text-slate-500 mt-1">
            Submitted answers
          </p>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs font-sans text-slate-500 font-medium">Incorrect Answers</p>
          <p className="text-2xl font-bold text-rose-600 mt-1">
            {summary.totalIncorrectAnswers ?? 0}
          </p>
          <p className="text-[11px] font-sans text-slate-500 mt-1">
            Reviewable mistakes
          </p>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs font-sans text-slate-500 font-medium">Accuracy</p>
          <p className="text-2xl font-bold text-[var(--ma-brand)] mt-1">
            {summary.totalQuestionsAnswered > 0
              ? `${summary.accuracyPercentage ?? summary.overallAccuracy}%`
              : '—'}
          </p>
          <p className="text-[11px] font-sans text-slate-500 mt-1">
            {summary.totalQuestionsAnswered} total answers
          </p>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs font-sans text-slate-500 font-medium">Unanswered</p>
          <p className="text-2xl font-bold text-slate-700 mt-1">
            {summary.remainingUnansweredQuestions ??
              Math.max(0, summary.totalPublishedQuestions - summary.uniqueQuestionsAttempted)}
          </p>
          <p className="text-[11px] font-sans text-slate-500 mt-1">
            Questions left to try
          </p>
        </div>
      </div>

      {/* Dynamic Module Cards Grid (Homepage Modules) */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              Your subjects
            </h2>
            <p className="text-xs text-slate-500">
              Choose a subject to browse its lectures, practical sections and question banks.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('lectures')}
            className="text-xs font-semibold text-[var(--ma-brand)] hover:text-[var(--ma-brand-hover)] inline-flex items-center gap-1 cursor-pointer"
          >
            <span>View all lectures</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {subjectProgress.map((subj: any) => {
            const completionPct =
              subj.totalPublishedQuestions > 0
                ? Math.round(
                    (subj.uniqueQuestionsAttempted / subj.totalPublishedQuestions) * 100
                  )
                : 0;

            return (
              <button
                type="button"
                key={subj.subjectId}
                aria-label={`Browse ${subj.title} ${subjectLibraryTab(subj.title)==='practical'?'practical sections':'lectures'}`}
                onClick={() => {
                  if (onOpenSubject) {
                    onOpenSubject(subj.subjectId);
                  } else {
                    onNavigateTab(subjectLibraryTab(subj.title));
                  }
                }}
                className="bg-white rounded-xl border border-slate-200 hover:border-[var(--ma-brand)] p-5 flex flex-col justify-between transition-colors cursor-pointer group text-left"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="text-[10px] font-mono-tabular font-bold uppercase tracking-wider text-[var(--ma-brand)] bg-sky-50 px-2 py-0.5 rounded-md">
                        Subject
                      </span>
                      <h3 className="text-base font-bold text-slate-900 mt-1.5 group-hover:text-[var(--ma-brand)] transition-colors">
                        {subj.title}
                      </h3>
                    </div>
                    <div className="w-8 h-8 rounded-lg bg-slate-50 group-hover:bg-sky-50 flex items-center justify-center text-slate-400 group-hover:text-[var(--ma-brand)] transition-colors shrink-0">
                      <ChevronRight className="w-4 h-4" />
                    </div>
                  </div>

                  {subj.description && (
                    <p className="text-xs text-slate-600 line-clamp-2 leading-relaxed">
                      {subj.description}
                    </p>
                  )}

                  <div className="flex items-center gap-3 text-xs text-slate-500 font-mono-tabular pt-1">
                    <span className="inline-flex items-center gap-1">
                      <BookOpen className="w-3.5 h-3.5 text-slate-400" />
                      {subj.lectureCount ?? subj.lectures?.length ?? 0} Lectures
                    </span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1">
                      <HelpCircle className="w-3.5 h-3.5 text-slate-400" />
                      {subj.totalPublishedQuestions} Questions
                    </span>
                  </div>
                </div>

                <div className="pt-4 mt-4 border-t border-slate-100 space-y-2.5">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500">Completion</span>
                      <span className="font-mono-tabular font-semibold text-slate-800">
                        {subj.uniqueQuestionsAttempted} / {subj.totalPublishedQuestions} ({completionPct}%)
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--ma-brand)] rounded-full transition-all duration-300"
                        style={{ width: `${completionPct}%` }}
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs pt-1">
                    <span className="text-slate-500">Accuracy</span>
                    <span
                      className={`font-mono-tabular font-bold ${
                        subj.totalAnswersSubmitted > 0
                          ? subj.accuracyPercentage >= 70
                            ? 'text-emerald-700'
                            : subj.accuracyPercentage >= 50
                            ? 'text-amber-700'
                            : 'text-rose-700'
                          : 'text-slate-400'
                      }`}
                    >
                      {subj.totalAnswersSubmitted > 0
                        ? `${subj.accuracyPercentage}%`
                        : 'Not attempted'}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Subject & Lecture Progress Breakdown */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              Progress by Subject &amp; Lecture
            </h2>
            <p className="text-xs text-slate-500">
              Distinguishes unique questions completed from total answers submitted across repeated sessions.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('lectures')}
            className="text-xs font-semibold text-[var(--ma-brand)] hover:text-[var(--ma-brand-hover)] cursor-pointer"
          >
            Browse Lectures →
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2.5 pr-4 font-semibold">Subject / Lecture</th>
                <th className="py-2.5 px-3 font-semibold text-right">
                  Unique Completed
                </th>
                <th className="py-2.5 px-3 font-semibold text-right">
                  Total Answers Submitted
                </th>
                <th className="py-2.5 px-3 font-semibold text-right">Accuracy</th>
                <th className="py-2.5 pl-3 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {subjectProgress.map((subj: any) => (
                <React.Fragment key={subj.subjectId}>
                  <tr className="bg-slate-50/80 font-semibold text-slate-900">
                    <td className="py-2.5 pr-4">{subj.title}</td>
                    <td className="py-2.5 px-3 text-right font-mono-tabular">
                      {subj.uniqueQuestionsAttempted} / {subj.totalPublishedQuestions}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono-tabular">
                      {subj.totalAnswersSubmitted}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono-tabular">
                      {subj.totalAnswersSubmitted > 0
                        ? `${subj.accuracyPercentage}%`
                        : '—'}
                    </td>
                    <td className="py-2.5 pl-3 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          onStartQuickSession({
                            mode: 'study',
                            subjectIds: [subj.subjectId],
                            title: `${subj.title} — Subject Study`,
                          })
                        }
                        className="text-[var(--ma-brand)] hover:underline font-semibold cursor-pointer"
                      >
                        Practice Subject
                      </button>
                    </td>
                  </tr>
                  {subj.lectures.map((lect: any) => (
                    <tr key={lect.lectureId} className="hover:bg-slate-50/50 text-slate-700">
                      <td className="py-2 pr-4 pl-5">{lect.title}</td>
                      <td className="py-2 px-3 text-right font-mono-tabular">
                        {lect.uniqueQuestionsAttempted} / {lect.totalPublishedQuestions}
                      </td>
                      <td className="py-2 px-3 text-right font-mono-tabular">
                        {lect.totalAnswersSubmitted}
                      </td>
                      <td className="py-2 px-3 text-right font-mono-tabular">
                        {lect.totalAnswersSubmitted > 0
                          ? `${lect.accuracyPercentage}%`
                          : '—'}
                      </td>
                      <td className="py-2 pl-3 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            onStartQuickSession({
                              mode: 'study',
                              lectureIds: [lect.lectureId],
                              title: `${lect.title} — Study Session`,
                            })
                          }
                          className="text-slate-600 hover:text-slate-900 font-medium cursor-pointer"
                        >
                          Start quiz
                        </button>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent activity remains full-width after removal of topic analysis. */}
      <div className="space-y-6">
        {/* Recent Exam & Practice Sessions */}
        <div className="lg:col-span-6 bg-white rounded-xl border border-slate-200 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Recent Sessions &amp; Exam Results
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Open any completed attempt to review your answers or resume an interrupted session.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab('progress')}
              className="text-xs font-semibold text-[var(--ma-brand)] hover:underline cursor-pointer"
            >
              Full History →
            </button>
          </div>

          {history.length === 0 ? (
            <div className="p-6 rounded-lg bg-slate-50 text-center text-xs text-slate-500">
              No sessions recorded yet. Start a Study or Exam session to track your history.
            </div>
          ) : (
            <div className="space-y-3">
              {history.slice(0, 5).map((sess: any) => (
                <div
                  key={sess.id}
                  className="p-3.5 rounded-lg border border-slate-200 flex items-center justify-between gap-4 text-xs"
                >
                  <div className="space-y-0.5">
                    <p className="font-semibold text-slate-900">{sess.title}</p>
                    <p className="text-slate-500">
                      Mode: {sess.mode.toUpperCase()} · {sess.totalQuestions} questions ·{' '}
                      {new Date(sess.startedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {sess.status === 'completed' ? (
                      <span className="font-mono-tabular font-bold text-slate-900">
                        {sess.scorePercentage}% ({sess.correctCount}/{sess.totalQuestions})
                      </span>
                    ) : (
                      <span className="text-amber-700 font-semibold">In Progress</span>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenSession(sess.id)}
                      className="px-3 py-1.5 font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md cursor-pointer"
                    >
                      {sess.status === 'completed' ? 'Review' : 'Resume'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 2. SUBJECTS & LECTURES BROWSER VIEW (MODULE PAGE — LECTURES)
// ============================================================================
export const SubjectsAndLecturesView: React.FC<{
  catalog: any;
  dashboardData?: any;
  initialSelectedSubjectId?: number | 'all' | null;
  onStartSession: (params: any) => void;
  onRefresh?: () => void;
  isAdmin?: boolean;
}> = ({
  catalog,
  dashboardData,
  initialSelectedSubjectId,
  onStartSession,
  onRefresh,
  isAdmin = false,
}) => {
  const subjects = catalog?.subjects || [];
  const linkedLectureId=useLectureLinkId();
  const linkedSubjectId=subjects.find((subject:any)=>subject.lectures?.some((lecture:any)=>lecture.id===linkedLectureId))?.id;
  const [lectureSearch, setLectureSearch] = useState('');
  const search = lectureSearch.trim().toLocaleLowerCase();
  const modules = catalog?.modules || [];
  const moduleOptions = groupLectureModules(modules);
  const [selectedModuleId, setSelectedModuleId] = useState<number | 'all'>('all');
  const [expandedSubjectIds, setExpandedSubjectIds] = useState<Set<number>>(() =>
    new Set(typeof initialSelectedSubjectId === 'number' ? [initialSelectedSubjectId] : []));
  useEffect(()=>{
    if(linkedSubjectId){setSelectedModuleId('all');setLectureSearch('');setExpandedSubjectIds(previous=>previous.has(linkedSubjectId)?previous:new Set([...previous,linkedSubjectId]));}
  },[linkedLectureId,linkedSubjectId]);
  useScrollToLecture(linkedLectureId,Boolean(linkedSubjectId&&expandedSubjectIds.has(linkedSubjectId)&&!search&&selectedModuleId==='all'));
  const [expandedNotesLectureId, setExpandedNotesLectureId] = useState<number | null>(null);
  const [activePdf, setActivePdf] = useState<{ url: string; title: string; initialPage?: number } | null>(null);
  const [resetConfirmLecture, setResetConfirmLecture] = useState<{ id: number; title: string } | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [resetSuccessMessage, setResetSuccessMessage] = useState<string | null>(null);
  const [uploadModalLecture, setUploadModalLecture] = useState<{
    id: number;
    title: string;
    subjectTitle?: string;
    lectureNumber?: number;
    pdfUrl?: string | null;
  } | null>(null);

  // A Home card is an expansion request, never a filter hiding the other subjects.
  useEffect(() => {
    if (typeof initialSelectedSubjectId === 'number') {
      setSelectedModuleId('all');
      setLectureSearch('');
      setExpandedSubjectIds(previous => new Set([...previous, initialSelectedSubjectId]));
    }
  }, [initialSelectedSubjectId]);

  const selectedModule = moduleOptions.find(module => module.id === selectedModuleId);
  const moduleSubjects = selectedModuleId === 'all' ? subjects : subjects.filter((subject: any) => selectedModule?.moduleIds.includes(subject.moduleId));
  const matchingSubjects = moduleSubjects.filter((s: any) => !search || s.title.toLocaleLowerCase().includes(search) ||
    (s.lectures || []).some((l: any) => l.title.toLocaleLowerCase().includes(search)));
  const lectureCount = moduleSubjects.reduce((n: number, subject: any) => n + (subject.lectures?.length || 0), 0);
  const questionCount = moduleSubjects.reduce((n: number, subject: any) => n + (subject.questionCount || 0), 0);

  return (
    <div className="ma-library space-y-6">
      <header className="ma-library-hero">
        <div>
          <span className="ma-eyebrow"><BookOpen size={14} /> Your learning library</span>
          <h1>Lectures<span className="ma-title-dot">.</span></h1>
          <p>A little focus. A clearer understanding.<br className="hidden sm:block" /> Find your subject and pick up where you left off.</p>
          <div className="ma-library-actions">
            <button type="button" onClick={() => setExpandedSubjectIds(new Set(matchingSubjects.map((subject: any) => subject.id)))} disabled={!matchingSubjects.length}>
              <ChevronsUpDown size={16} aria-hidden="true" /> Expand all subjects
            </button>
            <button type="button" onClick={() => { setLectureSearch(''); setExpandedSubjectIds(new Set()); }}>
              <ChevronsDownUp size={16} aria-hidden="true" /> Collapse all
            </button>
          </div>
        </div>
        <div className="ma-library-totals" aria-label="Curriculum totals">
          <div><strong>{moduleSubjects.length}</strong><span>Subjects</span></div>
          <div><strong>{lectureCount}</strong><span>Lectures</span></div>
          <div><strong>{questionCount.toLocaleString()}</strong><span>questions</span></div>
        </div>
      </header>
      <div className="ma-library-toolbar">
        <label className="ma-search">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Search subjects and lectures</span>
          <input type="search" value={lectureSearch} onChange={(e) => setLectureSearch(e.target.value)} placeholder="Search subjects or lectures…" />
        </label>
        <label className="ma-module-filter">
          <Layers size={17} aria-hidden="true" />
          <span className="sr-only">Filter lectures by module</span>
          <select value={selectedModuleId} onChange={event => setSelectedModuleId(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
            <option value="all">All modules</option>
            {moduleOptions.map(module => <option key={module.id} value={module.id}>{module.label}</option>)}
          </select>
        </label>
      </div>
      <p className="text-xs text-slate-500">Completed counts include study, custom practice, and submitted exams. Continue learning opens the first unanswered question.</p>
      {resetSuccessMessage && (
        <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-semibold text-emerald-800 flex items-center justify-between">
          <span>{resetSuccessMessage}</span>
          <button
            type="button"
            onClick={() => setResetSuccessMessage(null)}
            className="text-emerald-700 hover:text-emerald-900 cursor-pointer ml-3 font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {matchingSubjects.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-600">
          No matching subjects or lectures found.
        </div>
      ) : (
        <div className="space-y-8">
          {matchingSubjects.map((subject: any, subjectIndex: number) => {
            // Find student metrics for this module
            const subjectRecord=dashboardData?.subjectProgress?.find((p:any)=>p.subjectId===subject.id);
            const subjProgress = {...subjectRecord,uniqueQuestionsAttempted:(subject.lectures||[]).reduce((sum:number,lecture:any)=>sum+(subjectRecord?.lectures?.find((p:any)=>p.lectureId===lecture.id)?.uniqueQuestionsAttempted??lecture.attemptedQuestions??0),0)};

            // Sort lectures belonging to the selected module in their correct order
            const sortedLectures = [...(subject.lectures || [])].filter((l: any) => !search || subject.title.toLocaleLowerCase().includes(search) || l.title.toLocaleLowerCase().includes(search)).sort(
              (a: any, b: any) => (Number(a.lectureNumber) || 0) - (Number(b.lectureNumber) || 0)
            );

            return (
              <details key={subject.id}
                open={expandedSubjectIds.has(subject.id) || Boolean(search)}
                onToggle={event => {
                  if (search) return;
                  const open = event.currentTarget.open;
                  setExpandedSubjectIds(previous => {
                    if (previous.has(subject.id) === open) return previous;
                    const next = new Set(previous);
                    if (open) next.add(subject.id); else next.delete(subject.id);
                    return next;
                  });
                }}
                className="ma-subject group">
                <summary className="ma-subject-summary">
                  <span className="ma-subject-icon" aria-hidden="true"><BookOpen size={22} strokeWidth={1.6} /></span>
                  <span className="ma-subject-heading"><span className="ma-eyebrow">Subject {String(subjectIndex + 1).padStart(2, '0')}</span><span className="ma-subject-title">{subject.title}</span><span className="ma-subject-meta">{sortedLectures.length} lectures <span aria-hidden="true">·</span> {subject.questionCount || 0} questions</span></span>
                  <span className="ma-subject-progress"><span>{Math.min(100, Math.round((subjProgress?.uniqueQuestionsAttempted || 0) / Math.max(1, subject.questionCount || 0) * 100))}% completed</span><span className="ma-progress-track"><span style={{width: `${Math.min(100, (subjProgress?.uniqueQuestionsAttempted || 0) / Math.max(1, subject.questionCount || 0) * 100)}%`}} /></span></span>
                  <ChevronDown className="ma-subject-chevron" size={19} aria-hidden="true" />
                </summary>
                <div className="ma-subject-body">
                {/* Module Summary Banner */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100">
                  <div className="space-y-1 min-w-0">
                    <h2 className="ma-section-title">Your path through {subject.title}</h2>
                    <p className="text-sm text-slate-500">{subject.description || 'Choose a lecture below, or practise the whole subject.'}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        onStartSession({
                          mode: 'study',
                          lectureIds: (subject.lectures||[]).map((lecture:any)=>lecture.id),
                          title: `${subject.title} — Comprehensive Study`,
                        })
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-[var(--ma-brand)] hover:bg-[var(--ma-brand-hover)] rounded-lg cursor-pointer"
                    >
                      Study Entire Subject
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onStartSession({
                          mode: 'exam',
                          lectureIds: (subject.lectures||[]).map((lecture:any)=>lecture.id),
                          title: `${subject.title} — Module Mock Exam`,
                          shuffleQuestions: true,
                          shuffleOptions: true,
                        })
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                    >
                      Subject Exam
                    </button>
                  </div>
                </div>

                {/* Lectures List in correct order */}
                <div className="space-y-4">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Lectures in this Subject ({sortedLectures.length})
                  </h3>

                  <div className="grid grid-cols-1 gap-4">
                    {sortedLectures.map((lect: any) => {
                      const notesOpen = expandedNotesLectureId === lect.id;
                      const lectProgress = subjProgress?.lectures?.find(
                        (l: any) => l.lectureId === lect.id
                      );

                      const totalQuestions =
                        lect.questionCount ?? lectProgress?.totalPublishedQuestions ?? 0;
                      const attemptedQuestions = lectProgress?.uniqueQuestionsAttempted ?? 0;
                      const incorrectAnswers = lectProgress?.incorrectAnswers ?? 0;
                      const accuracy =
                        lectProgress && lectProgress.totalAnswersSubmitted > 0
                          ? `${lectProgress.accuracyPercentage}%`
                          : '—';
                      const pdfUrl = lect.pdfUrl || lectProgress?.pdfUrl || null;

                      return (
                        <div
                          key={lect.id}
                          id={`lecture-${lect.id}`}
                          className="ma-lecture-card space-y-4 scroll-mt-24"
                        >
                          {/* Lecture Title & Details */}
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-mono-tabular font-bold uppercase tracking-wider text-[var(--ma-brand)] bg-sky-50 px-2 py-0.5 rounded">
                                Lecture {lect.lectureNumber}
                              </span>
                            </div>
                            <h4 className="text-base font-bold text-slate-900 mt-1">
                              {lect.title}
                            </h4>
                            {lect.description && (
                              <p className="text-xs text-slate-600 leading-relaxed">
                                {lect.description}
                              </p>
                            )}
                          </div>

                          <div className="ma-lecture-metrics grid grid-cols-3 gap-4 text-xs">
                            <div><span className="ma-metric-label">Question bank</span><strong className="ma-metric-value">{totalQuestions} <small>questions</small></strong></div>
                            <div><span className="ma-metric-label" title="Unique questions answered across study, custom practice, and submitted exams">Completed</span><strong className="ma-metric-value">{attemptedQuestions}<small> / {totalQuestions}</small></strong></div>
                            <div><span className="ma-metric-label">Accuracy</span><strong className="ma-metric-value">{accuracy}</strong></div>
                          </div>

                          <div className="ma-lecture-progress">
                            <span>{attemptedQuestions === 0 ? 'Ready when you are' : `${attemptedQuestions} of ${totalQuestions} questions completed`}</span>
                            <span className="ma-progress-track"><span style={{width: `${Math.min(100, attemptedQuestions / Math.max(1, totalQuestions) * 100)}%`}} /></span>
                          </div>
                          {/* Action Buttons: Study, Review Mistakes, Open Lecture PDF */}
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() =>
                                onStartSession({
                                  mode: 'study',
                                  lectureIds: [lect.id],
                                  title: `${lect.title} — Study`,
                                })
                              }
                              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[var(--ma-brand)] hover:bg-[var(--ma-brand-hover)] rounded-lg transition-colors cursor-pointer"
                            >
                              <Play className="w-3.5 h-3.5" />
                              <span>{attemptedQuestions > 0 && attemptedQuestions < totalQuestions ? 'Continue learning' : attemptedQuestions >= totalQuestions && totalQuestions > 0 ? 'Review lecture' : 'Start learning'} <ArrowRight className="inline w-3.5 h-3.5 ml-1" /></span>
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                if (incorrectAnswers > 0) {
                                  onStartSession({
                                    mode: 'study',
                                    lectureIds: [lect.id],
                                    title: `${lect.title} — Review Mistakes`,
                                    onlyMistakes: true,
                                  });
                                }
                              }}
                              disabled={incorrectAnswers === 0}
                              title={
                                incorrectAnswers === 0
                                  ? 'No incorrect questions to review for this lecture'
                                  : `Review ${incorrectAnswers} mistakes`
                              }
                              className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors ${
                                incorrectAnswers > 0
                                  ? 'text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 cursor-pointer'
                                  : 'text-slate-400 bg-slate-50 border border-slate-200 cursor-not-allowed opacity-60'
                              }`}
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>Review Mistakes ({incorrectAnswers})</span>
                            </button>

                            {pdfUrl ? (
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setActivePdf({
                                      url: pdfUrl,
                                      title: lect.title,
                                      initialPage: 1,
                                    })
                                  }
                                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 rounded-lg transition-colors cursor-pointer"
                                >
                                  <FileText className="w-3.5 h-3.5 text-[var(--ma-brand)]" />
                                  <span>Open Lecture PDF</span>
                                </button>
                                {isAdmin && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setUploadModalLecture({
                                        id: lect.id,
                                        title: lect.title,
                                        subjectTitle: subject.title,
                                        lectureNumber: lect.lectureNumber,
                                        pdfUrl: lect.pdfUrl,
                                      });
                                    }}
                                    className="p-2 text-slate-400 hover:text-[var(--ma-brand)] hover:bg-sky-50 rounded-lg border border-slate-200 transition-colors cursor-pointer"
                                    title="Administrator: Replace lecture PDF"
                                  >
                                    <Upload className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            ) : isAdmin ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setUploadModalLecture({
                                    id: lect.id,
                                    title: lect.title,
                                    subjectTitle: subject.title,
                                    lectureNumber: lect.lectureNumber,
                                    pdfUrl: null,
                                  });
                                }}
                                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[var(--ma-brand)] bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-lg transition-colors cursor-pointer"
                                title="Administrator: Upload PDF slide deck to this lecture"
                              >
                                <Upload className="w-3.5 h-3.5" />
                                <span>Upload PDF</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled
                                title="No PDF document attached to this lecture"
                                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-400 bg-slate-50 border border-slate-200 rounded-lg cursor-not-allowed opacity-60"
                              >
                                <FileText className="w-3.5 h-3.5" />
                                <span>No PDF</span>
                              </button>
                            )}

                            {attemptedQuestions > 0 && (
                              <button
                                type="button"
                                onClick={() =>
                                  setResetConfirmLecture({
                                    id: lect.id,
                                    title: lect.title,
                                  })
                                }
                                title="Reset all answers and restart this lecture quiz from Question 1"
                                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-600 bg-white hover:bg-rose-50 hover:text-rose-700 border border-slate-200 hover:border-rose-200 rounded-lg transition-colors cursor-pointer"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>Reset Progress</span>
                              </button>
                            )}

                            {lect.educationalNotes && (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedNotesLectureId(notesOpen ? null : lect.id)
                                }
                                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer ml-auto"
                              >
                                <FileText className="w-3.5 h-3.5" />
                                {notesOpen ? 'Hide Notes' : 'Read Notes'}
                              </button>
                            )}
                          </div>

                          {/* Optional High Yield Notes */}
                          {notesOpen && lect.educationalNotes && (
                            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700 whitespace-pre-line leading-relaxed">
                              <p className="font-bold text-slate-900 mb-1.5">
                                High-Yield Lecture Notes:
                              </p>
                              {lect.educationalNotes}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                </div>
              </details>
            );
          })}
        </div>
      )}

      {/* Real Responsive PDF Viewer Modal */}
      {activePdf && (
        <PdfViewerModal
          pdfUrl={activePdf.url}
          lectureTitle={activePdf.title}
          initialPage={activePdf.initialPage || 1}
          onClose={() => setActivePdf(null)}
        />
      )}

      {/* Confirmation Modal to Reset Lecture Progress */}
      {resetConfirmLecture && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-xl space-y-4">
            <div className="flex items-center gap-3 text-amber-600">
              <div className="p-2 bg-amber-50 rounded-full">
                <RotateCcw className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-slate-900">Reset Lecture Progress?</h3>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Are you sure you want to restart all progress for{' '}
              <span className="font-semibold text-slate-900">&ldquo;{resetConfirmLecture.title}&rdquo;</span>?
              All submitted answers, quiz scores, and attempts for this lecture will be completely erased so you can solve it fresh from Question 1.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={isResetting}
                onClick={() => setResetConfirmLecture(null)}
                className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isResetting}
                onClick={async () => {
                  try {
                    setIsResetting(true);
                    await api.resetLectureProgress(resetConfirmLecture.id);
                    setResetSuccessMessage(
                      `Progress for "${resetConfirmLecture.title}" has been reset. You can now start fresh!`
                    );
                    setTimeout(() => setResetSuccessMessage(null), 4000);
                    setResetConfirmLecture(null);
                    onRefresh?.();
                  } catch (err: any) {
                    alert(err.message || 'Failed to reset lecture progress.');
                  } finally {
                    setIsResetting(false);
                  }
                }}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg cursor-pointer"
              >
                {isResetting ? 'Resetting...' : 'Yes, Reset & Restart'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Quick Upload PDF Modal */}
      {uploadModalLecture && (
        <UploadPdfModal
          isOpen={Boolean(uploadModalLecture)}
          onClose={() => setUploadModalLecture(null)}
          targetLecture={uploadModalLecture}
          onSuccess={() => {
            setUploadModalLecture(null);
            onRefresh?.();
          }}
        />
      )}
    </div>
  );
};

// ============================================================================
// 3. CUSTOM PRACTICE BUILDER VIEW (MODE C)
// ============================================================================
export const CustomPracticeView: React.FC<{
  catalog: any;
  onStartSession: (params: any) => void;
}> = ({ catalog, onStartSession }) => {
  const subjects = catalog?.subjects || [];
  const allLectures = catalog?.lectures || [];

  const [selectedSubjectIds, setSelectedSubjectIds] = useState<number[]>([]);
  const [selectedLectureIds, setSelectedLectureIds] = useState<number[]>([]);
  const [selectedDifficulties, setSelectedDifficulties] = useState<string[]>([]);
  const [selectedSpecialTags, setSelectedSpecialTags] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState('');
  const [questionCount, setQuestionCount] = useState(5);
  const [shuffleQuestions, setShuffleQuestions] = useState(true);
  const [shuffleOptions, setShuffleOptions] = useState(true);
  const [avoidRecent, setAvoidRecent] = useState(true);
  const [onlyMistakes, setOnlyMistakes] = useState(false);
  const [sessionMode, setSessionMode] = useState<'custom' | 'exam'>('custom');

  const toggleItem = <T,>(list: T[], val: T, setter: (next: T[]) => void) => {
    if (list.includes(val)) setter(list.filter((x) => x !== val));
    else setter([...list, val]);
  };

  const filteredLectures =
    selectedSubjectIds.length === 0
      ? allLectures
      : allLectures.filter((l: any) => selectedSubjectIds.includes(l.subjectId));

  const activeScopeLectures =
    selectedLectureIds.length > 0
      ? filteredLectures.filter((l: any) => selectedLectureIds.includes(l.id))
      : filteredLectures;

  const specialTagCountsMap = new Map<string, { label: string; count: number }>();
  for (const preset of ['Old Exams', 'كتاب القسم', 'Important']) {
    specialTagCountsMap.set(preset.toLowerCase(), { label: preset, count: 0 });
  }
  for (const lect of activeScopeLectures) {
    const breakdown = lect.specialTagBreakdown || {};
    for (const [label, cnt] of Object.entries(breakdown)) {
      const normKey = label.toLowerCase() === 'old exam' ? 'old exams' : label.toLowerCase();
      const existing = specialTagCountsMap.get(normKey);
      specialTagCountsMap.set(normKey, {
        label: existing?.label || (normKey === 'old exams' ? 'Old Exams' : label),
        count: (existing?.count || 0) + Number(cnt || 0),
      });
    }
  }
  const availableSpecialTagOptions = Array.from(specialTagCountsMap.values());

  const handleLaunchCustom = (e: React.FormEvent) => {
    e.preventDefault();
    onStartSession({
      mode: sessionMode,
      title:
        sessionMode === 'exam'
          ? `Custom Timed Exam (${questionCount} questions)`
          : onlyMistakes
          ? `Review Mistakes Practice (${questionCount} questions)`
          : `Custom Practice Session (${questionCount} questions)`,
      subjectIds: selectedSubjectIds.length > 0 ? selectedSubjectIds : undefined,
      lectureIds: selectedLectureIds.length > 0 ? selectedLectureIds : undefined,
      difficulties: selectedDifficulties.length > 0 ? selectedDifficulties : undefined,
      specialTags: selectedSpecialTags.length > 0 ? selectedSpecialTags : undefined,
      tagFilter: tagFilter.trim() || undefined,
      requestedCount: Number(questionCount) || 5,
      shuffleQuestions,
      shuffleOptions,
      avoidRecent,
      onlyMistakes,
    });
  };

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeading eyebrow="Make it your own" title="Custom practice"
        description="Build a question set around the subjects, lectures, and topics you want to study." />

      <form
        onSubmit={handleLaunchCustom}
        className="bg-white rounded-xl border border-slate-200 p-6 space-y-6"
      >
        {/* 1. Select Subjects */}
        <div className="space-y-2">
          <label className="block text-xs font-bold text-slate-900">
            1. Select Subjects (Leave unselected to include all subjects)
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {subjects.map((s: any) => {
              const active = selectedSubjectIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() =>
                    toggleItem(selectedSubjectIds, s.id, setSelectedSubjectIds)
                  }
                  className={`p-3 rounded-lg border text-left text-xs transition-colors flex items-center justify-between cursor-pointer ${
                    active
                      ? 'border-[var(--ma-brand)] bg-sky-50/70 text-slate-900 font-semibold'
                      : 'border-slate-200 hover:border-slate-300 text-slate-700'
                  }`}
                >
                  <span>{s.title}</span>
                  <span className="font-mono-tabular text-slate-500">
                    {s.questionCount} questions
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 2. Select Specific Lectures */}
        <div className="space-y-2">
          <label className="block text-xs font-bold text-slate-900">
            2. Filter by Specific Lectures (Optional)
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-52 overflow-y-auto p-1">
            {filteredLectures.map((l: any) => {
              const active = selectedLectureIds.includes(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() =>
                    toggleItem(selectedLectureIds, l.id, setSelectedLectureIds)
                  }
                  className={`p-2.5 rounded-lg border text-left text-xs transition-colors flex items-center justify-between cursor-pointer ${
                    active
                      ? 'border-[var(--ma-brand)] bg-sky-50/70 text-slate-900 font-semibold'
                      : 'border-slate-200 hover:border-slate-300 text-slate-600'
                  }`}
                >
                  <span className="truncate pr-2">{l.title}</span>
                  <span className="font-mono-tabular shrink-0">
                    {l.questionCount} questions
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 3. Difficulty, Question Count & Topic Filter */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <label className="block text-xs font-bold text-slate-900">
              3. Difficulty Level
            </label>
            <div className="flex items-center gap-1.5">
              {['Easy', 'Medium', 'Hard'].map((diff) => {
                const active = selectedDifficulties.includes(diff);
                return (
                  <button
                    key={diff}
                    type="button"
                    onClick={() =>
                      toggleItem(
                        selectedDifficulties,
                        diff,
                        setSelectedDifficulties
                      )
                    }
                    className={`flex-1 py-2 text-xs font-semibold rounded-lg border transition-colors cursor-pointer ${
                      active
                        ? 'border-[var(--ma-brand)] bg-[var(--ma-brand)] text-white'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {diff}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="custom-question-count"
              className="block text-xs font-bold text-slate-900"
            >
              4. Number of Questions: <span className="font-mono-tabular">{questionCount}</span>
            </label>
            <input
              id="custom-question-count"
              type="number"
              min={1}
              max={100}
              value={questionCount}
              onChange={(e) => setQuestionCount(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm font-mono-tabular rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[var(--ma-brand)]"
            />
          </div>

          <div className="space-y-2">
            <label
              htmlFor="custom-topic-tag"
              className="block text-xs font-bold text-slate-900"
            >
              5. Topic Keyword (Optional)
            </label>
            <input
              id="custom-topic-tag"
              type="text"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              placeholder="e.g., Collagen, GFR, Necrosis"
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[var(--ma-brand)]"
            />
          </div>
        </div>

        {/* 6. Special Tags / Source Labels Filter */}
        <div className="space-y-2.5 pt-2 border-t border-slate-100">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-bold text-slate-900">
              6. Special Tags / Source Labels (Optional — e.g., Old Exam, كتاب القسم)
            </label>
            {selectedSpecialTags.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedSpecialTags([])}
                className="text-[11px] font-semibold text-[var(--ma-brand)] hover:underline cursor-pointer"
              >
                Clear Special Tags (Include All)
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedSpecialTags([])}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all cursor-pointer ${
                selectedSpecialTags.length === 0
                  ? 'bg-slate-900 text-white border-slate-900 shadow-2xs'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
            >
              All Questions
            </button>
            {availableSpecialTagOptions.map((item) => {
              const isSelected = selectedSpecialTags.includes(item.label);
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() =>
                    toggleItem(selectedSpecialTags, item.label, setSelectedSpecialTags)
                  }
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-amber-500 text-white border-amber-600 shadow-xs'
                      : 'bg-amber-50/70 text-amber-900 border-amber-300 hover:bg-amber-100'
                  }`}
                >
                  <Tag className="w-3 h-3 shrink-0" />
                  <span>{item.label}</span>
                  <span
                    className={`font-mono-tabular text-[10px] px-1.5 py-0.2 rounded-full ${
                      isSelected ? 'bg-amber-700/40 text-white' : 'bg-amber-200/70 text-amber-900'
                    }`}
                  >
                    {item.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 4. Randomization & Feedback Rules */}
        <div className="pt-4 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={shuffleQuestions}
              onChange={(e) => setShuffleQuestions(e.target.checked)}
              className="rounded border-slate-300 text-[var(--ma-brand)]"
            />
            <span className="font-medium text-slate-800">
              Shuffle question order randomly
            </span>
          </label>

          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={shuffleOptions}
              onChange={(e) => setShuffleOptions(e.target.checked)}
              className="rounded border-slate-300 text-[var(--ma-brand)]"
            />
            <span className="font-medium text-slate-800">
              Shuffle answer options (A–D) while preserving correct answer key
            </span>
          </label>

          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={avoidRecent}
              onChange={(e) => setAvoidRecent(e.target.checked)}
              className="rounded border-slate-300 text-[var(--ma-brand)]"
            />
            <span className="font-medium text-slate-800">
              Avoid recently answered questions when alternatives exist
            </span>
          </label>

          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyMistakes}
              onChange={(e) => setOnlyMistakes(e.target.checked)}
              className="rounded border-slate-300 text-[var(--ma-brand)]"
            />
            <span className="font-medium text-rose-700">
              Review Mistakes Only (filter questions previously answered incorrectly)
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <span className="font-semibold text-slate-800">Delivery Mode:</span>
            <button
              type="button"
              onClick={() => setSessionMode('custom')}
              className={`px-2.5 py-1 rounded-md font-semibold cursor-pointer ${
                sessionMode === 'custom'
                  ? 'bg-[var(--ma-brand)] text-white'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              Immediate Study Feedback
            </button>
            <button
              type="button"
              onClick={() => setSessionMode('exam')}
              className={`px-2.5 py-1 rounded-md font-semibold cursor-pointer ${
                sessionMode === 'exam'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              Timed Exam Mode
            </button>
          </div>
        </div>

        <div className="pt-2 flex justify-end">
          <button
            type="submit"
            className="px-6 py-2.5 text-sm font-semibold text-white bg-[var(--ma-brand)] hover:bg-[var(--ma-brand-hover)] rounded-lg transition-colors cursor-pointer"
          >
            Launch Custom Question Set
          </button>
        </div>
      </form>
    </div>
  );
};

// ============================================================================
// 4. MOCK EXAMS SIMULATION CENTER (MODE B)
// ============================================================================
export const MockExamsView: React.FC<{
  catalog: any;
  dashboardData: any;
  onStartSession: (params: any) => void;
  onOpenSession: (sessionId: number) => void;
  onRefresh?: () => void;
}> = ({ catalog, dashboardData, onStartSession, onOpenSession, onRefresh }) => {
  const modulesList = catalog?.modules || [];
  const subjects = catalog?.subjects || [];
  const allLectures = catalog?.lectures || [];

  // Active in-progress mock exams
  const inProgressExams = (dashboardData?.history || []).filter(
    (s: any) => s.status === 'in_progress' && s.mode === 'exam'
  );
  const activeExam = inProgressExams[0] || null;
  const [completionGate] = useState(() => new ExamCompletionGate());
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const finishExpiredExam = (id: number, retry = false) => {
    const request = completionGate.run(id, () => api.completeSession(id), retry);
    if (!request) return;
    setExpiryError(null);
    request.then(() => onRefresh?.()).catch(() => setExpiryError('Could not finish this exam. Your saved answers are preserved.'));
  };

  const computeExamRemaining = (exam: any): number => {
    if (!exam) return 0;
    const limitSecs = exam.timeLimitSeconds || 45 * 60;
    const startedMs = new Date(exam.startedAt).getTime();
    if (Number.isFinite(startedMs)) {
      const elapsed = Math.floor((Date.now() - startedMs) / 1000);
      return Math.max(0, limitSecs - elapsed);
    }
    return typeof exam.remainingSeconds === 'number' ? Math.max(0, exam.remainingSeconds) : 0;
  };

  const [activeRemainingSecs, setActiveRemainingSecs] = useState<number>(() =>
    computeExamRemaining(activeExam)
  );

  useEffect(() => {
    if (!activeExam) {
      setActiveRemainingSecs(0);
      return;
    }
    const updateTimer = () => {
      const rem = computeExamRemaining(activeExam);
      setActiveRemainingSecs(rem);
      if (rem <= 0) {
        clearInterval(timer);
        finishExpiredExam(activeExam.id);
      }
    };
    const timer = setInterval(updateTimer, 1000);
    updateTimer();
    return () => clearInterval(timer);
  }, [activeExam?.id, activeExam?.startedAt, activeExam?.timeLimitSeconds, completionGate]);

  const hasActiveRunningExam = Boolean(activeExam && activeRemainingSecs > 0);
  const formatCountdown = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // 1. Module Selection (Defaults to first module, e.g. BSF 112)
  const [selectedModuleId, setSelectedModuleId] = useState<number | 'all'>(() => {
    return modulesList[0]?.id || 'all';
  });

  // Filter available subjects based on selected module
  const availableSubjects =
    selectedModuleId === 'all'
      ? subjects
      : subjects.filter((s: any) => s.moduleId === selectedModuleId);

  // 2. Multi-Subject Selection ("allow any number of subjects")
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<number[]>(() => {
    return availableSubjects.map((s: any) => s.id);
  });

  // Keep selected subjects in sync when module changes
  useEffect(() => {
    if (availableSubjects.length > 0) {
      setSelectedSubjectIds(availableSubjects.map((s: any) => s.id));
    } else {
      setSelectedSubjectIds([]);
    }
  }, [selectedModuleId]);

  // 3. Lecture Selection ("make an option for all the lectures in the subject")
  const relevantLectures = allLectures.filter((l: any) =>
    selectedSubjectIds.includes(l.subjectId)
  );

  const [selectedLectureIds, setSelectedLectureIds] = useState<number[]>([]);

  // Automatically default all lectures selected when subjects change
  useEffect(() => {
    setSelectedLectureIds(relevantLectures.map((l: any) => l.id));
  }, [selectedSubjectIds.join(',')]);

  // 4. Exam Parameters
  const [questionCount, setQuestionCount] = useState<number>(30);
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<number>(45);
  const [selectedSpecialTags, setSelectedSpecialTags] = useState<string[]>([]);

  const toggleSpecialTag = (tagLabel: string) => {
    setSelectedSpecialTags((prev) =>
      prev.includes(tagLabel) ? prev.filter((t) => t !== tagLabel) : [...prev, tagLabel]
    );
  };

  const toggleSubject = (subjId: number) => {
    setSelectedSubjectIds((prev) => {
      if (prev.includes(subjId)) {
        if (prev.length === 1) return prev; // Keep at least one
        return prev.filter((id) => id !== subjId);
      }
      return [...prev, subjId];
    });
  };

  const toggleLecture = (lectId: number) => {
    setSelectedLectureIds((prev) => {
      if (prev.includes(lectId)) {
        return prev.filter((id) => id !== lectId);
      }
      return [...prev, lectId];
    });
  };

  // Select all / Deselect all lectures for a specific subject
  const toggleAllLecturesForSubject = (subjId: number) => {
    const subjectLectures = allLectures.filter((l: any) => l.subjectId === subjId);
    const subjectLectIds = subjectLectures.map((l: any) => l.id);
    const allSelected = subjectLectIds.every((id: number) => selectedLectureIds.includes(id));

    if (allSelected) {
      // Remove all lectures of this subject
      setSelectedLectureIds((prev) => prev.filter((id) => !subjectLectIds.includes(id)));
    } else {
      // Add all lectures of this subject
      setSelectedLectureIds((prev) => Array.from(new Set([...prev, ...subjectLectIds])));
    }
  };

  const selectedLecturesObjects = relevantLectures.filter((l: any) =>
    selectedLectureIds.includes(l.id)
  );

  const mockSpecialTagsMap = new Map<string, { label: string; count: number }>();
  for (const preset of ['Old Exams', 'كتاب القسم', 'Important']) {
    mockSpecialTagsMap.set(preset.toLowerCase(), { label: preset, count: 0 });
  }
  for (const lect of selectedLecturesObjects) {
    const breakdown = lect.specialTagBreakdown || {};
    for (const [label, cnt] of Object.entries(breakdown)) {
      const normKey = label.toLowerCase() === 'old exam' ? 'old exams' : label.toLowerCase();
      const existing = mockSpecialTagsMap.get(normKey);
      mockSpecialTagsMap.set(normKey, {
        label: existing?.label || (normKey === 'old exams' ? 'Old Exams' : label),
        count: (existing?.count || 0) + Number(cnt || 0),
      });
    }
  }
  const availableMockSpecialTags = Array.from(mockSpecialTagsMap.values());

  const totalUnfilteredInSelection = selectedLecturesObjects.reduce(
    (sum: number, l: any) => sum + (l.questionCount || 0),
    0
  );

  const totalAvailableInSelection =
    selectedSpecialTags.length === 0
      ? totalUnfilteredInSelection
      : selectedSpecialTags.reduce((sum, label) => {
          const entry = mockSpecialTagsMap.get(label.toLowerCase());
          return sum + (entry?.count || 0);
        }, 0);

  const selectedModuleObj = modulesList.find((m: any) => m.id === selectedModuleId);
  const selectedSubjectTitles = availableSubjects
    .filter((s: any) => selectedSubjectIds.includes(s.id))
    .map((s: any) => s.title);

  const handleLaunchMockExam = (e: React.FormEvent) => {
    e.preventDefault();
    if (hasActiveRunningExam || totalAvailableInSelection <= 0) return;
    const count = Math.min(questionCount, Math.max(1, totalAvailableInSelection || 10));
    const tagSuffix =
      selectedSpecialTags.length > 0 ? ` [${selectedSpecialTags.join(', ')}]` : '';
    const title =
      selectedModuleObj
        ? `${selectedModuleObj.code} Mock Exam (${selectedSubjectTitles.join(' & ')})${tagSuffix}`
        : `Medical Mock Exam (${selectedSubjectTitles.join(' & ')})${tagSuffix}`;

    onStartSession({
      mode: 'exam',
      title,
      subjectIds: selectedSubjectIds.length > 0 ? selectedSubjectIds : undefined,
      lectureIds: selectedLectureIds.length > 0 ? selectedLectureIds : undefined,
      specialTags: selectedSpecialTags.length > 0 ? selectedSpecialTags : undefined,
      requestedCount: count,
      shuffleQuestions: true,
      shuffleOptions: true,
      timeLimitMinutes,
    });
  };

  return (
    <div className="space-y-6">
      <PageHeading eyebrow="Prepare with purpose" title="Mock exams"
        description="Choose your content and timing. Review your answers and explanations after submitting." />
      {expiryError && activeExam && <div role="alert" className="ma-dashboard-panel text-sm text-red-700">
        <p>{expiryError}</p><button type="button" onClick={() => finishExpiredExam(activeExam.id, true)} className="ma-text-button mt-3">Retry finishing exam</button>
      </div>}

      {/* Active Running Mock Exam Lock & Resume Banner */}
      {hasActiveRunningExam && activeExam && (
        <div className="bg-amber-50 rounded-2xl border-2 border-amber-300 p-5 sm:p-6 space-y-4 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-amber-200/80 text-amber-950 text-[11px] font-bold uppercase tracking-wider">
                <span className="w-2 h-2 rounded-full bg-red-600 animate-ping" />
                <span>Mock Exam Currently Running</span>
              </div>
              <h2 className="text-base sm:text-lg font-bold text-slate-900 pt-1">
                {activeExam.title}
              </h2>
              <p className="text-xs text-amber-900 leading-relaxed">
                You cannot open a new Mock Exam until you submit the active exam or its assigned time finishes.
              </p>
            </div>

            <div className="bg-white border border-amber-300 rounded-xl px-4 py-3 text-center shrink-0 shadow-2xs">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Time Remaining
              </div>
              <div className="text-2xl font-bold font-mono-tabular text-[#d9534f] mt-0.5">
                {formatCountdown(activeRemainingSecs)}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-amber-200 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="font-mono-tabular text-slate-700">
              <span>
                Answered: <b>{activeExam.answeredCount || 0}</b> / <b>{activeExam.totalQuestions}</b> Questions
              </span>
              <span className="mx-2 text-slate-300">|</span>
              <span>
                Assigned Time: <b>{Math.floor((activeExam.timeLimitSeconds || 2700) / 60)} min</b>
              </span>
            </div>
            <button
              type="button"
              onClick={() => onOpenSession(activeExam.id)}
              className="px-5 py-2.5 font-bold text-white bg-[var(--ma-brand)] hover:bg-[var(--ma-brand-hover)] rounded-lg cursor-pointer transition-colors shadow-xs flex items-center justify-center gap-2"
            >
              <span>Return to Active Mock Exam</span>
              <span>&rarr;</span>
            </button>
          </div>
        </div>
      )}

      {/* Interactive Mock Exam Configurator */}
      <form
        onSubmit={handleLaunchMockExam}
        className={`bg-white rounded-2xl border border-slate-200 p-6 sm:p-7 shadow-xs space-y-7 transition-opacity ${
          hasActiveRunningExam ? 'opacity-60' : ''
        }`}
      >
        {/* Step 1: Module Selector */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-[var(--ma-brand)] text-white flex items-center justify-center text-[10px]">1</span>
              <span>Select Academic Module</span>
            </label>
            <span className="text-[11px] text-slate-500 font-mono-tabular">
              {modulesList.length} Integrated Modules Available
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {modulesList.map((m: any) => {
              const isSelected = selectedModuleId === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedModuleId(m.id)}
                  className={`p-4 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                    isSelected
                      ? 'border-[var(--ma-brand)] bg-sky-50/60 ring-2 ring-[var(--ma-brand)]/20 shadow-xs'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <div className="space-y-1">
                    <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-[var(--ma-brand)]/15 text-[var(--ma-brand)]">
                      {m.code}
                    </span>
                    <h3 className="font-bold text-slate-900 text-sm">{m.title}</h3>
                    <p className="text-xs text-slate-500 line-clamp-2">{m.description}</p>
                  </div>
                  <div className="pt-3 mt-2 border-t border-slate-100 flex items-center justify-between text-[11px] font-mono-tabular text-slate-600">
                    <span>{m.subjects?.length || 0} Subjects</span>
                    <span>{m.questionCount || 0} questions</span>
                  </div>
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => setSelectedModuleId('all')}
              className={`p-4 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                selectedModuleId === 'all'
                  ? 'border-[var(--ma-brand)] bg-sky-50/60 ring-2 ring-[var(--ma-brand)]/20 shadow-xs'
                  : 'border-slate-200 hover:border-slate-300 bg-white'
              }`}
            >
              <div className="space-y-1">
                <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-700">
                  All Modules
                </span>
                <h3 className="font-bold text-slate-900 text-sm">Comprehensive Cross-Module</h3>
                <p className="text-xs text-slate-500">Include all available subjects and modules in the curriculum.</p>
              </div>
              <div className="pt-3 mt-2 border-t border-slate-100 text-[11px] font-mono-tabular text-slate-600">
                <span>{subjects.length} Total Subjects</span>
              </div>
            </button>
          </div>
        </div>

        {/* Step 2: Subject Selector ("allow any number of subjects") */}
        <div className="space-y-3 pt-3 border-t border-slate-100">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-[var(--ma-brand)] text-white flex items-center justify-center text-[10px]">2</span>
              <span>Choose Subjects (Select Any Number of Subjects)</span>
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedSubjectIds(availableSubjects.map((s: any) => s.id))}
                className="text-[11px] font-bold text-[var(--ma-brand)] hover:underline cursor-pointer"
              >
                Select All
              </button>
              <span className="text-slate-300">|</span>
              <button
                type="button"
                onClick={() => setSelectedSubjectIds(availableSubjects.slice(0, 1).map((s: any) => s.id))}
                className="text-[11px] font-semibold text-slate-500 hover:underline cursor-pointer"
              >
                Reset
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {availableSubjects.map((s: any) => {
              const isSelected = selectedSubjectIds.includes(s.id);
              return (
                <div
                  key={s.id}
                  onClick={() => toggleSubject(s.id)}
                  className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    isSelected
                      ? 'border-[var(--ma-brand)] bg-[var(--ma-brand)]/10 text-slate-900 font-bold shadow-2xs'
                      : 'border-slate-200 hover:border-slate-300 text-slate-700 bg-white'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className={`w-4 h-4 rounded-xs border flex items-center justify-center shrink-0 ${
                        isSelected
                          ? 'bg-[var(--ma-brand)] border-[var(--ma-brand)] text-white'
                          : 'border-slate-400 bg-white'
                      }`}
                    >
                      {isSelected && <span className="text-[10px] font-bold">✓</span>}
                    </div>
                    <span className="text-xs truncate">{s.title}</span>
                  </div>
                  <span className="text-[11px] font-mono-tabular text-slate-500 shrink-0">
                    {s.questionCount || 0} questions
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Step 3: Lecture Selector ("make an option for all the lectures in the subject") */}
        <div className="space-y-4 pt-3 border-t border-slate-100">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-[var(--ma-brand)] text-white flex items-center justify-center text-[10px]">3</span>
              <span>Select Lectures for Selected Subjects</span>
            </label>
            <span className="text-xs font-mono-tabular text-slate-600 font-bold">
              {totalAvailableInSelection} Questions Selected in Pool
            </span>
          </div>

          <div className="space-y-4">
            {availableSubjects
              .filter((s: any) => selectedSubjectIds.includes(s.id))
              .map((subj: any) => {
                const subjectLectures = allLectures.filter((l: any) => l.subjectId === subj.id);
                const subjLectIds = subjectLectures.map((l: any) => l.id);
                const allSelected = subjLectIds.length > 0 && subjLectIds.every((id: number) => selectedLectureIds.includes(id));

                return (
                  <div
                    key={subj.id}
                    className="bg-slate-50/70 border border-slate-200 rounded-xl p-4 space-y-3"
                  >
                    {/* Subject Header with "Select All Lectures in this Subject" */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-slate-200/80">
                      <div>
                        <h4 className="font-bold text-slate-900 text-xs sm:text-sm">
                          {subj.title}
                        </h4>
                        <p className="text-[11px] text-slate-500 font-mono-tabular">
                          {subjectLectures.length} Lectures Attached
                        </p>
                      </div>

                      {/* Prominent One-Click "Option for all the lectures in the subject" */}
                      <button
                        type="button"
                        onClick={() => toggleAllLecturesForSubject(subj.id)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                          allSelected
                            ? 'bg-[var(--ma-brand)] text-white shadow-xs hover:bg-[var(--ma-brand-hover)]'
                            : 'bg-white text-[var(--ma-brand)] border border-[var(--ma-brand)] hover:bg-sky-50'
                        }`}
                      >
                        <span>✓</span>
                        <span>
                          {allSelected
                            ? 'All Lectures Included (Click to Unselect)'
                            : 'Include All Lectures in this Subject'}
                        </span>
                      </button>
                    </div>

                    {/* Lecture Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {subjectLectures.map((lect: any) => {
                        const isChecked = selectedLectureIds.includes(lect.id);
                        return (
                          <div
                            key={lect.id}
                            onClick={() => toggleLecture(lect.id)}
                            className={`p-2.5 rounded-lg border text-xs flex items-center justify-between gap-2 transition-all cursor-pointer ${
                              isChecked
                                ? 'bg-white border-[var(--ma-brand)] shadow-2xs font-semibold text-slate-900'
                                : 'bg-white/60 border-slate-200 hover:border-slate-300 text-slate-600'
                            }`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleLecture(lect.id)}
                                className="accent-[var(--ma-brand)] cursor-pointer"
                              />
                              <span className="truncate">{lect.title}</span>
                            </div>
                            <span className="text-[10px] font-mono-tabular text-slate-500 shrink-0">
                              {lect.questionCount || 0} Qs
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>

        {/* Step 4: Filter by Special Tags / Source Labels (Optional) */}
        <div className="space-y-3 pt-3 border-t border-slate-100">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-[var(--ma-brand)] text-white flex items-center justify-center text-[10px]">4</span>
              <span>Filter by Special Tags / Source Labels (Optional — e.g., Old Exam, كتاب القسم)</span>
            </label>
            {selectedSpecialTags.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedSpecialTags([])}
                className="text-[11px] font-bold text-[var(--ma-brand)] hover:underline cursor-pointer"
              >
                Include All Questions
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedSpecialTags([])}
              className={`px-3.5 py-1.5 rounded-full text-xs font-bold border transition-all cursor-pointer ${
                selectedSpecialTags.length === 0
                  ? 'bg-[var(--ma-brand)] text-white border-[var(--ma-brand)] shadow-xs'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
            >
              All Questions ({totalUnfilteredInSelection})
            </button>

            {availableMockSpecialTags.map((item) => {
              const isSelected = selectedSpecialTags.includes(item.label);
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => toggleSpecialTag(item.label)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-amber-500 text-white border-amber-600 shadow-xs'
                      : 'bg-amber-50/70 text-amber-900 border-amber-300 hover:bg-amber-100'
                  }`}
                >
                  <Tag className="w-3 h-3 shrink-0" />
                  <span>{item.label}</span>
                  <span
                    className={`font-mono-tabular text-[10px] px-1.5 py-0.2 rounded-full ${
                      isSelected ? 'bg-amber-700/40 text-white' : 'bg-amber-200/70 text-amber-900'
                    }`}
                  >
                    {item.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Step 5: Exam Length & Time Settings */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-3 border-t border-slate-100">
          <div>
            <label className="block text-xs font-bold text-slate-900 mb-2 uppercase tracking-wider">
              Number of Questions
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              {[10, 20, 30, 40, 50].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => setQuestionCount(num)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono-tabular transition-colors cursor-pointer border ${
                    questionCount === num
                      ? 'bg-[var(--ma-brand)] text-white border-[var(--ma-brand)]'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {num} questions
                </button>
              ))}
              {totalAvailableInSelection > 0 && (
                <button
                  type="button"
                  onClick={() => setQuestionCount(totalAvailableInSelection)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono-tabular transition-colors cursor-pointer border ${
                    questionCount === totalAvailableInSelection
                      ? 'bg-[var(--ma-brand)] text-white border-[var(--ma-brand)]'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  All ({totalAvailableInSelection})
                </button>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-900 mb-2 uppercase tracking-wider">
              Time Limit (Minutes)
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              {[15, 30, 45, 60, 90].map((min) => (
                <button
                  key={min}
                  type="button"
                  onClick={() => setTimeLimitMinutes(min)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono-tabular transition-colors cursor-pointer border ${
                    timeLimitMinutes === min
                      ? 'bg-[var(--ma-brand)] text-white border-[var(--ma-brand)]'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {min} Min
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Launch Button */}
        <div className="pt-4 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="text-xs text-slate-600 font-mono-tabular">
            {hasActiveRunningExam ? (
              <span className="text-amber-800 font-semibold">
                Locked while active Mock Exam is running ({formatCountdown(activeRemainingSecs)} remaining)
              </span>
            ) : (
              <>
                Configured Simulation: <b>{Math.min(questionCount, totalAvailableInSelection || questionCount)} Questions</b> · <b>{timeLimitMinutes} Minutes</b>
              </>
            )}
          </div>
          <button
            type="submit"
            disabled={
              hasActiveRunningExam ||
              totalAvailableInSelection === 0
            }
            className="px-8 py-3 bg-[var(--ma-brand)] hover:bg-[var(--ma-brand-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm rounded-xl shadow-md transition-all cursor-pointer flex items-center justify-center gap-2"
          >
            {hasActiveRunningExam ? (
              <span>Locked Until Active Exam Submitted or Time Finishes</span>
            ) : (
              <>
                <span>Start Official University Simulation</span>
                <span>&rarr;</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};

// ============================================================================
// 5. BOOKMARKS & ANSWERED QUESTION REVIEW VIEW
// ============================================================================
export const BookmarksView: React.FC<{
  loading?: boolean;
  error?: string | null;
  bookmarksData: { bookmarks: any[]; answeredQuestions: any[]; answeredCount?: number; bookmarkCount?: number;
    reviewPagination?: { page: number; pageSize: number; totalCount: number; hasMore: boolean } } | null;
  catalog: any;
  onRefresh: () => void;
  onLoadReview?: (query: ReviewQuery) => void;
  onLoadSaved?: () => void;
}> = ({ bookmarksData, catalog, onRefresh, onLoadReview, onLoadSaved, loading = false, error }) => {
  const [subTab, setSubTab] = useState<'bookmarks' | 'review'>('bookmarks');
  const [subjectFilter, setSubjectFilter] = useState<number | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'correct' | 'incorrect' | 'unanswered'
  >('all');
  const [expandedQuestionId, setExpandedQuestionId] = useState<number | null>(null);

  const subjects = catalog?.subjects || [];
  const bookmarks = bookmarksData?.bookmarks || [];
  const answered = bookmarksData?.answeredQuestions || [];

  const filteredBookmarks = bookmarks.filter((b: any) =>
    subjectFilter === 'all' ? true : b.subjectId === subjectFilter
  );

  const filteredAnswered = answered.filter((a: any) => {
    const subjMatch = subjectFilter === 'all' || a.subjectId === subjectFilter;
    const statusMatch = statusFilter === 'all' || a.status === statusFilter;
    return subjMatch && statusMatch;
  });

  const activeList = subTab === 'bookmarks' ? filteredBookmarks : filteredAnswered;
  const pagination = bookmarksData?.reviewPagination;
  const loadReview = (page = 1, subject = subjectFilter, status = statusFilter) =>
    onLoadReview?.({ page, subjectId: subject === 'all' ? undefined : subject, status });

  if (loading) return <div role="status" className="ma-dashboard-panel">Loading your saved bookmarks…</div>;
  if (error) return <div role="alert" className="ma-dashboard-panel"><p>{error}</p><button type="button" onClick={onRefresh} className="ma-text-button mt-3">Retry loading bookmarks</button></div>;

  return (
    <div className="space-y-6">
      <PageHeading eyebrow="Your revision collection" title="Bookmarks & review"
        description="Keep useful questions close. Bookmarks save as soon as you select Save.">

        {/* Mode Switcher */}
        <div className="ma-segmented-control">
          <button
            type="button"
            onClick={() => { setSubTab('bookmarks'); onLoadSaved?.(); }}
            aria-pressed={subTab === 'bookmarks'}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              subTab === 'bookmarks'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Saved ({bookmarksData?.bookmarkCount ?? bookmarks.length})
          </button>
          <button
            type="button"
            onClick={() => { setSubTab('review'); loadReview(); }}
            aria-pressed={subTab === 'review'}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              subTab === 'review'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Answered ({bookmarksData?.answeredCount ?? answered.length})
          </button>
        </div>
      </PageHeading>

      {/* Filter Bar */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-700">Subject Filter:</span>
          <select
            aria-label="Filter by Subject"
            value={subjectFilter}
            onChange={(e) => {
              const subject = e.target.value === 'all' ? 'all' : Number(e.target.value);
              setSubjectFilter(subject);
              if (subTab === 'review') loadReview(1, subject);
            }}
            className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-800"
          >
            <option value="all">All Subjects</option>
            {subjects.map((s: any) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </div>

        {subTab === 'review' && (
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(['all', 'correct', 'incorrect', 'unanswered'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => { setStatusFilter(st); loadReview(1, subjectFilter, st); }}
                className={`px-3 py-1 rounded-md font-medium capitalize cursor-pointer ${
                  statusFilter === st
                    ? 'bg-white text-slate-900 shadow-xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeList.length === 0 ? (
        <div className="ma-empty-state">
          <Bookmark aria-hidden="true" />
          <h3>{subTab === 'bookmarks' ? 'A place for questions worth keeping' : 'Your review collection starts here'}</h3>
          <p>{subTab === 'bookmarks'
            ? 'Select Save on a question during any study or exam session. Try another subject filter if a saved question is missing.'
            : 'Your answered questions will appear here. Try another filter to find what you need.'}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {activeList.map((item: any) => {
            const isOpen = expandedQuestionId === item.questionId;
            return (
              <div
                key={item.questionId}
                className="bg-white rounded-xl border border-slate-200 p-5 space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>
                      <span className="font-semibold text-slate-800">
                        {item.subjectTitle}
                      </span>{' '}
                      · {item.lectureTitle} · Difficulty: {item.difficulty}
                    </span>
                    {parseAllQuestionTags(item.tags, item.specialTags).map((tagItem) => (
                      <span
                        key={tagItem.label}
                        className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] border ${
                          tagItem.isSpecial
                            ? 'font-bold bg-amber-100 text-amber-800 border-amber-300'
                            : 'font-medium bg-sky-50 text-sky-800 border-sky-200'
                        }`}
                        title={tagItem.isSpecial ? `Special Source Label: ${tagItem.label}` : `Topic Tag: ${tagItem.label}`}
                      >
                        <Tag className={`w-3 h-3 shrink-0 ${tagItem.isSpecial ? 'text-amber-600' : 'text-sky-600'}`} />
                        {tagItem.label}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-3">
                    {item.status && (
                      <span
                        className={`font-semibold ${
                          item.status === 'correct'
                            ? 'text-emerald-700'
                            : item.status === 'incorrect'
                            ? 'text-red-700'
                            : 'text-amber-700'
                        }`}
                      >
                        Last Attempt: {item.status.toUpperCase()}
                      </span>
                    )}
                    <BookmarkButton questionId={item.questionId} saved={subTab === 'bookmarks' || Boolean(item.isBookmarked)}/>
                    <QuestionReportButton questionId={item.questionId}/>
                  </div>
                </div>

                <p className="text-sm sm:text-base font-serif-academic text-slate-900 leading-relaxed">
                  {item.questionText}
                </p>
                <QuestionImages images={item.images}/>

                {item.note && (
                  <p className="text-xs text-slate-600 italic bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                    Personal Note: {item.note}
                  </p>
                )}

                <div className="flex items-center justify-between pt-2">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedQuestionId(isOpen ? null : item.questionId)
                    }
                    className="text-xs font-semibold text-[var(--ma-brand)] hover:text-[var(--ma-brand-hover)] cursor-pointer"
                  >
                    {isOpen
                      ? 'Hide Options & Explanation'
                      : 'View Options, Correct Answer & Explanation →'}
                  </button>
                </div>

                {isOpen && (
                  <div className="pt-4 border-t border-slate-100 space-y-3 text-xs">
                    {item.shortAnswerId&&<p>Short-answer question. Open its lecture or practical quiz to view your saved answer and grading.</p>}
                    {item.matching && <MatchingAnswerReview matching={item.matching} choiceId={item.matchingChoiceId}/>}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {(!item.matching&&!item.shortAnswerId ? ['A', 'B', 'C', 'D'] as const : []).map((optKey) => {
                        const text = item[`option${optKey}`];
                        const isCorrect = item.correctAnswer === optKey;
                        return (
                          <div
                            key={optKey}
                            className={`p-3 rounded-lg border ${
                              isCorrect
                                ? 'border-emerald-500 bg-emerald-50/70 text-emerald-950 font-semibold'
                                : 'border-slate-200 text-slate-700'
                            }`}
                          >
                            <span className="font-mono-tabular font-bold mr-1.5">
                              {optKey}.
                            </span>
                            {text}
                            {isCorrect && (
                              <span className="ml-2 text-emerald-700">✓ Correct</span>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {!item.shortAnswerId&&<div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                      <p className="font-bold text-slate-900">
                        {item.matching ? 'Explanation' : `Explanation (Correct Answer: ${item.correctAnswer})`}:
                      </p>
                      <p className="text-slate-700 leading-relaxed">
                        {item.explanation}
                      </p>
                      <QuestionImages images={item.explanationImages}/>
                    </div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {subTab === 'review' && pagination && <nav aria-label="Answered history pages" className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-slate-500">Page {pagination.page} of {Math.max(1, Math.ceil(pagination.totalCount / pagination.pageSize))} · {pagination.totalCount} questions</span>
        <div className="flex gap-2">
          <button type="button" disabled={pagination.page <= 1} onClick={() => loadReview(pagination.page - 1)} className="rounded-lg border border-slate-200 px-4 py-2 disabled:opacity-40">Previous</button>
          <button type="button" disabled={!pagination.hasMore} onClick={() => loadReview(pagination.page + 1)} className="rounded-lg border border-slate-200 px-4 py-2 disabled:opacity-40">Next</button>
        </div>
      </nav>}
    </div>
  );
};

// ============================================================================
// 6. MY PROGRESS & ATTEMPT HISTORY VIEW
// ============================================================================
export const ProgressHistoryView: React.FC<{
  dashboardData: any;
  onOpenSession: (sessionId: number) => void;
}> = ({ dashboardData, onOpenSession }) => {
  const [filter, setFilter] = useState<'all' | 'in_progress' | 'completed'>('all');
  const history = dashboardData?.history || [];
  const visible = history.filter((s: any) => filter === 'all' || s.status === filter);
  const activeCount = history.filter((s: any) => s.status === 'in_progress').length;
  const completedCount = history.filter((s: any) => s.status === 'completed').length;
  return <div className="space-y-6">
    <header className="ma-library-hero">
      <div><span className="ma-eyebrow"><TrendingUp size={14}/> Your study, at a glance</span>
        <h1>Dashboard<span className="ma-title-dot">.</span></h1>
        <p>Every lecture and practice session, organized in one place.</p></div>
      <div className="ma-library-totals">
        <div><strong>{history.length}</strong><span>Sessions</span></div>
        <div><strong>{activeCount}</strong><span>In progress</span></div>
        <div><strong>{completedCount}</strong><span>Completed</span></div>
      </div>
    </header>
    <section className="space-y-4" aria-labelledby="session-cards-title">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="session-cards-title" className="text-lg font-bold">Your sessions</h2>
        <div className="flex flex-wrap gap-2">{([{id:'all',label:'All sessions'},{id:'in_progress',label:'In progress'},{id:'completed',label:'Completed'}] as const).map((item)=><button key={item.id} type="button" aria-pressed={filter===item.id} onClick={()=>setFilter(item.id)} className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${filter===item.id?'border-sky-200 bg-sky-50 text-sky-800':'border-slate-200 bg-white text-slate-500'}`}>{item.label}</button>)}</div>
      </div>
      {visible.length === 0 ? <div className="ma-dashboard-panel py-10 text-center"><BookOpen className="mx-auto mb-3 text-slate-400"/><h3>{history.length ? 'No sessions match this filter' : 'Your next chapter starts here'}</h3><p>{history.length ? 'Choose another filter to see your sessions.' : 'Start a lecture or practice session to see it on your dashboard.'}</p></div> :
        <div className="grid gap-4 md:grid-cols-2">{visible.map((session: any)=>{
          const completed = session.status === 'completed';
          const active = session.status === 'in_progress';
          const answered = Math.min(session.totalQuestions || 0, Math.max(0, session.answeredCount ?? ((session.totalQuestions || 0)-(session.unansweredCount ?? session.totalQuestions ?? 0))));
          const percent = session.totalQuestions ? Math.round(answered/session.totalQuestions*100):0;
          return <article key={session.id} className="ma-session-card">
            <div className="flex items-center justify-between gap-3"><span className="ma-eyebrow">{session.mode === 'exam' ? 'Mock exam' : session.mode === 'custom' ? 'Custom practice' : 'Lecture study'}</span><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${completed?'bg-emerald-50 text-emerald-800':'bg-slate-100 text-slate-600'}`}>{completed?'Completed':active?'In progress':'Archived'}</span></div>
            <div><h3 className="mt-4 text-base font-bold leading-relaxed">{session.title}</h3><p className="mt-1 text-xs text-slate-500">{session.subjectTitle} · {session.lectureTitle}</p></div>
            <div className="my-5"><div className="mb-2 flex justify-between text-xs text-slate-500"><span>{answered} / {session.totalQuestions} questions answered</span><span>{percent}%</span></div><span className="ma-progress-track"><span style={{width:`${percent}%`}}/></span></div>
            <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <span className="text-xs text-slate-500">{completed ? `Score: ${session.scorePercentage}%` : `${Math.floor((session.elapsedSeconds || 0)/60)} min studied`}</span>
              <button type="button" onClick={()=>onOpenSession(session.id)} className="inline-flex items-center gap-2 rounded-lg bg-[var(--ma-brand)] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[var(--ma-brand-hover)]">{completed?'Review answers':active?'Continue learning':'View session'}<ArrowRight size={14}/></button>
            </div>
          </article>;
        })}</div>}
    </section>
  </div>;
};

// ============================================================================
// 7. PROFILE, SETTINGS & ENTITLEMENT STATUS VIEW
// ============================================================================
export const ProfileSettingsView: React.FC<{
  user: UserProfile;
  onUserUpdated: (user: UserProfile) => void;
  onAccountDeleted: () => void;
}> = ({ user, onUserUpdated, onAccountDeleted }) => {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [faculty, setFaculty] = useState(user.faculty || DEFAULT_FACULTY);
  const [saving, setSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      const res = await api.updateProfile(displayName, undefined, faculty);
      onUserUpdated(res.user);
      setStatusMsg('Username and faculty saved successfully.');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update profile.');
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPassword(true);
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      if (user.hasPassword !== false) {
        const res = await api.changePassword(currentPassword, newPassword);
        onUserUpdated(res.user);
        setStatusMsg(res.message || 'Password updated and older sessions revoked.');
      } else {
        const res = await api.linkPassword(newPassword);
        onUserUpdated(res.user);
        setStatusMsg(res.message || 'Local password linked to your account.');
      }
      setCurrentPassword('');
      setNewPassword('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update password.');
    } finally {
      setSavingPassword(false);
    }
  };

  const handleConfirmDelete = async () => {
    try {
      await api.deleteAccount();
      onAccountDeleted();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to delete account.');
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeading eyebrow="Your account" title="Profile & settings"
        description="Manage your profile, study preferences, and account access." />

      {statusMsg && (
        <div
          role="status"
          className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800"
        >
          {statusMsg}
        </div>
      )}

      {errorMsg && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800"
        >
          {errorMsg}
        </div>
      )}

      {/* Profile Form */}
      <form
        onSubmit={handleSaveProfile}
        className="bg-white rounded-xl border border-slate-200 p-6 space-y-4"
      >
        <h2 className="text-base font-bold text-slate-900">Account Identity</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <AcademicProfileFields idPrefix="profile" username={displayName} faculty={faculty} onUsernameChange={setDisplayName} onFacultyChange={setFaculty} disabled={saving} />

          <div>
            <label className="block font-semibold text-slate-700 mb-1">
              Registered Email Address
            </label>
            <input
              type="text"
              disabled
              value={user.email}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 bg-slate-50 text-slate-500"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 text-xs text-slate-600 font-mono-tabular">
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <p className="font-sans text-slate-500">Authenticated User ID</p>
            <p className="font-semibold text-slate-900 truncate mt-0.5">{user.uid}</p>
          </div>
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <p className="font-sans text-slate-500">Account Role</p>
            <p className="font-semibold text-slate-900 uppercase mt-0.5">
              {user.role}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <p className="font-sans text-slate-500">Account Created</p>
            <p className="font-semibold text-slate-900 mt-0.5">
              {new Date(user.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>

        <div className="pt-2 flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 text-xs font-semibold text-white bg-[var(--ma-brand)] hover:bg-[var(--ma-brand-hover)] rounded-lg cursor-pointer"
          >
            {saving ? 'Saving...' : 'Save Profile'}
          </button>
        </div>
      </form>

      <GeminiKeySettings key={user.uid}/>

      {/* Authenticated Password Change / Provider Account Password Linking */}
      <form
        onSubmit={handlePasswordUpdate}
        className="bg-white rounded-xl border border-slate-200 p-6 space-y-4"
      >
        <div>
          <h2 className="text-base font-bold text-slate-900">
            {user.hasPassword !== false
              ? 'Change Account Password'
              : 'Link Local Password to Account'}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {user.hasPassword !== false
              ? 'Updating your password automatically increments your session version and revokes any older active sessions.'
              : 'Attach a local password to your verified provider account so you can sign in with either Google or Email & Password.'}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          {user.hasPassword !== false && (
            <div>
              <label
                htmlFor="profile-current-password"
                className="block font-semibold text-slate-700 mb-1"
              >
                Current Password
              </label>
              <input
                id="profile-current-password"
                type="password"
                required
                maxLength={128}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[var(--ma-brand)]"
              />
            </div>
          )}

          <div>
            <label
              htmlFor="profile-new-password"
              className="block font-semibold text-slate-700 mb-1"
            >
              New Password (8–128 characters)
            </label>
            <input
              id="profile-new-password"
              type="password"
              required
              minLength={8}
              maxLength={128}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[var(--ma-brand)]"
            />
          </div>
        </div>

        <div className="pt-2 flex justify-end">
          <button
            type="submit"
            disabled={savingPassword}
            className="px-5 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
          >
            {savingPassword
              ? 'Updating...'
              : user.hasPassword !== false
              ? 'Update Password'
              : 'Link Password'}
          </button>
        </div>
      </form>

      {/* Entitlement & Future Premium Architecture Status */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-900">
            Academic Access Entitlement
          </h2>
          <span className="text-xs font-mono-tabular font-semibold text-emerald-700">
            Plan: {user.subscriptionTier.toUpperCase()} ({user.subscriptionStatus})
          </span>
        </div>
        <p className="text-xs text-slate-600 leading-relaxed">
          MedAtlas MCQ is currently operating in its open <strong>Free Trial Period</strong>. Every registered student has full access to all published subjects, lectures, practice sets, and mock examinations with no payment processing or locked questions.
        </p>
      </div>

      {/* Account Deletion & Privacy */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-3">
        <h2 className="text-base font-bold text-red-700">
          Privacy &amp; Permanent Account Deletion
        </h2>
        <p className="text-xs text-slate-600 leading-relaxed">
          Deleting your account permanently removes your profile, all saved exam sessions, question attempts, and bookmarks from the PostgreSQL database.
        </p>
        {!confirmDeleteOpen ? (
          <button
            type="button"
            onClick={() => setConfirmDeleteOpen(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete My Account &amp; Data
          </button>
        ) : (
          <div className="p-4 rounded-lg bg-red-50 border border-red-200 space-y-3">
            <p className="text-xs font-semibold text-red-900">
              Are you sure you want to permanently delete your account and all attempt history? This cannot be undone.
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="px-4 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md cursor-pointer"
              >
                Yes, Permanently Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmDeleteOpen(false)}
                className="px-4 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-md cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
