import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  CheckCircle2,
  Clock,
  Flag,
  XCircle,
  AlertTriangle,
  Award,
  RotateCcw,
  FileText,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  BookOpen,
  Presentation,
  LayoutGrid,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Maximize2,
  Check,
  Tag,
} from 'lucide-react';
import { api } from '../lib/api.ts';
import { OPTION_KEYS, OptionKey, parseAllQuestionTags, parseSpecialTags, sanitizeSvgDiagram } from '../lib/mcq-engine.ts';
import { PdfViewerModal, PdfSlideViewer } from './PdfViewerModal.tsx';
import { UniversityExamPlayer } from './UniversityExamPlayer.tsx';

interface McqSessionPlayerProps {
  initialSession: any;
  shortfallNotice?: string | null;
  onExit: () => void;
  onSessionCompleted: (completedSession: any) => void;
  onQuestionAnswered?: (updatedSession: any) => void;
}

export const McqSessionPlayer: React.FC<McqSessionPlayerProps> = ({
  initialSession,
  shortfallNotice,
  onExit,
  onSessionCompleted,
  onQuestionAnswered,
}) => {
  const [session, setSession] = useState<any>(initialSession);

  if (session?.mode === 'exam') {
    return (
      <UniversityExamPlayer
        session={session}
        onExit={onExit}
        onSessionCompleted={onSessionCompleted}
        onQuestionAnswered={onQuestionAnswered}
        api={api}
      />
    );
  }

  // Resume question index: continuing from next unsolved question or last active question
  const [currentIndex, setCurrentIndex] = useState<number>(() => {
    const qs = initialSession?.questions || [];
    if (!qs.length || initialSession?.status === 'completed') return 0;

    const firstUnsolvedIdx = qs.findIndex(
      (q: any) => !q.submitted && !q.selectedDisplayed
    );

    // 1. Check if user had a saved question index in localStorage for this specific session
    if (typeof window !== 'undefined' && initialSession?.id) {
      try {
        const savedIdxStr = localStorage.getItem(`medatlas_session_curr_idx_${initialSession.id}`);
        if (savedIdxStr !== null) {
          const parsed = parseInt(savedIdxStr, 10);
          if (!isNaN(parsed) && parsed >= 0 && parsed < qs.length) {
            // If the saved question was already submitted, but there are unsubmitted questions, resume at first unsolved
            if (qs[parsed]?.submitted && firstUnsolvedIdx !== -1) {
              return firstUnsolvedIdx;
            }
            return parsed;
          }
        }
      } catch {}
    }

    // 2. Otherwise find the first question that is unsolved (no answer selected/submitted)
    if (firstUnsolvedIdx !== -1) {
      return firstUnsolvedIdx;
    }

    return Math.max(0, qs.length - 1);
  });

  const [localSelections, setLocalSelections] = useState<Record<number, OptionKey | null>>(
    () => {
      const map: Record<number, OptionKey | null> = {};
      for (const q of initialSession?.questions || []) {
        map[q.id] = q.selectedDisplayed || null;
      }
      return map;
    }
  );
  const [flaggedIds, setFlaggedIds] = useState<Set<number>>(new Set());
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  const [completingSession, setCompletingSession] = useState(false);
  const [confirmSubmitModal, setConfirmSubmitModal] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(
    initialSession?.elapsedSeconds || 0
  );
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(
    initialSession?.remainingSeconds ?? null
  );

  // PDF Viewer Modal & Slide Preview State
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [sidePdfOpen, setSidePdfOpen] = useState(false);
  const [pdfTargetPage, setPdfTargetPage] = useState<number | null>(null);
  const [pdfTargetUrl, setPdfTargetUrl] = useState<string | null>(null);
  const [pdfTargetTitle, setPdfTargetTitle] = useState<string>('');
  const slidePreviewRef = useRef<HTMLDivElement>(null);

  // Explanations expansion toggle in study mode
  const [showAllRationales, setShowAllRationales] = useState(false);

  // Question Navigator State & Visited Tracking
  const navScrollTrackRef = useRef<HTMLDivElement>(null);
  const activeChipRef = useRef<HTMLButtonElement>(null);
  const [visitedQuestionIds, setVisitedQuestionIds] = useState<Set<number>>(() => {
    const initial = new Set<number>();
    const qs = initialSession?.questions || [];
    for (const q of qs) {
      if (q.submitted || q.selectedDisplayed) {
        initial.add(q.id);
      }
    }
    const currQ = qs[currentIndex] || qs[0];
    if (currQ?.id) initial.add(currQ.id);
    return initial;
  });

  // Navigator and Session autoscroll refs
  const panelAndMcqRef = useRef<HTMLDivElement>(null);
  const isInitialMount = useRef(true);

  // Auto-center active question in the continuous single-row scroll track (purely horizontal, never scrolling the window)
  useEffect(() => {
    if (activeChipRef.current && navScrollTrackRef.current) {
      const track = navScrollTrackRef.current;
      const chip = activeChipRef.current;
      const chipRect = chip.getBoundingClientRect();
      const trackRect = track.getBoundingClientRect();
      const offset = chipRect.left - trackRect.left + track.scrollLeft;
      const targetScrollLeft = offset - (track.clientWidth / 2) + (chip.offsetWidth / 2);
      track.scrollTo({
        left: Math.max(0, targetScrollLeft),
        behavior: 'smooth',
      });
    }
  }, [currentIndex]);

  // Smoothly autoscroll so both the Navigator Panel and the MCQ Card are shown when advancing/changing questions
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    const timer = setTimeout(() => {
      if (typeof window !== 'undefined' && window.scrollY > 0) {
        window.scrollTo({
          top: 0,
          behavior: 'smooth',
        });
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [currentIndex]);

  const handleScrollNav = (direction: 'left' | 'right') => {
    if (navScrollTrackRef.current) {
      const scrollAmount = direction === 'left' ? -200 : 200;
      navScrollTrackRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  const handleSelectQuestion = (index: number) => {
    setSidePdfOpen(false);
    setCurrentIndex(index);
  };

  const handlePrevQuestion = () => {
    setSidePdfOpen(false);
    setCurrentIndex((i) => Math.max(0, i - 1));
  };

  const handleNextQuestion = () => {
    setSidePdfOpen(false);
    setCurrentIndex((i) => Math.min(questions.length - 1, i + 1));
  };

  // Automatically close slide preview whenever advancing or navigating to a different question
  useEffect(() => {
    setSidePdfOpen(false);
  }, [currentIndex]);

  // Keyboard Left / Right arrow navigation between questions
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (confirmSubmitModal || pdfModalOpen) return;

      if (e.key === 'ArrowLeft') {
        if (currentIndex > 0) {
          e.preventDefault();
          handlePrevQuestion();
        }
      } else if (e.key === 'ArrowRight') {
        if (currentIndex < (session?.questions?.length || 0) - 1) {
          e.preventDefault();
          handleNextQuestion();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, session?.questions?.length, confirmSubmitModal, pdfModalOpen]);

  const autoSubmittedRef = useRef(false);

  const isCompleted = session.status === 'completed';
  const isExamMode = session.mode === 'exam';
  const questions = session.questions || [];
  const currentQ = questions[currentIndex] || null;

  // Track visited questions as student moves through session
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

  // Synchronize slide preview page when advancing to another question
  useEffect(() => {
    if (sidePdfOpen && currentQ?.lecturePdfUrl) {
      setPdfTargetUrl(currentQ.lecturePdfUrl);
      setPdfTargetPage(currentQ.pageNumber || 1);
      setPdfTargetTitle(currentQ.lectureTitle || 'Lecture Reference');
    }
  }, [currentIndex, currentQ?.lecturePdfUrl, currentQ?.pageNumber, currentQ?.lectureTitle, sidePdfOpen]);

  // Smooth autoscroll to the PowerPoint slide preview ONLY when explicitly opened on mobile/stacked view (with a 1-second delay)
  useEffect(() => {
    if (sidePdfOpen && slidePreviewRef.current) {
      // Only scroll if window is narrow and elements are stacked
      if (window.innerWidth < 1024) {
        const timer = setTimeout(() => {
          slidePreviewRef.current?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          });
        }, 1000);
        return () => clearTimeout(timer);
      }
    }
  }, [sidePdfOpen]);

  // Timer effect for active sessions
  useEffect(() => {
    if (isCompleted) return;
    const interval = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
      if (remainingSeconds !== null) {
        setRemainingSeconds((prev) => {
          if (prev === null) return null;
          if (prev <= 1) {
            return 0;
          }
          return prev - 1;
        });
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [isCompleted, remainingSeconds !== null]);

  // Auto-submit exam if timer reaches 0 in Exam Mode
  useEffect(() => {
    if (
      !isCompleted &&
      isExamMode &&
      remainingSeconds !== null &&
      remainingSeconds <= 0 &&
      !autoSubmittedRef.current
    ) {
      autoSubmittedRef.current = true;
      handleFinishSession(true);
    }
  }, [remainingSeconds, isCompleted, isExamMode]);

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  };

  /**
   * In Study Mode: Clicking an option selects and SUBMITS optimistically in 0ms,
   * revealing instant feedback and explanations without waiting for network round-trips.
   * In Exam Mode: Persists draft choice to server without revealing answers.
   */
  const mergeSessionUpdate = (
    updated: any,
    targetQId: number,
    opt?: OptionKey | null,
    isLock?: boolean
  ) => {
    if (!updated) return;
    setSession((prev: any) => {
      if (!prev) return prev;
      // If server returned the full questions array, adopt it directly
      if (Array.isArray(updated.questions) && updated.questions.length > 0) {
        return updated;
      }
      // Otherwise merge the lightweight summary efficiently without re-downloading questions
      return {
        ...prev,
        correctCount: updated.correctCount ?? prev.correctCount,
        incorrectCount: updated.incorrectCount ?? prev.incorrectCount,
        unansweredCount: updated.unansweredCount ?? prev.unansweredCount,
        scorePercentage: updated.scorePercentage ?? prev.scorePercentage,
        elapsedSeconds: updated.elapsedSeconds ?? prev.elapsedSeconds,
        status: updated.status ?? prev.status,
        questions: (prev.questions || []).map((q: any) =>
          q.id === targetQId
            ? {
                ...q,
                submitted: isLock !== undefined ? isLock : q.submitted,
                selectedDisplayed: opt !== undefined ? opt : q.selectedDisplayed,
              }
            : q
        ),
      };
    });
  };

  const handleSelectOption = async (opt: OptionKey) => {
    if (!currentQ || isCompleted) return;

    // Prevent duplicate submissions in Study Mode if already submitted
    if (!isExamMode && currentQ.submitted) return;

    setLocalSelections((prev) => {
      const next = { ...prev, [currentQ.id]: opt };
      if (session?.id) {
        try {
          localStorage.setItem(
            `medatlas_session_draft_answers_${session.id}`,
            JSON.stringify(next)
          );
        } catch {}
      }
      return next;
    });
    setErrorMsg(null);

    if (isExamMode) {
      // Exam Mode: save draft selection quietly in the background without blocking UI
      api.submitQuestionAnswer(
        session.id,
        currentQ.id,
        opt,
        false,
        elapsedSeconds
      )
        .then((res) => {
          mergeSessionUpdate(res.session, currentQ.id, opt, false);
          onQuestionAnswered?.(res.session);
        })
        .catch((err: any) => {
          setErrorMsg(err.message || 'Failed to save choice.');
        });
    } else {
      // Study Mode: OPTIMISTIC 0ms INSTANT SUBMISSION
      // 1. Immediately mark the question as submitted in local state
      // This reveals the correct/incorrect colors and explanation in 0.00 milliseconds!
      setSession((prev: any) => {
        if (!prev) return prev;
        return {
          ...prev,
          questions: (prev.questions || []).map((q: any) =>
            q.id === currentQ.id
              ? { ...q, submitted: true, selectedDisplayed: opt }
              : q
          ),
        };
      });

      // Automatically open PDF preview directly beside the MCQ if answered incorrectly!
      const correctDisplayed = currentQ.correctDisplayedOption;
      const isIncorrect = Boolean(correctDisplayed && opt !== correctDisplayed);
      if (isIncorrect && currentQ.lecturePdfUrl) {
        setPdfTargetUrl(currentQ.lecturePdfUrl);
        setPdfTargetPage(currentQ.pageNumber || 1);
        setPdfTargetTitle(currentQ.lectureTitle || 'Lecture Reference');
        setSidePdfOpen(true);
      }

      // 2. Persist the answer to the server in the background (with keepalive: true so it finishes even if user exits)
      api.submitQuestionAnswer(
        session.id,
        currentQ.id,
        opt,
        true,
        elapsedSeconds
      )
        .then((res) => {
          mergeSessionUpdate(res.session, currentQ.id, opt, true);
          onQuestionAnswered?.(res.session);
        })
        .catch((err: any) => {
          console.error('Failed to sync answer to server:', err);
          setErrorMsg('Warning: Answer was not saved to server. Check your connection.');
        });
    }
  };

  // Replay any locally cached draft answers that might not have synced if user closed browser abruptly
  useEffect(() => {
    if (!session?.id || isCompleted) return;
    try {
      const savedDraftsStr = localStorage.getItem(`medatlas_session_draft_answers_${session.id}`);
      if (!savedDraftsStr) return;
      const savedDrafts = JSON.parse(savedDraftsStr) as Record<string, OptionKey | null>;
      const qs = session.questions || [];
      for (const q of qs) {
        const draftOpt = savedDrafts[q.id];
        if (draftOpt && !q.submitted && !q.selectedDisplayed) {
          setLocalSelections((prev) => ({ ...prev, [q.id]: draftOpt }));
          api
            .submitQuestionAnswer(
              session.id,
              q.id,
              draftOpt,
              !isExamMode,
              elapsedSeconds
            )
            .then((res) => {
              mergeSessionUpdate(res.session, q.id, draftOpt, !isExamMode);
              onQuestionAnswered?.(res.session);
            })
            .catch(() => {});
        }
      }
    } catch {}
  }, [session?.id]);

  const handleToggleBookmark = async (questionId: number) => {
    try {
      const res = await api.toggleBookmark(questionId);
      setSession((prev: any) => ({
        ...prev,
        questions: prev.questions.map((q: any) =>
          q.id === questionId ? { ...q, isBookmarked: res.bookmarked } : q
        ),
      }));
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update bookmark.');
    }
  };

  const handleToggleFlag = (questionId: number) => {
    setFlaggedIds((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  };

  // Keep live refs so unmount / visibilitychange / pagehide always save the latest state
  const latestSessionIdRef = useRef<number | null>(session?.id ?? null);
  const latestCurrentIndexRef = useRef<number>(currentIndex);
  const latestElapsedRef = useRef<number>(elapsedSeconds);
  const latestIsCompletedRef = useRef<boolean>(isCompleted);

  useEffect(() => {
    latestSessionIdRef.current = session?.id ?? null;
    latestCurrentIndexRef.current = currentIndex;
    latestElapsedRef.current = elapsedSeconds;
    latestIsCompletedRef.current = isCompleted;
  }, [session?.id, currentIndex, elapsedSeconds, isCompleted]);

  // Automatically save current question index in localStorage for seamless resume
  useEffect(() => {
    if (session?.id && !isCompleted) {
      try {
        localStorage.setItem(`medatlas_session_curr_idx_${session.id}`, String(currentIndex));
      } catch {}
    }
  }, [currentIndex, session?.id, isCompleted]);

  // Guarantee progress is saved on refresh, tab close, browser restart, tab switch, or component unmount
  useEffect(() => {
    const persistProgressNow = () => {
      const sid = latestSessionIdRef.current;
      if (sid && !latestIsCompletedRef.current) {
        try {
          localStorage.setItem(
            `medatlas_session_curr_idx_${sid}`,
            String(latestCurrentIndexRef.current)
          );
        } catch {}
        api.syncSessionProgress(sid, latestElapsedRef.current).catch(() => {});
      }
    };

    const handleUnload = () => {
      const sid = latestSessionIdRef.current;
      if (sid && !latestIsCompletedRef.current) {
        try {
          localStorage.setItem(
            `medatlas_session_curr_idx_${sid}`,
            String(latestCurrentIndexRef.current)
          );
          localStorage.setItem('medatlas_active_session_id', String(sid));
        } catch {}
        api.syncSessionProgress(sid, latestElapsedRef.current).catch(() => {});
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        persistProgressNow();
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('pagehide', handleUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // Also auto-save when leaving the component by any navigation (sidebar, back button, etc.)
      persistProgressNow();
    };
  }, []);

  // Safe Exit helper: records current index & syncs elapsed time before exiting
  const handleSafeExit = () => {
    if (session?.id && !isCompleted) {
      try {
        localStorage.setItem(`medatlas_session_curr_idx_${session.id}`, String(currentIndex));
      } catch {}
      api.syncSessionProgress(session.id, elapsedSeconds).catch(() => {});
    }
    try {
      localStorage.removeItem('medatlas_active_session_id');
    } catch {}
    onExit();
  };

  const handleFinishSession = async (skipConfirm = false) => {
    if (isCompleted || completingSession) return;

    const unansweredCount = questions.filter(
      (q: any) => !localSelections[q.id] && !q.selectedDisplayed
    ).length;
    if (!skipConfirm && unansweredCount > 0 && !confirmSubmitModal) {
      setConfirmSubmitModal(true);
      return;
    }

    setConfirmSubmitModal(false);
    setCompletingSession(true);
    setErrorMsg(null);
    try {
      const res = await api.completeSession(session.id, localSelections, elapsedSeconds);
      setSession(res.session);
      try {
        localStorage.removeItem(`medatlas_session_curr_idx_${session.id}`);
        localStorage.removeItem('medatlas_active_session_id');
      } catch {}
      onSessionCompleted(res.session);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to complete session.');
    } finally {
      setCompletingSession(false);
    }
  };

  const handleOpenPdfPage = (pdfUrl?: string | null, pageNumber?: number | null, title?: string) => {
    if (!pdfUrl) return;
    setPdfTargetUrl(pdfUrl);
    setPdfTargetPage(pageNumber || 1);
    setPdfTargetTitle(title || currentQ?.lectureTitle || 'Lecture Reference');
    setPdfModalOpen(true);
  };

  if (!currentQ) {
    return (
      <div className="max-w-2xl mx-auto p-8 bg-white rounded-2xl border border-slate-200 text-center space-y-4 my-8">
        <p className="text-base font-semibold text-slate-800">
          This session contains no questions.
        </p>
        <button
          type="button"
          onClick={handleSafeExit}
          className="px-5 py-2.5 text-sm font-semibold text-white bg-[#0284C7] rounded-xl hover:bg-[#0369A1] transition-colors cursor-pointer"
        >
          Return to Workspace
        </button>
      </div>
    );
  }

  const selectedOpt = localSelections[currentQ.id] ?? currentQ.selectedDisplayed ?? null;
  const showFeedback = isCompleted || (!isExamMode && currentQ.submitted);
  const correctOpt = currentQ.correctDisplayedOption as OptionKey | undefined;
  const isSelectedCorrect = showFeedback && selectedOpt && selectedOpt === correctOpt;
  const answeredCount = questions.filter(
    (q: any) => Boolean(localSelections[q.id] || q.selectedDisplayed || q.submitted)
  ).length;

  const progressPercentage = Math.round(((currentIndex + 1) / questions.length) * 100);
  const showSlidePreview = sidePdfOpen && Boolean(pdfTargetUrl);

  return (
    <div className="w-full space-y-3 pb-8">
      {/* 1. HIGH-EFFICIENCY STICKY COMMAND BAR (Header + Navigator Unified) */}
      <div
        ref={panelAndMcqRef}
        className="sticky top-[60px] z-20 scroll-mt-20 bg-white/95 backdrop-blur-md rounded-2xl border border-slate-200 shadow-xs px-3 py-2 sm:px-4 sm:py-2.5 space-y-2 transition-all"
      >
        {/* Top Control Line */}
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          {/* Left: Exit + Context Info */}
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              type="button"
              onClick={handleSafeExit}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer shrink-0"
              title="Exit quiz (progress saved automatically)"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Exit</span>
            </button>

            <div className="flex items-center gap-1.5 min-w-0 text-xs">
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider shrink-0 ${
                  isExamMode
                    ? 'bg-sky-100 text-sky-800 border border-sky-200'
                    : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                }`}
              >
                {isExamMode ? 'Exam' : 'Study'}
              </span>
              <span
                className="font-bold text-slate-800 truncate text-xs sm:text-sm max-w-[140px] sm:max-w-xs md:max-w-md"
                title={currentQ.lectureTitle || session.title}
              >
                {currentQ.lectureTitle || session.title}
              </span>
            </div>
          </div>

          {/* Right: Tools & Timer */}
          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
            {/* Flag Button */}
            <button
              type="button"
              onClick={() => handleToggleFlag(currentQ.id)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                flaggedIds.has(currentQ.id)
                  ? 'bg-purple-100 border-purple-300 text-purple-800 font-bold'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
              title={flaggedIds.has(currentQ.id) ? 'Question is flagged' : 'Flag question'}
            >
              <Flag
                className={`w-3.5 h-3.5 ${
                  flaggedIds.has(currentQ.id) ? 'fill-purple-600 text-purple-600' : ''
                }`}
              />
              <span className="hidden md:inline">
                {flaggedIds.has(currentQ.id) ? 'Flagged' : 'Flag'}
              </span>
            </button>

            {/* Bookmark Button */}
            <button
              type="button"
              onClick={() => handleToggleBookmark(currentQ.id)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                currentQ.isBookmarked
                  ? 'bg-sky-100 border-sky-300 text-sky-800 font-bold'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
              title={currentQ.isBookmarked ? 'Bookmarked' : 'Save question'}
            >
              <Bookmark
                className={`w-3.5 h-3.5 ${
                  currentQ.isBookmarked ? 'fill-[#0284C7] text-[#0284C7]' : ''
                }`}
              />
              <span className="hidden md:inline">
                {currentQ.isBookmarked ? 'Saved' : 'Save'}
              </span>
            </button>

            {/* Slide Reference Toggle Button */}
            {currentQ.lecturePdfUrl && (
              <button
                type="button"
                onClick={() => {
                  setPdfTargetUrl(currentQ.lecturePdfUrl);
                  setPdfTargetPage(currentQ.pageNumber || 1);
                  setPdfTargetTitle(currentQ.lectureTitle || 'Lecture Reference');
                  setSidePdfOpen((prev) => !prev);
                }}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                  sidePdfOpen
                    ? 'bg-amber-100 border-amber-300 text-amber-900 font-bold'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-amber-50 hover:text-amber-800'
                }`}
                title={sidePdfOpen ? 'Hide lecture slide reference' : 'View lecture slide reference'}
              >
                <Presentation className="w-3.5 h-3.5 text-amber-600" />
                <span className="hidden sm:inline">
                  {sidePdfOpen
                    ? 'Close Slide'
                    : currentQ.pageNumber
                    ? `Slide ${currentQ.pageNumber}`
                    : 'Slide'}
                </span>
              </button>
            )}

            {/* Timer */}
            {isExamMode && remainingSeconds !== null && !isCompleted ? (
              <div
                className={`px-2.5 py-1 rounded-lg border font-mono-tabular text-xs font-bold flex items-center gap-1.5 ${
                  remainingSeconds < 60
                    ? 'bg-red-50 border-red-300 text-red-700 animate-pulse'
                    : 'bg-amber-50 border-amber-200 text-amber-900'
                }`}
              >
                <Clock className="w-3.5 h-3.5" />
                <span>{formatTime(remainingSeconds)}</span>
              </div>
            ) : (
              <div className="px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-200 text-slate-700 font-mono-tabular text-xs font-medium flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                <span>{formatTime(elapsedSeconds)}</span>
              </div>
            )}

            {/* Exam Submit or Finish Button */}
            {!isCompleted && isExamMode && (
              <button
                type="button"
                onClick={() => handleFinishSession(false)}
                disabled={completingSession}
                className="px-3 py-1 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer shrink-0"
              >
                {completingSession ? 'Grading...' : 'Submit'}
              </button>
            )}
          </div>
        </div>

        {/* Bottom Control Line: Continuous Single-Row MCQ Numbers Strip + Micro Legend */}
        <div className="pt-1.5 border-t border-slate-100 flex items-center justify-between gap-2 text-xs">
          {/* Micro Legend & Counter */}
          <div className="hidden lg:flex items-center gap-2.5 text-[11px] text-slate-500 font-medium shrink-0">
            <span className="font-bold text-slate-800">
              Q{currentIndex + 1} of {questions.length}
            </span>
            <span className="text-slate-300">·</span>
            <div className="flex items-center gap-1" title="Solved">
              <span className="w-2 h-2 rounded-full bg-emerald-600 shrink-0" />
              <span>Solved</span>
            </div>
            <div className="flex items-center gap-1" title="Incorrect">
              <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
              <span>Incorrect</span>
            </div>
            <div className="flex items-center gap-1" title="Flagged">
              <span className="w-2 h-2 rounded-full bg-purple-600 shrink-0" />
              <span>Flagged</span>
            </div>
            <div className="flex items-center gap-1" title="Opened & Unsolved">
              <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
              <span>Unsolved</span>
            </div>
          </div>

          {/* Continuous Strip with Left & Right scroll arrows */}
          <div className="flex-1 flex items-center gap-1 min-w-0">
            <button
              type="button"
              onClick={() => handleScrollNav('left')}
              className="w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-600 shrink-0 cursor-pointer shadow-2xs"
              aria-label="Scroll left"
            >
              <ChevronLeft className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
            </button>

            <div
              ref={navScrollTrackRef}
              className="flex-1 flex flex-row items-center gap-1.5 overflow-x-auto py-1.5 px-1.5 scroll-smooth"
              style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
            >
              {questions.map((q: any, i: number) => {
                const isCurrent = i === currentIndex;
                const isFlagged = flaggedIds.has(q.id);

                const hasSelected = localSelections[q.id] !== undefined && localSelections[q.id] !== null;
                const isSubmitted = Boolean(q.submitted || (isCompleted && hasSelected));
                const selectedKey = localSelections[q.id] ?? q.selectedDisplayed ?? null;
                const correctKey = q.correctDisplayedOption;

                let isCorrect: boolean | null = null;
                if (isCompleted || (!isExamMode && isSubmitted)) {
                  if (selectedKey && correctKey) {
                    isCorrect = selectedKey === correctKey;
                  }
                }

                const isVisited = visitedQuestionIds.has(q.id) || i === currentIndex;

                let colorStyle = 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200';
                let badgeLabel = 'Not opened';

                if (isFlagged) {
                  colorStyle = 'bg-purple-600 text-white border-purple-700 hover:bg-purple-700 shadow-2xs';
                  badgeLabel = 'Flagged';
                } else if (isCorrect === false) {
                  colorStyle = 'bg-red-500 text-white border-red-600 hover:bg-red-600 shadow-2xs';
                  badgeLabel = 'Incorrect';
                } else if (isCorrect === true || (isExamMode && hasSelected)) {
                  colorStyle = 'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700 shadow-2xs';
                  badgeLabel = 'Solved';
                } else if (isVisited && !hasSelected && !isSubmitted) {
                  colorStyle = 'bg-amber-400 text-amber-950 border-amber-500 hover:bg-amber-500 font-bold shadow-2xs';
                  badgeLabel = 'Opened & Left Unsolved';
                }

                const currentRing = isCurrent
                  ? 'ring-2 ring-[#0284C7] ring-offset-1 scale-105 font-black shadow-xs'
                  : 'hover:scale-105';

                return (
                  <button
                    key={q.id || i}
                    ref={isCurrent ? activeChipRef : null}
                    type="button"
                    onClick={() => handleSelectQuestion(i)}
                    className={`relative w-6 h-6 sm:w-7 sm:h-7 rounded-md border text-[11px] font-mono-tabular font-bold flex items-center justify-center shrink-0 transition-all cursor-pointer ${colorStyle} ${currentRing}`}
                    title={`Question ${i + 1}: ${badgeLabel}${isCurrent ? ' (Current)' : ''}`}
                  >
                    <span>{i + 1}</span>
                    {isFlagged && (hasSelected || isSubmitted) && (
                      <span
                        className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-white ${
                          isCorrect === false ? 'bg-red-400' : 'bg-emerald-400'
                        }`}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => handleScrollNav('right')}
              className="w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-600 shrink-0 cursor-pointer shadow-2xs"
              aria-label="Scroll right"
            >
              <ChevronRight className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
            </button>
          </div>

          {/* Quick Progress text */}
          <div className="shrink-0 text-[11px] text-slate-500 font-mono-tabular">
            <span>{answeredCount}/{questions.length} Solved</span>
          </div>
        </div>
      </div>

      {/* Shortfall Notice & Errors (if any) */}
      {shortfallNotice && (
        <div
          role="status"
          className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center gap-2.5"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-700" />
          <span>{shortfallNotice}</span>
        </div>
      )}

      {errorMsg && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 flex items-center justify-between gap-2"
        >
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-xs font-bold hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Results Summary Banner (Visible when session is finished) */}
      {isCompleted && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[#0284C7]">
                <Award className="w-4 h-4" />
                <span>Session Completed</span>
              </div>
              <h2 className="text-lg font-bold text-slate-900">
                Score: {session.scorePercentage}% ({session.correctCount} of {session.totalQuestions} Correct)
              </h2>
            </div>
            <div className="flex items-center gap-2">
              {session.lectureId && !isExamMode && (
                <button
                  type="button"
                  onClick={async () => {
                    if (window.confirm('Restart this lecture quiz fresh from Question 1?')) {
                      try {
                        await api.resetLectureProgress(session.lectureId);
                        const res = await api.startSession({
                          mode: 'study',
                          lectureIds: [session.lectureId],
                          title: session.title,
                        });
                        setSession(res.session);
                        setCurrentIndex(0);
                        setLocalSelections({});
                      } catch (err: any) {
                        setErrorMsg(err?.message || 'Could not restart quiz.');
                      }
                    }
                  }}
                  className="px-3.5 py-1.5 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 rounded-xl transition-colors cursor-pointer"
                >
                  Restart Quiz
                </button>
              )}
              <button
                type="button"
                onClick={handleSafeExit}
                className="px-4 py-1.5 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-xl transition-colors cursor-pointer"
              >
                Back to Workspace
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono-tabular text-center">
            <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200">
              <p className="text-[11px] font-sans text-slate-500">Total</p>
              <p className="text-base font-bold text-slate-900">{session.totalQuestions}</p>
            </div>
            <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200">
              <p className="text-[11px] font-sans text-emerald-800">Correct</p>
              <p className="text-base font-bold text-emerald-700">{session.correctCount}</p>
            </div>
            <div className="p-2.5 rounded-xl bg-red-50 border border-red-200">
              <p className="text-[11px] font-sans text-red-800">Incorrect</p>
              <p className="text-base font-bold text-red-700">{session.incorrectCount}</p>
            </div>
            <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200">
              <p className="text-[11px] font-sans text-slate-500">Time Taken</p>
              <p className="text-base font-bold text-slate-900">
                {formatTime(session.elapsedSeconds || elapsedSeconds)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 2. THE MAIN MCQ WORKSPACE FLANKED BY NAVIGATION ARROWS */}
      <div className="relative flex items-start gap-1 sm:gap-2.5 lg:gap-3.5">
        {/* Left Arrow Button Beside MCQ (Sticky to stay in view) */}
        <button
          type="button"
          onClick={handlePrevQuestion}
          disabled={currentIndex === 0}
          aria-label="Previous Question"
          title="Previous Question (Keyboard: ←)"
          className="sticky top-44 shrink-0 w-8 h-8 sm:w-10 sm:h-10 rounded-full border border-slate-200 bg-white hover:bg-sky-50 text-slate-700 hover:text-[#0284C7] shadow-sm hover:shadow-md disabled:opacity-20 disabled:pointer-events-none flex items-center justify-center transition-all hover:scale-105 active:scale-95 cursor-pointer z-10"
        >
          <ChevronLeft className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
        </button>

        {/* Central Workspace Container: Switches to 2-Column Split when Slide Reference is Open! */}
        <div className="flex-1 min-w-0">
          <div
            className={`w-full ${
              showSlidePreview
                ? 'grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-start'
                : 'max-w-4xl mx-auto'
            }`}
          >
            {/* COLUMN 1: Question Stem, Diagram, Options & Feedback */}
            <div
              className={`bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 space-y-4 shadow-xs ${
                showSlidePreview ? 'lg:col-span-6 xl:col-span-6' : ''
              }`}
            >
              {/* Question Subheader Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 font-mono-tabular pb-2 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-900 text-sm">
                    Question {currentIndex + 1}
                  </span>
                  <span>·</span>
                  <span className="font-sans text-slate-600 truncate max-w-[160px] sm:max-w-xs">
                    {currentQ.lectureTitle}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 font-sans">
                  {parseAllQuestionTags(currentQ.tags, currentQ.specialTags).map((tagItem) => (
                    <span
                      key={tagItem.label}
                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] border shadow-2xs ${
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
                  <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-600">
                    {currentQ.difficulty || 'Medium'}
                  </span>
                </div>
              </div>

              {/* Question Text Vignette */}
              <div className="space-y-3">
                <p className="text-[15px] sm:text-[16px] font-serif-academic text-slate-900 leading-relaxed">
                  {currentQ.questionText}
                </p>

                {/* Optional Scientific Diagram */}
                {currentQ.diagramSvg && (
                  <div
                    className="max-h-52 overflow-hidden mx-auto rounded-xl border border-slate-100 p-2 bg-slate-50/50 flex items-center justify-center"
                    dangerouslySetInnerHTML={{
                      __html: sanitizeSvgDiagram(currentQ.diagramSvg),
                    }}
                  />
                )}
              </div>

              {/* Answer Options */}
              <div className="space-y-2" role="radiogroup" aria-label="Answer Options">
                {OPTION_KEYS.map((letter) => {
                  const optionText = currentQ.options?.[letter] || '';
                  if (!optionText) return null;

                  const isSelected = selectedOpt === letter;
                  const isCorrectOption = showFeedback && correctOpt === letter;
                  const isWrongSelection = showFeedback && isSelected && correctOpt !== letter;

                  let borderStyle =
                    'border-slate-200 hover:border-slate-300 bg-white hover:bg-slate-50/50 text-slate-800';
                  let indicatorStyle = 'bg-slate-100 text-slate-700';

                  if (showFeedback) {
                    if (isCorrectOption) {
                      borderStyle = 'border-emerald-500 bg-emerald-50/80 text-emerald-950 ring-1 ring-emerald-500 font-medium';
                      indicatorStyle = 'bg-emerald-600 text-white font-bold';
                    } else if (isWrongSelection) {
                      borderStyle = 'border-red-400 bg-red-50/80 text-red-950 ring-1 ring-red-400 font-medium';
                      indicatorStyle = 'bg-red-600 text-white font-bold';
                    } else {
                      borderStyle = 'border-slate-200 bg-slate-50/40 text-slate-500 opacity-75';
                    }
                  } else if (isSelected) {
                    borderStyle = 'border-[#0284C7] bg-sky-50/70 text-slate-950 ring-2 ring-[#0284C7] font-medium';
                    indicatorStyle = 'bg-[#0284C7] text-white font-bold';
                  }

                  return (
                    <div
                      key={letter}
                      onClick={() => {
                        if (!showFeedback) {
                          handleSelectOption(letter);
                        }
                      }}
                      className={`rounded-xl border py-2.5 px-3 sm:py-3 sm:px-3.5 transition-all cursor-pointer ${borderStyle} ${
                        showFeedback ? 'cursor-default' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2.5">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <span
                            className={`w-6 h-6 rounded-md font-mono-tabular text-xs flex items-center justify-center shrink-0 ${indicatorStyle}`}
                          >
                            {letter}
                          </span>
                          <span className="text-xs sm:text-sm leading-snug">
                            {optionText}
                          </span>
                        </div>

                        {showFeedback && (
                          <div className="shrink-0">
                            {isCorrectOption && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-md">
                                <Check className="w-3 h-3 stroke-[3]" />
                                Correct
                              </span>
                            )}
                            {isWrongSelection && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-md">
                                <XCircle className="w-3 h-3" />
                                Your Pick
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Study Mode: Immediate Feedback Banner & Explanation */}
              {showFeedback && (
                <div className="space-y-3 pt-1 animate-fadeIn">
                  {/* Feedback Status Alert Banner */}
                  <div
                    className={`p-3 rounded-xl border flex items-center justify-between gap-2.5 ${
                      isSelectedCorrect
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                        : 'bg-red-50 border-red-200 text-red-900'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {isSelectedCorrect ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-600 shrink-0" />
                      )}
                      <div className="min-w-0 text-xs">
                        <p className="font-bold">
                          {isSelectedCorrect ? 'Correct Answer!' : 'Incorrect Answer'}
                        </p>
                        <p className="opacity-90 truncate">
                          The correct answer is Option{' '}
                          <strong className="underline font-mono">{correctOpt}</strong>.
                        </p>
                      </div>
                    </div>

                    {/* Toggle Slide View Button */}
                    {currentQ.lecturePdfUrl && (
                      <button
                        type="button"
                        onClick={() => {
                          setPdfTargetUrl(currentQ.lecturePdfUrl);
                          setPdfTargetPage(currentQ.pageNumber || 1);
                          setPdfTargetTitle(currentQ.lectureTitle || 'Lecture Reference');
                          setSidePdfOpen((prev) => !prev);
                        }}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors cursor-pointer shrink-0 shadow-2xs ${
                          sidePdfOpen
                            ? 'bg-amber-100 text-amber-900 border border-amber-300'
                            : 'bg-slate-900 text-white hover:bg-slate-800'
                        }`}
                      >
                        <Presentation className="w-3.5 h-3.5 text-amber-400" />
                        <span>
                          {sidePdfOpen
                            ? 'Hide Slide'
                            : currentQ.pageNumber
                            ? `Slide (p. ${currentQ.pageNumber})`
                            : 'View Slide'}
                        </span>
                      </button>
                    )}
                  </div>

                  {/* General Explanation & Clinical Pearls Card */}
                  {currentQ.explanation && (
                    <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5 text-xs">
                      <div className="flex items-center justify-between">
                        <h3 className="font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                          <span>Clinical Pearls & Explanation</span>
                        </h3>
                        {currentQ.pageNumber && (
                          <span className="font-mono-tabular text-slate-500 text-[11px]">
                            Lecture PDF Page {currentQ.pageNumber}
                          </span>
                        )}
                      </div>
                      <p className="text-slate-700 leading-relaxed font-sans text-xs sm:text-sm">
                        {currentQ.explanation}
                      </p>
                    </div>
                  )}

                  {/* Option Rationales Toggle (Clean collapsible, doesn't stretch options) */}
                  {currentQ.optionExplanations && Object.keys(currentQ.optionExplanations).length > 0 && (
                    <div className="pt-1">
                      <button
                        type="button"
                        onClick={() => setShowAllRationales((prev) => !prev)}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                      >
                        {showAllRationales ? (
                          <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                        <span>
                          {showAllRationales ? 'Hide Option Rationales' : 'View Option Rationales'}
                        </span>
                      </button>

                      {showAllRationales && (
                        <div className="mt-2 space-y-1.5 p-3 rounded-xl bg-slate-50/70 border border-slate-200 text-xs animate-fadeIn">
                          {OPTION_KEYS.map((letter) => {
                            const exp = currentQ.optionExplanations?.[letter];
                            if (!exp) return null;
                            const isCorr = letter === correctOpt;
                            const isPicked = letter === selectedOpt;
                            return (
                              <div
                                key={letter}
                                className={`p-2 rounded-lg leading-relaxed ${
                                  isCorr
                                    ? 'bg-emerald-50 border border-emerald-200 text-emerald-950'
                                    : isPicked
                                    ? 'bg-red-50 border border-red-200 text-red-950'
                                    : 'text-slate-600'
                                }`}
                              >
                                <span className="font-bold font-mono">Option {letter}: </span>
                                <span>{exp}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Question Card Bottom Action (On Final Question) */}
              {currentIndex === questions.length - 1 && (
                <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-3">
                  <span className="text-xs text-slate-400 font-mono-tabular">
                    Final Question · {answeredCount}/{questions.length} Answered
                  </span>
                  {!isCompleted ? (
                    <button
                      type="button"
                      onClick={() => handleFinishSession(false)}
                      disabled={completingSession}
                      className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-xs transition-colors cursor-pointer"
                    >
                      {completingSession ? 'Submitting...' : 'Finish Quiz'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSafeExit}
                      className="px-4 py-2 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-xl shadow-xs transition-colors cursor-pointer"
                    >
                      Finish Review
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* COLUMN 2: Lecture Slide Preview (Placed Side-by-Side on Desktop/Tablet with ZERO Scrolling!) */}
            {showSlidePreview && (
              <div
                ref={slidePreviewRef}
                className="lg:col-span-6 xl:col-span-6 sticky top-44 animate-fadeIn"
              >
                <PdfSlideViewer
                  pdfUrl={pdfTargetUrl}
                  initialPage={pdfTargetPage}
                  title={pdfTargetTitle}
                  containerHeightClass="h-[480px] sm:h-[540px] lg:h-[600px]"
                  onClose={() => setSidePdfOpen(false)}
                  onExpandToModal={() => setPdfModalOpen(true)}
                />
              </div>
            )}
          </div>
        </div>

        {/* Right Arrow Button Beside MCQ (Sticky to stay in view) */}
        <button
          type="button"
          onClick={
            currentIndex < questions.length - 1
              ? handleNextQuestion
              : !isCompleted
              ? () => handleFinishSession(false)
              : handleSafeExit
          }
          aria-label={
            currentIndex < questions.length - 1
              ? 'Next Question'
              : !isCompleted
              ? 'Finish Session'
              : 'Finish Review'
          }
          title={
            currentIndex < questions.length - 1
              ? 'Next Question (Keyboard: →)'
              : !isCompleted
              ? 'Finish Session'
              : 'Finish Review'
          }
          className="sticky top-44 shrink-0 w-8 h-8 sm:w-10 sm:h-10 rounded-full border border-slate-200 bg-white hover:bg-sky-50 text-slate-700 hover:text-[#0284C7] shadow-sm hover:shadow-md disabled:opacity-20 disabled:pointer-events-none flex items-center justify-center transition-all hover:scale-105 active:scale-95 cursor-pointer z-10"
        >
          <ChevronRight className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
        </button>
      </div>

      {/* Confirmation Dialog if Unanswered Questions Remain */}
      {confirmSubmitModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4"
        >
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-xl p-6 space-y-4">
            <div className="flex items-center gap-2.5 text-amber-700">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h3 className="text-base font-bold text-slate-900">
                Unanswered Questions Remaining
              </h3>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              You have unanswered questions in this session. Unanswered questions are scored as incorrect upon final submission. Submit now?
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmSubmitModal(false)}
                className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
              >
                Return to Questions
              </button>
              <button
                type="button"
                onClick={() => handleFinishSession(true)}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-lg cursor-pointer"
              >
                Confirm &amp; Submit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Integrated Fullscreen PDF Viewer Modal */}
      <PdfViewerModal
        isOpen={pdfModalOpen}
        onClose={() => setPdfModalOpen(false)}
        pdfUrl={pdfTargetUrl}
        initialPage={pdfTargetPage}
        title={pdfTargetTitle}
      />
    </div>
  );
};
