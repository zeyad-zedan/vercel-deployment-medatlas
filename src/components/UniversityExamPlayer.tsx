import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Presentation,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Clock,
  ArrowRight,
  ExternalLink,
  ShieldCheck,
  Tag,
} from 'lucide-react';
import { parseSpecialTags } from '../lib/mcq-engine.ts';
import { PdfViewerModal } from './PdfViewerModal.tsx';

interface UniversityExamPlayerProps {
  session: any;
  onExit: () => void;
  onSessionCompleted: (session: any) => void;
  onQuestionAnswered?: (sessionId: number, questionId: number, answer: string) => void;
  api: any;
}

export const UniversityExamPlayer: React.FC<UniversityExamPlayerProps> = ({
  session: initialSession,
  onExit,
  onSessionCompleted,
  onQuestionAnswered,
  api,
}) => {
  const [session, setSession] = useState<any>(initialSession);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [localSelections, setLocalSelections] = useState<Record<number, string>>({});
  const [markedForReview, setMarkedForReview] = useState<Set<number>>(new Set());
  const [visitedQuestionIds, setVisitedQuestionIds] = useState<Set<number>>(new Set([0]));
  const [fontSizeLevel, setFontSizeLevel] = useState<number>(1); // 0: 13px, 1: 15px, 2: 18px, 3: 21px
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [endScreenOpen, setEndScreenOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [resultsFilter, setResultsFilter] = useState<'all' | 'correct' | 'wrong' | 'notanswered'>('all');
  const [reviewingQuestion, setReviewingQuestion] = useState<any | null>(null);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [pdfTargetUrl, setPdfTargetUrl] = useState<string | null>(null);
  const [pdfTargetPage, setPdfTargetPage] = useState<number | null>(null);
  const [pdfTargetTitle, setPdfTargetTitle] = useState<string>('');

  const isCompleted = session.status === 'completed';
  const questions = session.questions || [];
  const totalQuestions = questions.length;
  const currentQ = questions[currentIndex] || null;

  // Initialize selections from session state
  const localSelectionsRef = useRef<Record<number, string>>({});
  useEffect(() => {
    const initial: Record<number, string> = {};
    for (const q of questions) {
      if (q.selectedDisplayed) {
        initial[q.id] = q.selectedDisplayed;
      }
    }
    setLocalSelections(initial);
    localSelectionsRef.current = initial;
  }, [session.id]);

  // Track visited questions
  useEffect(() => {
    if (currentQ?.id) {
      setVisitedQuestionIds((prev) => {
        if (prev.has(currentQ.id)) return prev;
        const next = new Set(prev);
        next.add(currentQ.id);
        return next;
      });
    }
  }, [currentIndex, currentQ?.id]);

  // Authoritative Real-Clock Server-Synced Timer
  const initialRemainingSecs =
    typeof session.remainingSeconds === 'number'
      ? Math.max(0, session.remainingSeconds)
      : session.timeLimitSeconds !== null
      ? Math.max(0, session.timeLimitSeconds - (session.elapsedSeconds || 0))
      : 60 * 60;

  const deadlineMsRef = useRef<number>(Date.now() + initialRemainingSecs * 1000);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(initialRemainingSecs);

  useEffect(() => {
    const rem =
      typeof session.remainingSeconds === 'number'
        ? Math.max(0, session.remainingSeconds)
        : session.timeLimitSeconds !== null
        ? Math.max(0, session.timeLimitSeconds - (session.elapsedSeconds || 0))
        : 60 * 60;
    deadlineMsRef.current = Date.now() + rem * 1000;
    setRemainingSeconds(rem);
  }, [session.id]);

  useEffect(() => {
    if (isCompleted) return;
    const tick = () => {
      const rem = Math.max(0, Math.ceil((deadlineMsRef.current - Date.now()) / 1000));
      setRemainingSeconds(rem);
      if (rem <= 0) {
        handleFinishExam(true);
      }
    };
    const interval = setInterval(tick, 1000);
    window.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener('visibilitychange', tick);
    };
  }, [isCompleted, session.id]);

  // Calculate counts
  const answeredCount = Object.keys(localSelections).length;
  const reviewCount = markedForReview.size;
  const visitedCount = visitedQuestionIds.size;
  const notAnsweredCount = Math.max(0, visitedCount - answeredCount);
  const notVisitedCount = Math.max(0, totalQuestions - visitedCount);
  const unansweredCount = Math.max(0, totalQuestions - answeredCount);

  // Toggle selection
  const handleSelectOption = (key: string) => {
    if (isCompleted || !currentQ) return;
    setLocalSelections((prev) => {
      const next = {
        ...prev,
        [currentQ.id]: key,
      };
      localSelectionsRef.current = next;
      return next;
    });

    // Persist answer to server immediately (unlocked so student can change before submitting)
    if (api.submitQuestionAnswer) {
      api
        .submitQuestionAnswer(session.id, currentQ.id, key, false)
        .catch((err: any) => {
          console.warn('Failed to autosave answer:', err);
        });
    }

    onQuestionAnswered?.(session.id, currentQ.id, key);
  };

  // Toggle review flag
  const toggleMarkForReview = (questionId: number) => {
    setMarkedForReview((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  };

  // Save & Next
  const handleSaveNext = () => {
    if (currentIndex < totalQuestions - 1) {
      setCurrentIndex((prev) => prev + 1);
    } else {
      setConfirmModalOpen(true);
    }
  };

  // Finish exam
  const completingRef = useRef(false);
  const handleFinishExam = async (_skipConfirm = false) => {
    if (isCompleted || completing || completingRef.current) return;
    completingRef.current = true;
    setConfirmModalOpen(false);
    setCompleting(true);

    try {
      const rem = Math.max(0, Math.ceil((deadlineMsRef.current - Date.now()) / 1000));
      const elapsed =
        session.timeLimitSeconds !== null
          ? Math.max(0, session.timeLimitSeconds - rem)
          : 60;
      const res = await api.completeSession(session.id, localSelectionsRef.current, elapsed);
      setSession(res.session);
      onSessionCompleted(res.session);
      setEndScreenOpen(true);
    } catch (err: any) {
      console.error('Failed to complete exam:', err);
      completingRef.current = false;
    } finally {
      setCompleting(false);
    }
  };

  // Formatted Timer Display
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const fontSizes = ['13px', '15px', '18px', '21px'];
  const optionFontSizes = ['12px', '14px', '16px', '19px'];
  const currentFontSize = fontSizes[fontSizeLevel] || '15px';
  const currentOptionFontSize = optionFontSizes[fontSizeLevel] || '14px';

  // --------------------------------------------------------------------------
  // Results Review Screen
  // --------------------------------------------------------------------------
  if (isCompleted && !endScreenOpen) {
    const correctCount = session.correctCount || 0;
    const incorrectCount = session.incorrectCount || 0;
    const unansweredCount = session.unansweredCount || 0;
    const scorePct = session.scorePercentage || 0;
    const isPassed = scorePct >= 60;

    const filteredQuestions = questions.filter((q: any) => {
      const userPick = localSelections[q.id] || q.selectedDisplayed;
      const isCorrect = userPick && userPick === q.correctDisplayedOption;
      if (resultsFilter === 'correct') return isCorrect;
      if (resultsFilter === 'wrong') return userPick && !isCorrect;
      if (resultsFilter === 'notanswered') return !userPick;
      return true;
    });

    return (
      <div className="min-h-screen bg-[#f4f8fb] text-[#222] p-4 sm:p-6 lg:p-8 font-sans">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="text-center space-y-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-[#15616d]">
              Examination Performance &amp; Evaluation
            </h1>
            <p className="text-xs sm:text-sm text-slate-600 font-mono-tabular">
              {session.title} · Time Expended: {Math.floor((session.elapsedSeconds || 0) / 60)}m {(session.elapsedSeconds || 0) % 60}s
            </p>
          </div>

          {/* Results Summary Box */}
          <div className="bg-white border border-[#dde6ee] rounded-xl p-6 shadow-sm flex flex-col md:flex-row items-center justify-around gap-6">
            {/* Circular Percentage */}
            <div className="flex flex-col items-center">
              <div
                className="w-32 h-32 rounded-full flex items-center justify-center p-3 shadow-inner"
                style={{
                  background: `conic-gradient(${isPassed ? '#20a95b' : '#d9534f'} ${scorePct * 3.6}deg, #e7edf2 0deg)`,
                }}
              >
                <div className="w-full h-full bg-white rounded-full flex flex-col items-center justify-center shadow-xs">
                  <span className="text-2xl font-bold text-slate-900">{scorePct}%</span>
                  <span
                    className="text-[11px] font-bold uppercase tracking-wider"
                    style={{ color: isPassed ? '#20a95b' : '#d9534f' }}
                  >
                    {isPassed ? 'Passed' : 'Failed'}
                  </span>
                </div>
              </div>
            </div>

            {/* Fraction Box */}
            <div className="text-center space-y-2">
              <div className="text-xs font-bold text-[#456] uppercase tracking-wider">
                Overall Exam Score
              </div>
              <div className="inline-flex items-center justify-center bg-[#eaf7ef] border border-[#cdeedb] rounded-xl px-8 py-3">
                <div className="flex flex-col items-center">
                  <span className="text-3xl font-extrabold text-[#1f8c4d]">{correctCount}</span>
                  <div className="w-12 h-0.5 bg-[#1f8c4d] my-1 rounded" />
                  <span className="text-3xl font-extrabold text-[#1f8c4d]">{totalQuestions}</span>
                </div>
              </div>
              <p className="text-xs text-slate-500 font-mono-tabular">
                Passing standard threshold: 60%
              </p>
            </div>
          </div>

          {/* 4 Stats Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white border border-[#dde6ee] rounded-lg p-3 text-center">
              <div className="text-xl font-bold text-[#20a95b]">{correctCount}</div>
              <div className="text-[11px] text-slate-500 uppercase mt-0.5 font-semibold">Correct</div>
            </div>
            <div className="bg-white border border-[#dde6ee] rounded-lg p-3 text-center">
              <div className="text-xl font-bold text-[#d9534f]">{incorrectCount}</div>
              <div className="text-[11px] text-slate-500 uppercase mt-0.5 font-semibold">Wrong</div>
            </div>
            <div className="bg-white border border-[#dde6ee] rounded-lg p-3 text-center">
              <div className="text-xl font-bold text-[#b08b1e]">{unansweredCount}</div>
              <div className="text-[11px] text-slate-500 uppercase mt-0.5 font-semibold">Unanswered</div>
            </div>
            <div className="bg-white border border-[#dde6ee] rounded-lg p-3 text-center">
              <div className="text-xl font-bold text-[#1769aa] font-mono-tabular">
                {Math.floor((session.elapsedSeconds || 0) / 60)}m
              </div>
              <div className="text-[11px] text-slate-500 uppercase mt-0.5 font-semibold">Time Spent</div>
            </div>
          </div>

          {/* University Grading Scale Legend */}
          <div className="bg-white border border-[#dde6ee] rounded-lg p-3 max-w-md mx-auto text-center">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
              Egyptian University Grading Scale
            </div>
            <div className="grid grid-cols-5 gap-1 text-[11px]">
              <div className="flex flex-col items-center">
                <span className="w-2.5 h-2.5 rounded-full bg-[#20a95b]" />
                <span className="font-bold text-slate-700 mt-1">Excellent</span>
                <span className="text-[9px] text-slate-400">&ge;90%</span>
              </div>
              <div className="flex flex-col items-center">
                <span className="w-2.5 h-2.5 rounded-full bg-[#1769aa]" />
                <span className="font-bold text-slate-700 mt-1">V. Good</span>
                <span className="text-[9px] text-slate-400">80-89%</span>
              </div>
              <div className="flex flex-col items-center">
                <span className="w-2.5 h-2.5 rounded-full bg-[#b08b1e]" />
                <span className="font-bold text-slate-700 mt-1">Good</span>
                <span className="text-[9px] text-slate-400">65-79%</span>
              </div>
              <div className="flex flex-col items-center">
                <span className="w-2.5 h-2.5 rounded-full bg-[#e67e22]" />
                <span className="font-bold text-slate-700 mt-1">Pass</span>
                <span className="text-[9px] text-slate-400">60-64%</span>
              </div>
              <div className="flex flex-col items-center">
                <span className="w-2.5 h-2.5 rounded-full bg-[#d9534f]" />
                <span className="font-bold text-slate-700 mt-1">Fail</span>
                <span className="text-[9px] text-slate-400">&lt;60%</span>
              </div>
            </div>
          </div>

          {/* Filter Tabs */}
          <div className="flex items-center justify-center gap-2 flex-wrap pt-2">
            {[
              { id: 'all', label: `All (${totalQuestions})` },
              { id: 'correct', label: `Correct (${correctCount})` },
              { id: 'wrong', label: `Wrong (${incorrectCount})` },
              { id: 'notanswered', label: `Unanswered (${unansweredCount})` },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setResultsFilter(tab.id as any)}
                className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors cursor-pointer border ${
                  resultsFilter === tab.id
                    ? 'bg-[#159f98] text-white border-[#159f98]'
                    : 'bg-white text-slate-700 border-[#cfdbe4] hover:bg-slate-50'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Detailed Question Review Table */}
          <div className="bg-white border border-[#dde6ee] rounded-xl overflow-hidden shadow-xs">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[#eef5f8] text-[#345] uppercase text-[10px] tracking-wider border-b border-slate-200">
                  <th className="py-3 px-4 font-bold text-center w-12">#</th>
                  <th className="py-3 px-4 font-bold text-center w-16">Status</th>
                  <th className="py-3 px-4 font-bold">Question Text</th>
                  <th className="py-3 px-4 font-bold">Your Pick</th>
                  <th className="py-3 px-4 font-bold">Correct</th>
                  <th className="py-3 px-4 font-bold text-right w-24">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredQuestions.map((q: any) => {
                  const originalIdx = questions.findIndex((x: any) => x.id === q.id);
                  const userPick = localSelections[q.id] || q.selectedDisplayed;
                  const isCorrect = userPick && userPick === q.correctDisplayedOption;
                  const isUnanswered = !userPick;

                  return (
                    <tr
                      key={q.id}
                      className={`hover:bg-slate-50 transition-colors ${
                        isUnanswered
                          ? 'bg-[#fff8e3]/40'
                          : isCorrect
                          ? 'bg-[#f3fbf6]/50'
                          : 'bg-[#fdf2f2]/50'
                      }`}
                    >
                      <td className="py-3 px-4 text-center font-bold text-slate-500 font-mono-tabular">
                        {originalIdx + 1}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span
                          className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-white font-bold text-xs ${
                            isUnanswered
                              ? 'bg-[#b08b1e]'
                              : isCorrect
                              ? 'bg-[#20a95b]'
                              : 'bg-[#d9534f]'
                          }`}
                        >
                          {isUnanswered ? '—' : isCorrect ? '✓' : '✗'}
                        </span>
                      </td>
                      <td className="py-3 px-4 max-w-xs font-semibold text-slate-800">
                        <div className="line-clamp-2">{q.questionText}</div>
                        {parseSpecialTags(q.specialTags).length > 0 && (
                          <div className="flex flex-wrap items-center gap-1 mt-1">
                            {parseSpecialTags(q.specialTags).map((specTag) => (
                              <span
                                key={specTag}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300"
                              >
                                <Tag className="w-2.5 h-2.5 text-amber-600 shrink-0" />
                                {specTag}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono-tabular font-bold text-slate-700">
                        {userPick ? (
                          <span className={isCorrect ? 'text-[#20a95b]' : 'text-[#d9534f]'}>
                            {userPick}
                          </span>
                        ) : (
                          <span className="text-slate-400 italic">None</span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono-tabular font-bold text-[#20a95b]">
                        {q.correctDisplayedOption}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => setReviewingQuestion(q)}
                          className="px-3 py-1 bg-[#eef5f8] hover:bg-[#dcf0ee] text-[#159f98] font-bold text-xs rounded transition-colors cursor-pointer"
                        >
                          Review
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-center gap-4 pt-4">
            <button
              type="button"
              onClick={onExit}
              className="px-6 py-2.5 bg-[#2d9c96] hover:bg-[#258d87] text-white font-bold text-sm rounded-lg shadow-sm transition-colors cursor-pointer"
            >
              Return to Dashboard
            </button>
          </div>
        </div>

        {/* Detailed Question Review Modal */}
        {reviewingQuestion && (
          <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-auto p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-bold text-[#15616d] text-base">
                    Question Breakdown &amp; Analysis
                  </h3>
                  {parseSpecialTags(reviewingQuestion.specialTags).map((specTag) => (
                    <span
                      key={specTag}
                      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300"
                    >
                      <Tag className="w-3 h-3 text-amber-600 shrink-0" />
                      {specTag}
                    </span>
                  ))}
                </div>
                <span className="text-xs font-mono-tabular text-slate-500">
                  {reviewingQuestion.lectureTitle} · Slide {reviewingQuestion.pageNumber || 1}
                </span>
              </div>

              <div className="font-semibold text-slate-900 text-sm leading-relaxed">
                {reviewingQuestion.questionText}
              </div>

              <div className="space-y-2">
                {(['A', 'B', 'C', 'D'] as const).map((key) => {
                  const isCorrect = key === reviewingQuestion.correctDisplayedOption;
                  const isUserPick =
                    (localSelections[reviewingQuestion.id] || reviewingQuestion.selectedDisplayed) === key;

                  return (
                    <div
                      key={key}
                      className={`p-3 rounded-lg border text-xs flex items-center justify-between gap-3 ${
                        isCorrect
                          ? 'bg-[#eefbf2] border-[#20a95b]'
                          : isUserPick
                          ? 'bg-[#fdecec] border-[#d9534f]'
                          : 'bg-white border-slate-200'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-bold font-mono-tabular">{key}.</span>
                        <span className="text-slate-800">{reviewingQuestion.options[key]}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {isCorrect && (
                          <span className="px-2 py-0.5 bg-[#20a95b] text-white font-bold text-[10px] rounded-full uppercase">
                            Correct Answer
                          </span>
                        )}
                        {isUserPick && !isCorrect && (
                          <span className="px-2 py-0.5 bg-[#d9534f] text-white font-bold text-[10px] rounded-full uppercase">
                            Your Choice
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Explanation */}
              {reviewingQuestion.explanation && (
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1.5">
                  <div className="font-bold text-slate-800 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                    <span>Clinical Pearls &amp; Rationales</span>
                  </div>
                  <p className="text-slate-700 leading-relaxed font-sans">
                    {reviewingQuestion.explanation}
                  </p>
                </div>
              )}

              {/* Slide reference viewer button */}
              {reviewingQuestion.lecturePdfUrl && (
                <button
                  type="button"
                  onClick={() => {
                    setPdfTargetUrl(reviewingQuestion.lecturePdfUrl);
                    setPdfTargetPage(reviewingQuestion.pageNumber || 1);
                    setPdfTargetTitle(reviewingQuestion.lectureTitle || 'Lecture Slide');
                    setPdfModalOpen(true);
                  }}
                  className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-lg flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  <Presentation className="w-4 h-4 text-amber-400" />
                  <span>
                    Open Lecture Slide Reference (Slide {reviewingQuestion.pageNumber || 1})
                  </span>
                </button>
              )}

              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setReviewingQuestion(null)}
                  className="px-5 py-2 bg-slate-700 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        <PdfViewerModal
          isOpen={pdfModalOpen}
          onClose={() => setPdfModalOpen(false)}
          pdfUrl={pdfTargetUrl}
          initialPage={pdfTargetPage}
          title={pdfTargetTitle}
        />
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // End Screen Prompt (Just completed)
  // --------------------------------------------------------------------------
  if (endScreenOpen) {
    return (
      <div className="fixed inset-0 bg-white z-50 flex items-center justify-center font-sans p-6">
        <div className="max-w-md w-full text-center space-y-8">
          <div className="w-16 h-16 rounded-full bg-[#159f98]/10 text-[#159f98] flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-10 h-10" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 leading-snug">
            The exam has been successfully completed.
          </h1>
          <button
            type="button"
            onClick={() => setEndScreenOpen(false)}
            className="px-8 py-3.5 bg-[#159f98] hover:bg-[#128c85] text-white font-bold text-base rounded shadow-md transition-all cursor-pointer"
          >
            Show Results
          </button>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // Active University Exam Simulation Shell
  // --------------------------------------------------------------------------
  const selectedKey = currentQ ? localSelections[currentQ.id] : null;
  const isWarningTime = remainingSeconds !== null && remainingSeconds <= 300; // <= 5 minutes

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-2 sm:p-4 font-sans select-none">
      <div className="w-full max-w-[1200px] h-[calc(100vh-24px)] max-h-[920px] bg-white border border-[#aaa] shadow-lg flex flex-col overflow-hidden">
        {/* Topbar: Teal #08a39d */}
        <div className="h-[34px] shrink-0 bg-[#08a39d] text-white flex items-center justify-between px-3.5 text-xs font-semibold gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={onExit}
              className="shrink-0 bg-white/15 hover:bg-white/25 px-2 py-0.5 rounded text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors"
              title="Leave exam screen (Timer continues running)"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Workspace</span>
            </button>
            <span className="truncate">{session.title}</span>
          </div>
          <span className="shrink-0 bg-white/20 px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider">
            Exam Live
          </span>
        </div>

        {/* Content Layout: Main (left) + Sidebar (right) */}
        <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">
          {/* Main Area */}
          <section className="flex-1 min-w-0 border-r border-[#aaa] flex flex-col min-h-0">
            {/* Status strip */}
            <div className="h-7 shrink-0 bg-[#e8eef7] border-b border-[#b8c6d8] px-3 py-1.5 text-[11px] text-[#444] font-medium flex items-center justify-between">
              <div>
                Total questions in exam: <b>{totalQuestions}</b> | Answered:{' '}
                <b className="text-[#20a95b]">{answeredCount}</b>
              </div>
              <div className="text-[10px] text-slate-500 font-mono-tabular">
                Question {currentIndex + 1} of {totalQuestions}
              </div>
            </div>

            {/* Question Card */}
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-4 sm:p-5 relative">
              {/* Question Title & Font Size Controls */}
              <div className="shrink-0 font-bold text-xs sm:text-sm -mx-4 -mt-1 mb-3 px-4 pb-2 border-b border-[#d7d7d7] flex flex-wrap items-center justify-between gap-2 min-h-[32px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-900">
                    Question No. <span className="font-mono-tabular">{currentIndex + 1}</span>
                  </span>
                  {parseSpecialTags(currentQ.specialTags).map((specTag) => (
                    <span
                      key={specTag}
                      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300 shadow-2xs"
                      title={`Special Source Label: ${specTag}`}
                    >
                      <Tag className="w-3 h-3 text-amber-600 shrink-0" />
                      {specTag}
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-1 font-mono text-xs">
                  <button
                    type="button"
                    onClick={() => setFontSizeLevel((prev) => Math.max(0, prev - 1))}
                    className="w-7 h-6 flex items-center justify-center bg-[#159aa5] text-white hover:brightness-95 border border-[#159aa5] rounded-xs cursor-pointer font-sans"
                    title="Decrease font size"
                  >
                    A<sup className="text-[9px]">-</sup>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFontSizeLevel(1)}
                    className="w-7 h-6 flex items-center justify-center bg-[#159aa5] text-white hover:brightness-95 border border-[#159aa5] rounded-xs cursor-pointer font-sans"
                    title="Reset font size"
                  >
                    A
                  </button>
                  <button
                    type="button"
                    onClick={() => setFontSizeLevel((prev) => Math.min(3, prev + 1))}
                    className="w-7 h-6 flex items-center justify-center bg-[#159aa5] text-white hover:brightness-95 border border-[#159aa5] rounded-xs cursor-pointer font-sans"
                    title="Increase font size"
                  >
                    A<sup className="text-[9px]">+</sup>
                  </button>
                </div>
              </div>

              {/* Scrollable Question Text & Options */}
              <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                {currentQ ? (
                  <div className="space-y-4">
                    <div
                      className="font-semibold text-slate-900 leading-relaxed"
                      style={{ fontSize: currentFontSize }}
                    >
                      {currentQ.questionText}
                    </div>

                    <div className="space-y-3 pt-2">
                      {(['A', 'B', 'C', 'D'] as const).map((key) => {
                        const optText = currentQ.options[key];
                        if (!optText) return null;
                        const isSelected = selectedKey === key;

                        return (
                          <label
                            key={key}
                            onClick={() => handleSelectOption(key)}
                            className={`flex items-start gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
                              isSelected
                                ? 'bg-sky-50/80 border-[#08a39d] text-slate-900 font-semibold shadow-xs'
                                : 'bg-white border-slate-200 hover:border-slate-300 text-slate-800'
                            }`}
                            style={{ fontSize: currentOptionFontSize }}
                          >
                            <input
                              type="radio"
                              name={`exam_q_${currentQ.id}`}
                              checked={isSelected}
                              onChange={() => handleSelectOption(key)}
                              className="mt-1 accent-[#08a39d] cursor-pointer"
                            />
                            <span className="font-bold text-slate-700 font-mono-tabular shrink-0">
                              {key}.
                            </span>
                            <span className="flex-1 leading-relaxed">{optText}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Watermark: Subtle diagonal rotated Exam Simulation */}
              <div className="absolute inset-x-4 inset-y-16 pointer-events-none opacity-[0.035] flex items-center justify-center text-5xl font-extrabold uppercase text-slate-900 select-none -rotate-12">
                Exam Simulation
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="h-12 shrink-0 border-t border-[#aaa] flex items-center justify-between px-3 bg-white">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
                  disabled={currentIndex === 0}
                  className="px-3.5 py-1.5 bg-[#777] hover:brightness-95 disabled:opacity-40 text-white text-xs rounded-xs font-semibold cursor-pointer"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={handleSaveNext}
                  className="px-4 py-1.5 bg-[#2d9c96] hover:brightness-95 text-white text-xs rounded-xs font-semibold cursor-pointer shadow-xs"
                >
                  {currentIndex === totalQuestions - 1 ? 'Save & Review' : 'Save & Next'}
                </button>
              </div>

              {/* Mark for Review Toggle */}
              {currentQ && (
                <label
                  className="inline-flex items-center gap-2 px-2.5 py-1 bg-[#159aa5] text-white text-xs font-medium rounded-xs cursor-pointer select-none hover:brightness-95"
                  title="Mark or unmark this question for review"
                >
                  <input
                    type="checkbox"
                    checked={markedForReview.has(currentQ.id)}
                    onChange={() => toggleMarkForReview(currentQ.id)}
                    className="hidden"
                  />
                  <span
                    className={`w-3 h-3 rounded-xs border border-white flex items-center justify-center ${
                      markedForReview.has(currentQ.id) ? 'bg-[#7855b8]' : 'bg-white'
                    }`}
                  >
                    {markedForReview.has(currentQ.id) && (
                      <span className="w-1.5 h-1.5 bg-white rounded-xs" />
                    )}
                  </span>
                  <span>Mark for Review</span>
                </label>
              )}
            </div>
          </section>

          {/* Right Sidebar */}
          <aside className="w-full lg:w-[230px] shrink-0 bg-[#e9f0fb] p-3 text-[11px] flex flex-col justify-between overflow-y-auto min-h-0 border-t lg:border-t-0 border-[#aaa]">
            <div>
              {/* Timer Header */}
              <div className="font-bold text-right text-slate-800 text-xs">
                Time Remaining
              </div>
              <div
                className={`text-right text-2xl font-bold font-mono-tabular mt-1 mb-3 ${
                  isWarningTime ? 'text-[#d9534f] animate-pulse' : 'text-[#1769aa]'
                }`}
              >
                {remainingSeconds !== null ? formatTime(remainingSeconds) : '60:00'}
              </div>

              {/* Total & Answered Info Box */}
              <div className="bg-[#dce8f8] border border-[#bdcde1] p-2.5 rounded mb-3 space-y-1 text-slate-800">
                <div>
                  Number of questions: <b className="font-mono-tabular">{totalQuestions}</b>
                </div>
                <div>
                  Answered:{' '}
                  <b className="font-mono-tabular text-[#20a95b]">{answeredCount}</b>
                </div>
              </div>

              {/* 4 Legend States */}
              <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 mb-3 text-[10px] text-slate-600">
                <div className="flex items-center gap-1.5">
                  <span className="w-7 h-6 bg-[#20a95b] text-white font-bold flex items-center justify-center rounded-xs shrink-0 font-mono-tabular">
                    {answeredCount}
                  </span>
                  <span>Answered</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-7 h-6 bg-[#e24a3b] text-white font-bold flex items-center justify-center rounded-xs shrink-0 font-mono-tabular">
                    {notAnsweredCount}
                  </span>
                  <span>Not Answered</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-7 h-6 bg-[#7855b8] text-white font-bold flex items-center justify-center rounded-xs shrink-0 font-mono-tabular">
                    {reviewCount}
                  </span>
                  <span>For Review</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-7 h-6 bg-white border border-[#aaa] text-slate-700 font-bold flex items-center justify-center rounded-xs shrink-0 font-mono-tabular">
                    {notVisitedCount}
                  </span>
                  <span>Not Visited</span>
                </div>
              </div>

              {/* 7-Column Question Grid */}
              <div className="grid grid-cols-7 gap-1.5 pt-1">
                {questions.map((q: any, idx: number) => {
                  const isCurrent = idx === currentIndex;
                  const isSelected = Boolean(localSelections[q.id]);
                  const isReview = markedForReview.has(q.id);
                  const isVisited = visitedQuestionIds.has(q.id);

                  let bgClass = 'bg-white text-slate-800 border-[#aaa]';
                  if (isReview) {
                    bgClass = 'bg-[#7855b8] text-white border-[#7855b8]';
                  } else if (isSelected) {
                    bgClass = 'bg-[#20a95b] text-white border-[#20a95b]';
                  } else if (isVisited) {
                    bgClass = 'bg-[#e24a3b] text-white border-[#e24a3b]';
                  }

                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => setCurrentIndex(idx)}
                      className={`aspect-square border rounded-xs font-bold text-[10px] flex items-center justify-center transition-all cursor-pointer font-mono-tabular ${bgClass} ${
                        isCurrent
                          ? 'ring-2 ring-[#08a39d] ring-offset-1 scale-105 z-10 font-extrabold'
                          : 'hover:opacity-90'
                      }`}
                    >
                      {idx + 1}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* End Test Button */}
            <div className="pt-4 mt-auto">
              <button
                type="button"
                onClick={() => setConfirmModalOpen(true)}
                className="w-full py-2 bg-[#d9534f] hover:bg-[#c0472f] text-white font-bold text-xs rounded-xs shadow-sm transition-colors cursor-pointer"
              >
                End Test
              </button>
            </div>
          </aside>
        </div>
      </div>

      {/* Confirmation Modal */}
      {confirmModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-[#ccc] rounded-md shadow-2xl max-w-sm w-full p-6 text-center space-y-4">
            <h2 className="text-base font-bold text-slate-900">
              Are you sure you want to end the exam?
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              If you choose to end the exam, you will not be able to modify any answers.
              {unansweredCount > 0 && (
                <span className="block mt-2 font-bold text-amber-700">
                  Notice: You have {unansweredCount} unanswered questions remaining.
                </span>
              )}
            </p>
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmModalOpen(false)}
                className="px-4 py-2 bg-[#777] hover:bg-[#666] text-white font-bold text-xs rounded-xs cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={completing}
                onClick={() => handleFinishExam(true)}
                className="px-5 py-2 bg-[#d9534f] hover:bg-[#c0472f] text-white font-bold text-xs rounded-xs cursor-pointer"
              >
                {completing ? 'Submitting...' : 'End Test'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
