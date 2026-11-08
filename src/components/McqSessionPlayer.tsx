import {QuizTextSaveProvider,useQuizTextSaves} from '../lib/quiz-text-drafts.tsx';
import {ShortAnswerQuestion,QuizMarks} from './ShortAnswerQuestion.tsx';
import { MatchingQuestion } from './MatchingQuestion.tsx';
import { useSessionImagePrefetch } from './QuestionImages.tsx';
import { useSessionBatches } from '../lib/use-session-batches.ts';
import { mergeCompletedStudy } from '../lib/session-batches.ts';
import { QuestionBatchStatus } from './QuestionBatchStatus.tsx';
import { QuestionImageProvider, QuestionImages } from './QuestionImages.tsx';
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
import { QuestionReportButton } from './QuestionReportButton.tsx';
import { BookmarkButton } from './BookmarkButton.tsx';
import { AnswerSaveStatus } from './AnswerSaveStatus.tsx';
import { useAnswerSaving } from '../lib/use-answer-saving.ts';
import { getResumeQuestionIndex, rememberSessionQuestion } from '../lib/session-progress.ts';
import { UniversityExamPlayer } from './UniversityExamPlayer.tsx';
import {SessionPlayerApiContext, useSessionPlayerApi, type SessionPlayerApi} from '../lib/session-player-api.tsx';

interface McqSessionPlayerProps {
  initialSession: any;
  shortfallNotice?: string | null;
  onExit: () => void;
  onSessionCompleted: (completedSession: any) => void;
  onQuestionAnswered?: (updatedSession: any) => void;
  service?: SessionPlayerApi;
  onPositionChange?: (index: number) => void;
}

export const McqSessionPlayer: React.FC<McqSessionPlayerProps> = (props) => {
  return <SessionPlayerApiContext.Provider value={props.service || api}><SessionPlayerContent {...props}/></SessionPlayerApiContext.Provider>;
};
const SessionPlayerContent: React.FC<McqSessionPlayerProps> = (props) => {
  if (props.initialSession?.mode === 'exam') {
    return <QuizTextSaveProvider key={props.initialSession.id} session={props.initialSession}><QuestionImageProvider questions={props.initialSession.questions}><UniversityExamPlayer session={props.initialSession}
      onExit={props.onExit} onSessionCompleted={props.onSessionCompleted} onQuestionAnswered={props.onQuestionAnswered} api={api}/></QuestionImageProvider></QuizTextSaveProvider>;
  }
  return <QuizTextSaveProvider key={props.initialSession.id} session={props.initialSession}><QuestionImageProvider questions={props.initialSession.questions}><StudySessionPlayer {...props}/></QuestionImageProvider></QuizTextSaveProvider>;
};

