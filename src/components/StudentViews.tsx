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
} from 'lucide-react';
import { api, type UserProfile } from '../lib/api.ts';
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
  onSelectModule?: (subjectId: number) => void;
}> = ({
  dashboardData,
  loading,
  onStartQuickSession,
  onOpenSession,
  onNavigateTab,
  onSelectModule,
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

  const { summary, subjectProgress = [], topicPerformance = [], history = [] } =
    dashboardData;

  return (
    <div className="space-y-8">
      {/* Header & Primary Action */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Academic Performance Dashboard
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Live database statistics tracking unique questions completed, total answers submitted, and module mastery.
          </p>
        </div>
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
            onClick={() => onNavigateTab('practice')}
            className="px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Custom Practice
          </button>
          <button
            type="button"
            onClick={() =>
              onStartQuickSession({
                mode: 'study',
                title: 'Daily Mixed Medical Study Block',
                requestedCount: 5,
                shuffleQuestions: true,
                avoidRecent: true,
              })
            }
            className="px-4 py-2 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Start 5-MCQ Study Block
          </button>
        </div>
      </div>

      {/* Welcome / Empty State message when no questions have been attempted */}
      {summary.totalQuestionsAnswered === 0 && (
        <div className="p-5 bg-sky-50 border border-sky-200 rounded-xl flex items-start gap-3.5 text-xs text-sky-950">
          <AlertCircle className="w-5 h-5 text-[#0284C7] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-bold text-sm text-[#0284C7]">
              Welcome to your Medical Curriculum &amp; Question Bank!
            </p>
            <p className="text-slate-600 leading-relaxed">
              You haven't attempted any questions yet. Choose a module card below or start a quick study block to begin tracking your unique progress, accuracy, and review mistakes.
            </p>
          </div>
        </div>
      )}

      {/* Summary KPI Grid: Total, Unique, Correct, Incorrect, Accuracy, Unanswered */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3.5 font-mono-tabular">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs font-sans text-slate-500 font-medium">Total MCQs</p>
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
          <p className="text-2xl font-bold text-[#0284C7] mt-1">
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
              Curriculum Modules
            </h2>
            <p className="text-xs text-slate-500">
              Generated dynamically from your medical database. Click any module to view its lectures.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('subjects')}
            className="text-xs font-semibold text-[#0284C7] hover:text-[#0369A1] inline-flex items-center gap-1 cursor-pointer"
          >
            <span>View All Modules &amp; Lectures</span>
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
              <div
                key={subj.subjectId}
                onClick={() => {
                  if (onSelectModule) {
                    onSelectModule(subj.subjectId);
                  } else {
                    onNavigateTab('subjects');
                  }
                }}
                className="bg-white rounded-xl border border-slate-200 hover:border-[#0284C7] hover:shadow-md p-5 flex flex-col justify-between transition-all cursor-pointer group"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="text-[10px] font-mono-tabular font-bold uppercase tracking-wider text-[#0284C7] bg-sky-50 px-2 py-0.5 rounded-md">
                        Module
                      </span>
                      <h3 className="text-base font-bold text-slate-900 mt-1.5 group-hover:text-[#0284C7] transition-colors">
                        {subj.title}
                      </h3>
                    </div>
                    <div className="w-8 h-8 rounded-lg bg-slate-50 group-hover:bg-sky-50 flex items-center justify-center text-slate-400 group-hover:text-[#0284C7] transition-colors shrink-0">
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
                        className="h-full bg-[#0284C7] rounded-full transition-all duration-300"
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
              </div>
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
            onClick={() => onNavigateTab('subjects')}
            className="text-xs font-semibold text-[#0284C7] hover:text-[#0369A1] cursor-pointer"
          >
            Browse All Subjects →
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
                        className="text-[#0284C7] hover:underline font-semibold cursor-pointer"
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
                          Solve MCQs
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

      {/* Weak-Topic Analysis & Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-6 bg-white rounded-xl border border-slate-200 p-6 space-y-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              Topic Performance &amp; Weak-Area Analysis
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Topics with fewer than 3 attempts are marked as Insufficient Sample to avoid premature weak-topic labeling.
            </p>
          </div>

          {topicPerformance.length === 0 ? (
            <div className="p-6 rounded-lg bg-slate-50 text-center text-xs text-slate-500">
              Complete at least one practice or exam session to generate topic-level accuracy metrics.
            </div>
          ) : (
            <div className="space-y-3">
              {topicPerformance.slice(0, 8).map((item: any) => (
                <div
                  key={item.topic}
                  className="p-3 rounded-lg border border-slate-200 flex items-center justify-between gap-4 text-xs"
                >
                  <div className="space-y-0.5">
                    <p className="font-semibold text-slate-900">{item.topic}</p>
                    <p className="text-slate-500 font-mono-tabular">
                      {item.correctAttempts} / {item.totalAttempts} correct ({item.uniqueQuestionsAttempted} unique MCQs)
                    </p>
                  </div>
                  <div className="text-right font-mono-tabular shrink-0">
                    <p className="font-bold text-slate-900">{item.accuracyPercentage}%</p>
                    <p
                      className={`font-sans text-[11px] font-semibold ${
                        item.classification === 'Needs Review'
                          ? 'text-red-700'
                          : item.classification === 'Strong'
                          ? 'text-emerald-700'
                          : item.classification === 'Developing'
                          ? 'text-amber-700'
                          : 'text-slate-500'
                      }`}
                    >
                      {item.isSmallSample
                        ? 'Insufficient Sample (<3)'
                        : item.classification}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

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
              className="text-xs font-semibold text-[#0284C7] hover:underline cursor-pointer"
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
                      Mode: {sess.mode.toUpperCase()} · {sess.totalQuestions} MCQs ·{' '}
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
  onSelectSubjectId?: (id: number | 'all') => void;
  onStartSession: (params: any) => void;
  onRefresh?: () => void;
  isAdmin?: boolean;
}> = ({
  catalog,
  dashboardData,
  initialSelectedSubjectId,
  onSelectSubjectId,
  onStartSession,
  onRefresh,
  isAdmin = false,
}) => {
  const subjects = catalog?.subjects || [];
  const [internalSelectedId, setInternalSelectedId] = useState<number | 'all'>(
    initialSelectedSubjectId || 'all'
  );
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

  // Sync with prop if it changes
  React.useEffect(() => {
    if (initialSelectedSubjectId !== undefined && initialSelectedSubjectId !== null) {
      setInternalSelectedId(initialSelectedSubjectId);
    }
  }, [initialSelectedSubjectId]);

  const handleSelectSubject = (id: number | 'all') => {
    setInternalSelectedId(id);
    onSelectSubjectId?.(id);
  };

  const visibleSubjects =
    internalSelectedId === 'all'
      ? subjects
      : subjects.filter((s: any) => s.id === internalSelectedId);

  return (
    <div className="space-y-6">
      {/* Top Header & Subject Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            {internalSelectedId !== 'all' && (
              <button
                type="button"
                onClick={() => handleSelectSubject('all')}
                className="inline-flex items-center gap-1 text-xs font-semibold text-[#0284C7] hover:underline cursor-pointer mr-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>All Modules</span>
              </button>
            )}
            <h1 className="text-2xl font-bold text-slate-900">
              {internalSelectedId === 'all'
                ? 'Curriculum Modules &amp; Lectures'
                : visibleSubjects[0]?.title || 'Module Lectures'}
            </h1>
          </div>
          <p className="text-sm text-slate-600 mt-0.5">
            {internalSelectedId === 'all'
              ? 'Browse all medical modules, study lecture-specific question banks, review your mistakes, or open lecture PDF slides.'
              : visibleSubjects[0]?.description || 'Select a lecture to study or review mistakes.'}
          </p>
        </div>

        {/* Interactive Module Pills Filter */}
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg shrink-0">
          <button
            type="button"
            onClick={() => handleSelectSubject('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              internalSelectedId === 'all'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            All Modules ({subjects.length})
          </button>
          {subjects.map((s: any) => (
            <button
              key={s.id}
              type="button"
              onClick={() => handleSelectSubject(s.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                internalSelectedId === s.id
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {s.title}
            </button>
          ))}
        </div>
      </div>

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

      {visibleSubjects.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-600">
          No published modules found.
        </div>
      ) : (
        <div className="space-y-8">
          {visibleSubjects.map((subject: any) => {
            // Find student metrics for this module
            const subjProgress = dashboardData?.subjectProgress?.find(
              (p: any) => p.subjectId === subject.id
            );

            // Sort lectures belonging to the selected module in their correct order
            const sortedLectures = [...(subject.lectures || [])].sort(
              (a: any, b: any) => (Number(a.lectureNumber) || 0) - (Number(b.lectureNumber) || 0)
            );

            return (
              <div
                key={subject.id}
                className="bg-white rounded-xl border border-slate-200 p-6 space-y-6"
              >
                {/* Module Summary Banner */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100">
                  <div className="space-y-1">
                    <div className="text-xs text-slate-500 font-mono-tabular">
                      Module · {sortedLectures.length} Lectures ·{' '}
                      {subject.questionCount || subjProgress?.totalPublishedQuestions || 0} Questions
                      {subjProgress && subjProgress.totalAnswersSubmitted > 0 && (
                        <span> · {subjProgress.accuracyPercentage}% Accuracy</span>
                      )}
                    </div>
                    <h2 className="text-xl font-bold text-slate-900">{subject.title}</h2>
                    {subject.description && (
                      <p className="text-sm text-slate-600">{subject.description}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        onStartSession({
                          mode: 'study',
                          subjectIds: [subject.id],
                          title: `${subject.title} — Comprehensive Study`,
                        })
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-lg cursor-pointer"
                    >
                      Study Entire Module
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onStartSession({
                          mode: 'exam',
                          subjectIds: [subject.id],
                          title: `${subject.title} — Module Mock Exam`,
                          shuffleQuestions: true,
                          shuffleOptions: true,
                        })
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                    >
                      Module Exam
                    </button>
                  </div>
                </div>

                {/* Lectures List in correct order */}
                <div className="space-y-4">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Lectures in this Module ({sortedLectures.length})
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
                      const correctAnswers = lectProgress?.correctAnswers ?? 0;
                      const incorrectAnswers = lectProgress?.incorrectAnswers ?? 0;
                      const accuracy =
                        lectProgress && lectProgress.totalAnswersSubmitted > 0
                          ? `${lectProgress.accuracyPercentage}%`
                          : '—';
                      const pdfUrl = lect.pdfUrl || lectProgress?.pdfUrl || null;

                      return (
                        <div
                          key={lect.id}
                          className="p-5 rounded-xl border border-slate-200 bg-white hover:border-slate-300 transition-colors space-y-4"
                        >
                          {/* Lecture Title & Details */}
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-mono-tabular font-bold uppercase tracking-wider text-[#0284C7] bg-sky-50 px-2 py-0.5 rounded">
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

                          {/* Metric stats: question count, attempted, correct, incorrect, accuracy */}
                          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-100 font-mono-tabular text-xs">
                            <div>
                              <span className="text-[11px] font-sans text-slate-500 block">
                                Question Count
                              </span>
                              <span className="font-bold text-slate-900 text-sm">
                                {totalQuestions}
                              </span>
                            </div>
                            <div>
                              <span className="text-[11px] font-sans text-slate-500 block">
                                Attempted (Unique)
                              </span>
                              <span className="font-bold text-slate-900 text-sm">
                                {attemptedQuestions}
                              </span>
                            </div>
                            <div>
                              <span className="text-[11px] font-sans text-slate-500 block">
                                Correct Answers
                              </span>
                              <span className="font-bold text-emerald-600 text-sm">
                                {correctAnswers}
                              </span>
                            </div>
                            <div>
                              <span className="text-[11px] font-sans text-slate-500 block">
                                Incorrect Answers
                              </span>
                              <span className="font-bold text-rose-600 text-sm">
                                {incorrectAnswers}
                              </span>
                            </div>
                            <div className="col-span-2 sm:col-span-1">
                              <span className="text-[11px] font-sans text-slate-500 block">
                                Accuracy
                              </span>
                              <span
                                className={`font-bold text-sm ${
                                  attemptedQuestions > 0 ? 'text-[#0284C7]' : 'text-slate-400'
                                }`}
                              >
                                {accuracy}
                              </span>
                            </div>
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
                              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-lg transition-colors cursor-pointer"
                            >
                              <Play className="w-3.5 h-3.5" />
                              <span>Study ({totalQuestions})</span>
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
                                  <FileText className="w-3.5 h-3.5 text-[#0284C7]" />
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
                                    className="p-2 text-slate-400 hover:text-[#0284C7] hover:bg-sky-50 rounded-lg border border-slate-200 transition-colors cursor-pointer"
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
                                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0284C7] bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-lg transition-colors cursor-pointer"
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
                    // Clear local draft/index caches
                    try {
                      const keysToRemove: string[] = [];
                      for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        if (
                          key &&
                          (key.startsWith('medatlas_session_curr_idx_') ||
                            key.startsWith('medatlas_session_draft_answers_') ||
                            key === 'medatlas_active_session_id')
                        ) {
                          keysToRemove.push(key);
                        }
                      }
                      keysToRemove.forEach((k) => localStorage.removeItem(k));
                    } catch {}
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
  for (const preset of ['Old Exam', 'كتاب القسم']) {
    specialTagCountsMap.set(preset.toLowerCase(), { label: preset, count: 0 });
  }
  for (const gt of catalog?.specialTags || []) {
    if (gt?.label) {
      specialTagCountsMap.set(gt.label.toLowerCase(), { label: gt.label, count: 0 });
    }
  }
  for (const lect of activeScopeLectures) {
    const breakdown = lect.specialTagBreakdown || {};
    for (const [label, cnt] of Object.entries(breakdown)) {
      const key = label.toLowerCase();
      const existing = specialTagCountsMap.get(key);
      specialTagCountsMap.set(key, {
        label: existing?.label || label,
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
          ? `Custom Timed Exam (${questionCount} MCQs)`
          : onlyMistakes
          ? `Review Mistakes Practice (${questionCount} MCQs)`
          : `Custom Practice Session (${questionCount} MCQs)`,
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
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Custom Practice &amp; Question Filter Builder
        </h1>
        <p className="text-sm text-slate-600 mt-0.5">
          Configure a tailored question set across multiple subjects, lectures, difficulties, and shuffling rules.
        </p>
      </div>

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
                      ? 'border-[#0284C7] bg-sky-50/70 text-slate-900 font-semibold'
                      : 'border-slate-200 hover:border-slate-300 text-slate-700'
                  }`}
                >
                  <span>{s.title}</span>
                  <span className="font-mono-tabular text-slate-500">
                    {s.questionCount} MCQs
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
                      ? 'border-[#0284C7] bg-sky-50/70 text-slate-900 font-semibold'
                      : 'border-slate-200 hover:border-slate-300 text-slate-600'
                  }`}
                >
                  <span className="truncate pr-2">{l.title}</span>
                  <span className="font-mono-tabular shrink-0">
                    {l.questionCount} MCQs
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
                        ? 'border-[#0284C7] bg-[#0284C7] text-white'
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
              className="w-full px-3 py-2 text-sm font-mono-tabular rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#0284C7]"
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
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#0284C7]"
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
                className="text-[11px] font-semibold text-[#0284C7] hover:underline cursor-pointer"
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
              className="rounded border-slate-300 text-[#0284C7]"
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
              className="rounded border-slate-300 text-[#0284C7]"
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
              className="rounded border-slate-300 text-[#0284C7]"
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
              className="rounded border-slate-300 text-[#0284C7]"
            />
            <span className="font-medium text-rose-700">
              Review Mistakes Only (filter questions previously answered incorrectly)
            </span>
          </label>

          <div className="flex items-center gap-3">
            <span className="font-semibold text-slate-800">Delivery Mode:</span>
            <button
              type="button"
              onClick={() => setSessionMode('custom')}
              className={`px-2.5 py-1 rounded-md font-semibold cursor-pointer ${
                sessionMode === 'custom'
                  ? 'bg-[#0284C7] text-white'
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
            className="px-6 py-2.5 text-sm font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-lg transition-colors cursor-pointer"
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
        api
          .completeSession(activeExam.id)
          .then(() => {
            onRefresh?.();
          })
          .catch(() => {});
      }
    };
    updateTimer();
    const timer = setInterval(updateTimer, 1000);
    return () => clearInterval(timer);
  }, [activeExam?.id, activeExam?.startedAt, activeExam?.timeLimitSeconds]);

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
  for (const preset of ['Old Exam', 'كتاب القسم']) {
    mockSpecialTagsMap.set(preset.toLowerCase(), { label: preset, count: 0 });
  }
  for (const gt of catalog?.specialTags || []) {
    if (gt?.label) {
      mockSpecialTagsMap.set(gt.label.toLowerCase(), { label: gt.label, count: 0 });
    }
  }
  for (const lect of selectedLecturesObjects) {
    const breakdown = lect.specialTagBreakdown || {};
    for (const [label, cnt] of Object.entries(breakdown)) {
      const key = label.toLowerCase();
      const existing = mockSpecialTagsMap.get(key);
      mockSpecialTagsMap.set(key, {
        label: existing?.label || label,
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
    if (hasActiveRunningExam) return;
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
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Timed Mock Examination Center
        </h1>
        <p className="text-sm text-slate-600 mt-0.5">
          Authentic medical examination simulation with real university timing, question navigation grid, and comprehensive post-exam evaluation.
        </p>
      </div>

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
              className="px-5 py-2.5 font-bold text-white bg-[#08a39d] hover:bg-[#078f8a] rounded-lg cursor-pointer transition-colors shadow-xs flex items-center justify-center gap-2"
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
              <span className="w-5 h-5 rounded-full bg-[#08a39d] text-white flex items-center justify-center text-[10px]">1</span>
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
                      ? 'border-[#08a39d] bg-sky-50/60 ring-2 ring-[#08a39d]/20 shadow-xs'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <div className="space-y-1">
                    <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-[#08a39d]/15 text-[#08a39d]">
                      {m.code}
                    </span>
                    <h3 className="font-bold text-slate-900 text-sm">{m.title}</h3>
                    <p className="text-xs text-slate-500 line-clamp-2">{m.description}</p>
                  </div>
                  <div className="pt-3 mt-2 border-t border-slate-100 flex items-center justify-between text-[11px] font-mono-tabular text-slate-600">
                    <span>{m.subjects?.length || 0} Subjects</span>
                    <span>{m.questionCount || 0} MCQs</span>
                  </div>
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => setSelectedModuleId('all')}
              className={`p-4 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                selectedModuleId === 'all'
                  ? 'border-[#08a39d] bg-sky-50/60 ring-2 ring-[#08a39d]/20 shadow-xs'
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
              <span className="w-5 h-5 rounded-full bg-[#08a39d] text-white flex items-center justify-center text-[10px]">2</span>
              <span>Choose Subjects (Select Any Number of Subjects)</span>
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedSubjectIds(availableSubjects.map((s: any) => s.id))}
                className="text-[11px] font-bold text-[#08a39d] hover:underline cursor-pointer"
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
                      ? 'border-[#08a39d] bg-[#08a39d]/10 text-slate-900 font-bold shadow-2xs'
                      : 'border-slate-200 hover:border-slate-300 text-slate-700 bg-white'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className={`w-4 h-4 rounded-xs border flex items-center justify-center shrink-0 ${
                        isSelected
                          ? 'bg-[#08a39d] border-[#08a39d] text-white'
                          : 'border-slate-400 bg-white'
                      }`}
                    >
                      {isSelected && <span className="text-[10px] font-bold">✓</span>}
                    </div>
                    <span className="text-xs truncate">{s.title}</span>
                  </div>
                  <span className="text-[11px] font-mono-tabular text-slate-500 shrink-0">
                    {s.questionCount || 0} MCQs
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
              <span className="w-5 h-5 rounded-full bg-[#08a39d] text-white flex items-center justify-center text-[10px]">3</span>
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
                            ? 'bg-[#08a39d] text-white shadow-xs hover:bg-[#078f8a]'
                            : 'bg-white text-[#08a39d] border border-[#08a39d] hover:bg-sky-50'
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
                                ? 'bg-white border-[#08a39d] shadow-2xs font-semibold text-slate-900'
                                : 'bg-white/60 border-slate-200 hover:border-slate-300 text-slate-600'
                            }`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleLecture(lect.id)}
                                className="accent-[#08a39d] cursor-pointer"
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
              <span className="w-5 h-5 rounded-full bg-[#08a39d] text-white flex items-center justify-center text-[10px]">4</span>
              <span>Filter by Special Tags / Source Labels (Optional — e.g., Old Exam, كتاب القسم)</span>
            </label>
            {selectedSpecialTags.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedSpecialTags([])}
                className="text-[11px] font-bold text-[#08a39d] hover:underline cursor-pointer"
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
                  ? 'bg-[#08a39d] text-white border-[#08a39d] shadow-xs'
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
                      ? 'bg-[#08a39d] text-white border-[#08a39d]'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {num} MCQs
                </button>
              ))}
              {totalAvailableInSelection > 0 && (
                <button
                  type="button"
                  onClick={() => setQuestionCount(totalAvailableInSelection)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono-tabular transition-colors cursor-pointer border ${
                    questionCount === totalAvailableInSelection
                      ? 'bg-[#08a39d] text-white border-[#08a39d]'
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
                      ? 'bg-[#08a39d] text-white border-[#08a39d]'
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
              (totalAvailableInSelection === 0 && availableSubjects.length > 0)
            }
            className="px-8 py-3 bg-[#08a39d] hover:bg-[#078f8a] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm rounded-xl shadow-md transition-all cursor-pointer flex items-center justify-center gap-2"
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
  bookmarksData: { bookmarks: any[]; answeredQuestions: any[] } | null;
  catalog: any;
  onRefresh: () => void;
}> = ({ bookmarksData, catalog, onRefresh }) => {
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

  const handleRemoveBookmark = async (questionId: number) => {
    await api.toggleBookmark(questionId);
    onRefresh();
  };

  const activeList = subTab === 'bookmarks' ? filteredBookmarks : filteredAnswered;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Saved Bookmarks &amp; Question Review
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Review your private bookmarked questions or filter previously answered questions by Correct, Incorrect, or Unanswered status.
          </p>
        </div>

        {/* Mode Switcher */}
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setSubTab('bookmarks')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              subTab === 'bookmarks'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Bookmarked Questions ({bookmarks.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('review')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              subTab === 'review'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Previously Answered ({answered.length})
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-700">Subject Filter:</span>
          <select
            aria-label="Filter by Subject"
            value={subjectFilter}
            onChange={(e) =>
              setSubjectFilter(
                e.target.value === 'all' ? 'all' : Number(e.target.value)
              )
            }
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
                onClick={() => setStatusFilter(st)}
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
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-600">
          {subTab === 'bookmarks'
            ? 'No bookmarked questions match the selected filter. Click "Bookmark" during any Study or Exam session to save questions here.'
            : 'No previously answered questions match the selected filter.'}
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
                    <button
                      type="button"
                      onClick={() => handleRemoveBookmark(item.questionId)}
                      className="text-slate-600 hover:text-red-700 font-medium cursor-pointer"
                    >
                      {subTab === 'bookmarks' || item.isBookmarked
                        ? 'Remove Bookmark'
                        : 'Add Bookmark'}
                    </button>
                  </div>
                </div>

                <p className="text-sm sm:text-base font-serif-academic text-slate-900 leading-relaxed">
                  {item.questionText}
                </p>

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
                    className="text-xs font-semibold text-[#0284C7] hover:text-[#0369A1] cursor-pointer"
                  >
                    {isOpen
                      ? 'Hide Options & Explanation'
                      : 'View Options, Correct Answer & Explanation →'}
                  </button>
                </div>

                {isOpen && (
                  <div className="pt-4 border-t border-slate-100 space-y-3 text-xs">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {(['A', 'B', 'C', 'D'] as const).map((optKey) => {
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

                    <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                      <p className="font-bold text-slate-900">
                        Explanation (Correct Answer: {item.correctAnswer}):
                      </p>
                      <p className="text-slate-700 leading-relaxed">
                        {item.explanation}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
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
  const history = dashboardData?.history || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Lecture Progress &amp; Attempt History
        </h1>
        <p className="text-sm text-slate-600 mt-0.5">
          Each lecture maintains a single, continuous progress record so you can resume your MCQs anytime right where you left off.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {history.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-600">
            You have not started any practice or examination sessions yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <th className="py-3 px-4 font-semibold">Last Active</th>
                  <th className="py-3 px-4 font-semibold">Session &amp; Lecture</th>
                  <th className="py-3 px-4 font-semibold">Mode</th>
                  <th className="py-3 px-4 font-semibold text-right">Total MCQs</th>
                  <th className="py-3 px-4 font-semibold text-right">Status / Score</th>
                  <th className="py-3 px-4 font-semibold text-right">Time Taken</th>
                  <th className="py-3 px-4 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {history.map((sess: any) => (
                  <tr key={sess.id} className="hover:bg-slate-50/70 text-slate-700">
                    <td className="py-3 px-4 font-mono-tabular whitespace-nowrap">
                      {new Date(sess.startedAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-4">
                      <p className="font-semibold text-slate-900">{sess.title}</p>
                      <p className="text-slate-500">
                        {sess.subjectTitle} · {sess.lectureTitle}
                      </p>
                    </td>
                    <td className="py-3 px-4 uppercase font-mono-tabular">
                      {sess.mode}
                    </td>
                    <td className="py-3 px-4 text-right font-mono-tabular">
                      {sess.totalQuestions}
                    </td>
                    <td className="py-3 px-4 text-right font-mono-tabular">
                      {sess.status === 'completed' ? (
                        <span className="font-bold text-slate-900">
                          {sess.scorePercentage}% ({sess.correctCount}/{sess.totalQuestions})
                        </span>
                      ) : (
                        <span className="font-semibold text-amber-700">
                          {sess.answeredCount || 0}/{sess.totalQuestions} Solved
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono-tabular">
                      {Math.floor((sess.elapsedSeconds || 0) / 60)}m{' '}
                      {(sess.elapsedSeconds || 0) % 60}s
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => onOpenSession(sess.id)}
                        className="px-3 py-1.5 font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-lg transition-colors cursor-pointer"
                      >
                        {sess.status === 'completed'
                          ? 'Review Answers'
                          : 'Continue MCQ'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
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
      const res = await api.updateProfile(displayName);
      onUserUpdated(res.user);
      setStatusMsg('Profile display name updated successfully.');
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
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Student Profile &amp; Account Settings
        </h1>
        <p className="text-sm text-slate-600 mt-0.5">
          Manage your display name, inspect your account security metadata, and review your trial access entitlements.
        </p>
      </div>

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
          <div>
            <label
              htmlFor="profile-display-name"
              className="block font-semibold text-slate-700 mb-1"
            >
              Editable Display Name
            </label>
            <input
              id="profile-display-name"
              type="text"
              required
              minLength={2}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#0284C7]"
            />
          </div>

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
            className="px-5 py-2 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-lg cursor-pointer"
          >
            {saving ? 'Saving...' : 'Save Display Name'}
          </button>
        </div>
      </form>

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
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#0284C7]"
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
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#0284C7]"
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