const StudySessionPlayer: React.FC<McqSessionPlayerProps> = ({
  initialSession, shortfallNotice, onExit, onSessionCompleted, onQuestionAnswered, onPositionChange,
}) => {
  const service = useSessionPlayerApi();
  const [session, setSession] = useState<any>(initialSession);
  const textSaves=useQuizTextSaves();
  useSessionImagePrefetch(session.questions);
  const saves = useAnswerSaving(session, (result, answer) => {
    mergeSessionUpdate(result.session, answer.questionId, answer.selectedOption, answer.lockAnswer);
    onQuestionAnswered?.(result.session);
  });

  const [navigatorOpen,setNavigatorOpen]=useState(true);
  const navigatorOpenRef=useRef(navigatorOpen);navigatorOpenRef.current=navigatorOpen;
  const [currentIndex, setCurrentIndex] = useState(() => getResumeQuestionIndex(initialSession));
  useEffect(()=>{
    let lastY=window.scrollY,direction=0,travel=0,settleUntil=0;
    const followScroll=()=>{
      const nextY=Math.max(0,window.scrollY),delta=nextY-lastY;
      lastY=nextY;
      // Header resizing and browser scroll anchoring are not a new gesture.
      if(performance.now()<settleUntil||delta===0)return;
      const nextDirection=Math.sign(delta);
      if(nextDirection!==direction){direction=nextDirection;travel=0;}
      travel+=Math.abs(delta);
      const shouldOpen=nextY<24||(direction<0&&travel>=64);
      const shouldClose=nextY>100&&direction>0&&travel>=32;
      if((shouldOpen&&!navigatorOpenRef.current)||(shouldClose&&navigatorOpenRef.current)){
        navigatorOpenRef.current=shouldOpen;setNavigatorOpen(shouldOpen);
        settleUntil=performance.now()+350;travel=0;direction=0;
      }
    };
    window.addEventListener('scroll',followScroll,{passive:true});
    return()=>window.removeEventListener('scroll',followScroll);
  },[]);
  const batches = useSessionBatches(session, setSession, currentIndex, service);

  const [localSelections, setLocalSelections] = useState<Record<number, OptionKey | null>>(
    () => {
      const map: Record<number, OptionKey | null> = {};
      for (const q of initialSession?.questions || []) {
        if (q.selectedDisplayed) map[q.id] = q.selectedDisplayed;
      }
      return { ...map, ...saves.drafts };
    }
  );
  const [matchingChoices,setMatchingChoices]=useState<Record<number,string>>(()=>({...Object.fromEntries((initialSession.questions||[]).filter((q:any)=>q.matchingChoiceId).map((q:any)=>[q.id,q.matchingChoiceId])),...saves.matchingDrafts}));
  const applyShortAnswer=(id:number,result:any)=>{const pick=result.attempt.status==='graded'?(result.attempt.result.score===result.attempt.maxScore?'A':'B'):'C';setLocalSelections(previous=>({...previous,[id]:pick}));setSession((previous:any)=>({...previous,...result.session,questions:previous.questions.map((q:any)=>q.id===id?{...q,shortAnswerAttempt:result.attempt,shortAnswerStatus:result.attempt.status,shortAnswerScore:result.attempt.result?.score,maxMarks:result.attempt.maxScore||q.maxMarks,hasSavedAnswer:true,selectedDisplayed:pick,submitted:true,...(previous.privateQuiz?{answerCorrect:result.attempt.status==='graded'?pick==='A':null}:{})}:q)}));onQuestionAnswered?.(result.session);};
  const handleShortAnswer=(question:any,result:any)=>applyShortAnswer(question.id,result);
  useEffect(()=>textSaves.subscribeSaved?.(applyShortAnswer),[textSaves,onQuestionAnswered]);
  const handleMatchingChoice=(question:any,choice:string)=>{
    if (session.status==='completed'||(session.mode!=='exam'&&question.submitted))return;
    const selected=session.mode==='exam'?'A':choice===question.matching.correctChoiceId?'A':'B';
    setMatchingChoices(previous=>({...previous,[question.id]:choice}));
    setLocalSelections(previous=>({...previous,[question.id]:selected}));
    setSession((previous:any)=>({...previous,questions:previous.questions.map((q:any)=>q.id===question.id?{...q,matchingChoiceId:choice,selectedDisplayed:selected,submitted:session.mode!=='exam'}:q)}));
    setCurrentIndex(question.index);saves.saveMatch(question.id,choice,elapsedSeconds);
  };
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
  }, [currentIndex,navigatorOpen]);

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
    void navigateToQuestion(index);
  };

  const navigationPending = useRef(false);
  const playerMounted = useRef(true);
  useEffect(()=>{playerMounted.current=true;return()=>{playerMounted.current=false;};},[]);
  const navigateToQuestion = async (index: number) => {
    if (navigationPending.current) return;
    navigationPending.current = true;
    try {
      if (session.privateQuiz) { await saves.flush(); await textSaves.flush(); }
      if (!playerMounted.current) return;
      setSidePdfOpen(false);
      setCurrentIndex(index);
    } catch (error: any) { if(playerMounted.current)setErrorMsg(error.message || 'Could not save your answer. Please retry.'); }
    finally { navigationPending.current = false; }
  };

  const handlePrevQuestion = () => {
    void navigateToQuestion(Math.max(0, currentIndex - 1));
  };

  const handleNextQuestion = () => {
    void navigateToQuestion(Math.min(questions.length - 1, currentIndex + 1));
  };

  useEffect(() => { onPositionChange?.(currentIndex); }, [currentIndex, onPositionChange]);

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
      if (confirmSubmitModal || pdfModalOpen || target?.closest('[role="dialog"][aria-modal="true"]')) return;

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
        quizScore:updated.quizScore??prev.quizScore,
        elapsedSeconds: updated.elapsedSeconds ?? prev.elapsedSeconds,
        status: updated.status ?? prev.status,
        questions: (prev.questions || []).map((q: any) =>
          q.id === targetQId
            ? {
                ...q,
                submitted: isLock !== undefined ? isLock : q.submitted,
                selectedDisplayed: updated.selectedDisplayed ?? (opt !== undefined ? opt : q.selectedDisplayed),
                matchingChoiceId: updated.matchingChoiceId ?? q.matchingChoiceId,
                ...(updated.questionUpdate?.id === q.id ? updated.questionUpdate : {}),
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
      return next;
    });
    setErrorMsg(null);

    if (isExamMode) {
      saves.save(currentQ.id, opt, elapsedSeconds);
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
              ? { ...q, submitted: !session.privateQuiz || Boolean(q.correctDisplayedOption), selectedDisplayed: opt,
                  ...(session.privateQuiz&&q.correctDisplayedOption?{answerCorrect:opt===q.correctDisplayedOption}:{}) }
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

      saves.save(currentQ.id, opt, elapsedSeconds);
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

  useEffect(() => {
    if (session?.id && currentQ?.id) rememberSessionQuestion(session.id, currentQ.id, currentIndex);
  }, [currentIndex, session?.id, currentQ?.id]);

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
        service.syncSessionProgress(sid, latestElapsedRef.current).catch(() => {});
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
          if (!initialSession.privateQuiz) localStorage.setItem('medatlas_active_session_id', String(sid));
        } catch {}
        service.syncSessionProgress(sid, latestElapsedRef.current).catch(() => {});
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
  const handleSafeExit = async () => {
    if (session.privateQuiz && !isCompleted) {
      try { await saves.flush(); await textSaves.flush(); }
      catch (error: any) { setErrorMsg(error.message || 'Could not save your answer. Please retry.'); return; }
    }
    if (session?.id && !isCompleted) {
      try {
        localStorage.setItem(`medatlas_session_curr_idx_${session.id}`, String(currentIndex));
      } catch {}
      service.syncSessionProgress(session.id, elapsedSeconds).catch(() => {});
    }
    try {
      if (!session.privateQuiz) localStorage.removeItem('medatlas_active_session_id');
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
      await saves.flush();
      await textSaves.flush();
      const res = await service.completeSession(session.id, localSelections, elapsedSeconds);
      saves.finish();
      setSession((previous: any) => mergeCompletedStudy(previous, res.session));
      try {
        if (!session.privateQuiz) localStorage.removeItem('medatlas_active_session_id');
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

  if (currentQ?.contentLoaded === false) {
    return <div className="ma-dashboard-panel my-6 space-y-4">
      <h2 className="font-semibold">Question {currentIndex + 1} of {questions.length}</h2>
      <QuestionBatchStatus error={batches.error} retry={batches.retry}/>
      <button type="button" className="mr-4 font-semibold underline" onClick={() => setCurrentIndex(Math.max(0, questions.findIndex((q: any) => q.contentLoaded !== false)))}>Back to loaded questions</button>
      <button type="button" className="font-semibold underline" onClick={handleSafeExit}>Return to Workspace</button>
    </div>;
  }

  if (!currentQ) {
    return (
      <div className="max-w-2xl mx-auto p-8 bg-white rounded-2xl border border-slate-200 text-center space-y-4 my-8">
        <p className="text-base font-semibold text-slate-800">
          This session contains no questions.
        </p>
        <button
          type="button"
          onClick={handleSafeExit}
          className="px-5 py-2.5 text-sm font-semibold text-white bg-[var(--ma-brand)] rounded-xl hover:bg-[var(--ma-brand-hover)] transition-colors cursor-pointer"
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
    (q: any) => Boolean(localSelections[q.id] || q.selectedDisplayed)
  ).length;

  const progressPercentage = Math.round(((currentIndex + 1) / questions.length) * 100);
  const showSlidePreview = sidePdfOpen && Boolean(pdfTargetUrl);

  return (
    <div className="ma-study-player w-full space-y-3 pb-8" style={{overflowAnchor:'none'}}>
      {batches.error && <QuestionBatchStatus error={batches.error} retry={batches.retry}/>}
      {/* 1. HIGH-EFFICIENCY STICKY COMMAND BAR (Header + Navigator Unified) */}
      <div
        ref={panelAndMcqRef}
        className="ma-study-command sticky z-20 scroll-mt-24 bg-white/95 backdrop-blur-md rounded-2xl border border-slate-200 shadow-xs px-3 py-2 sm:px-4 sm:py-2.5 space-y-2 transition-all"
      >
        {/* Top Control Line */}
        <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">
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

          <button type="button" aria-expanded={navigatorOpen} aria-controls="study-question-navigator" onClick={()=>setNavigatorOpen(open=>!open)} className="ml-auto px-3 py-2 text-xs font-semibold border border-slate-200 rounded-lg whitespace-nowrap">{navigatorOpen?'Hide questions':`Questions (${currentIndex+1}/${questions.length})`}</button>
          {/* Right: Tools & Timer */}
          <div style={{display:navigatorOpen?undefined:'none'}} className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
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

            {!session.privateQuiz && <BookmarkButton key={currentQ.id} questionId={currentQ.id} saved={Boolean(currentQ.isBookmarked)}
              onSaved={(saved) => setSession((prev: any) => ({...prev, questions: prev.questions.map((q: any) => q.id === currentQ.id ? {...q, isBookmarked:saved} : q)}))}/>}

            {!session.privateQuiz && <QuestionReportButton key={`report-${currentQ.id}`} questionId={currentQ.id}/>}

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
        <div id="study-question-navigator" style={{display:navigatorOpen?undefined:'none'}} className="pt-1.5 border-t border-slate-100 flex items-center justify-between gap-2 text-xs">
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
                  if (session.privateQuiz && q.answerCorrect != null) {
                    isCorrect = q.answerCorrect;
                  } else if (selectedKey && correctKey) {
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
                  ? 'ring-2 ring-[var(--ma-brand)] ring-offset-1 scale-105 font-black shadow-xs'
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

      <QuizMarks score={session.quizScore}/><AnswerSaveStatus status={saves.status} unsavedCount={saves.unsavedCount} retry={saves.retry}/>
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
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ma-brand)]">
                <Award className="w-4 h-4" />
                <span>Session Completed</span>
              </div>
              <h2 className="text-lg font-bold text-slate-900">
                {session.quizScore?.pendingGradingCount?'Provisional score':'Score'}: {session.scorePercentage}%
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
                className="px-4 py-1.5 text-xs font-semibold text-white bg-[var(--ma-brand)] hover:bg-[var(--ma-brand-hover)] rounded-xl transition-colors cursor-pointer"
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

      {/* Main question workspace; navigation stays anchored to the viewport. */}
      <div className="relative">
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
              className={`ma-question-card bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 space-y-4 shadow-xs ${
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

              {currentQ.questionType==='short_answer'?<ShortAnswerQuestion key={currentQ.id} question={currentQ} sessionId={session.id} exam={isExamMode} completed={isCompleted} disabled={completingSession} onSaved={result=>handleShortAnswer(currentQ,result)}/>:currentQ.matching ? <MatchingQuestion question={currentQ} questions={questions} choices={matchingChoices} completed={isCompleted} exam={isExamMode} onSelect={handleMatchingChoice}
                onBookmark={(id,saved)=>setSession((previous:any)=>({...previous,questions:previous.questions.map((q:any)=>q.id===id?{...q,isBookmarked:saved}:q)}))}/> : <>
              {/* Question Text Vignette */}
              <div className="space-y-3">
                <QuestionImages images={currentQ.images}/>
                <p className="ma-question-stem font-serif-academic text-slate-900">
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
                {(session.privateQuiz ? Object.keys(currentQ.options || {}) as OptionKey[] : OPTION_KEYS).map((letter) => {
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
                    borderStyle = 'border-[var(--ma-brand)] bg-sky-50/70 text-slate-950 ring-2 ring-[var(--ma-brand)] font-medium';
                    indicatorStyle = 'bg-[var(--ma-brand)] text-white font-bold';
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

              </>}
              {/* Study Mode: Immediate Feedback Banner & Explanation */}
              {showFeedback && !currentQ.matching && currentQ.questionType!=='short_answer' && (
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
                      <QuestionImages images={currentQ.explanationImages}/>
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
                      className="px-4 py-2 text-xs font-semibold text-white bg-[var(--ma-brand)] hover:bg-[var(--ma-brand-hover)] rounded-xl shadow-xs transition-colors cursor-pointer"
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

      </div>

      {!confirmSubmitModal && !pdfModalOpen && <nav className="ma-question-navigation" aria-label="Question navigation">
        <button
          type="button"
          onClick={handlePrevQuestion}
          disabled={currentIndex === 0 || completingSession}
          aria-label="Previous Question"
          title="Previous Question (Keyboard: ←)"
          className="ma-question-navigation-previous"
        >
          <ChevronLeft className="w-4 h-4 shrink-0" /><span>Previous</span>
        </button>
        <span className="ma-question-navigation-count">{currentIndex + 1} / {questions.length}</span>
        <button
          type="button"
          disabled={completingSession}
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
          className="ma-question-navigation-next"
        >
          <span>{currentIndex < questions.length - 1 ? 'Next' : !isCompleted ? 'Finish' : 'Close review'}</span><ChevronRight className="w-4 h-4 shrink-0" />
        </button>
      </nav>}

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
                className="px-4 py-2 text-xs font-semibold text-white bg-[var(--ma-brand)] hover:bg-[var(--ma-brand-hover)] rounded-lg cursor-pointer"
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
