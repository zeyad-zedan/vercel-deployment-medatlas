import React, { useState } from 'react';
import {
  Download,
  Eye,
  FileSpreadsheet,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  CheckCircle2,
  AlertTriangle,
  X,
  FileText,
  ExternalLink,
  RotateCcw,
  ArrowRight,
  Tag,
} from 'lucide-react';
import { api } from '../lib/api.ts';
import { getSampleCsvTemplate, parseAllQuestionTags, parseSpecialTags } from '../lib/mcq-engine.ts';
import { PdfViewerModal } from './PdfViewerModal.tsx';
import { UploadPdfModal } from './UploadPdfModal.tsx';

interface AdminConsoleProps {
  adminData: any;
  loading: boolean;
  onRefresh: () => void;
}

type AdminSection =
  | 'overview'
  | 'users'
  | 'modules'
  | 'lectures'
  | 'questions'
  | 'import';

export const AdminConsole: React.FC<AdminConsoleProps> = ({
  adminData,
  loading,
  onRefresh,
}) => {
  const [section, setSection] = useState<AdminSection>('overview');
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Module form state
  const [editingModule, setEditingModule] = useState<any | null>(null);
  const [modCode, setModCode] = useState('');
  const [modTitle, setModTitle] = useState('');
  const [modDesc, setModDesc] = useState('');
  const [modOrder, setModOrder] = useState(1);
  const [modStatus, setModStatus] = useState<'published' | 'draft' | 'archived'>('published');
  const [confirmDeleteModuleId, setConfirmDeleteModuleId] = useState<number | null>(null);

  // Subject form state
  const [editingSubject, setEditingSubject] = useState<any | null>(null);
  const [subjModuleId, setSubjModuleId] = useState<number | ''>('');
  const [subjTitle, setSubjTitle] = useState('');
  const [subjDesc, setSubjDesc] = useState('');
  const [subjOrder, setSubjOrder] = useState(1);
  const [subjStatus, setSubjStatus] = useState<'published' | 'draft' | 'archived'>(
    'published'
  );

  // Lecture form state
  const [editingLecture, setEditingLecture] = useState<any | null>(null);
  const [lectSubjectId, setLectSubjectId] = useState<number>(0);
  const [lectTitle, setLectTitle] = useState('');
  const [lectDesc, setLectDesc] = useState('');
  const [lectNumber, setLectNumber] = useState(1);
  const [lectNotes, setLectNotes] = useState('');
  const [lectPdfUrl, setLectPdfUrl] = useState('');
  const [lectStatus, setLectStatus] = useState<'published' | 'draft' | 'archived'>(
    'published'
  );
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [uploadedPdfSuccess, setUploadedPdfSuccess] = useState<string | null>(null);
  const [previewPdfModal, setPreviewPdfModal] = useState<{ url: string; title: string } | null>(null);
  const [showUploadPdfModal, setShowUploadPdfModal] = useState(false);
  const [uploadPdfTargetLecture, setUploadPdfTargetLecture] = useState<{
    id: number;
    title: string;
    subjectTitle?: string;
    lectureNumber?: number;
    pdfUrl?: string | null;
  } | null>(null);

  // Question form & filter state
  const [qSearch, setQSearch] = useState('');
  const [qSubjectFilter, setQSubjectFilter] = useState<number | 'all'>('all');
  const [qStatusFilter, setQStatusFilter] = useState<string>('all');
  const [editingQuestion, setEditingQuestion] = useState<any | null>(null);
  const [previewQuestion, setPreviewQuestion] = useState<any | null>(null);
  const [confirmDeleteQuestionId, setConfirmDeleteQuestionId] = useState<
    number | null
  >(null);
  const [confirmDeleteSubjectId, setConfirmDeleteSubjectId] = useState<
    number | null
  >(null);
  const [confirmDeleteLectureId, setConfirmDeleteLectureId] = useState<
    number | null
  >(null);
  const [confirmDeleteBankId, setConfirmDeleteBankId] = useState<
    number | null
  >(null);
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<
    number | null
  >(null);
  const [confirmDeleteUserUid, setConfirmDeleteUserUid] = useState<
    string | null
  >(null);
  const [resetUserModal, setResetUserModal] = useState<{
    uid: string;
    email: string;
    name: string;
  } | null>(null);
  const [selectedLectureForReset, setSelectedLectureForReset] = useState<number | null>(null);
  const [isResettingUserLecture, setIsResettingUserLecture] = useState(false);

  const [qSubjectId, setQSubjectId] = useState<number>(0);
  const [qLectureId, setQLectureId] = useState<number>(0);
  const [qText, setQText] = useState('');
  const [qOptA, setQOptA] = useState('');
  const [qOptB, setQOptB] = useState('');
  const [qOptC, setQOptC] = useState('');
  const [qOptD, setQOptD] = useState('');
  const [qCorrect, setQCorrect] = useState<'A' | 'B' | 'C' | 'D'>('B');
  const [qExplanation, setQExplanation] = useState('');
  const [qExpA, setQExpA] = useState('');
  const [qExpB, setQExpB] = useState('');
  const [qExpC, setQExpC] = useState('');
  const [qExpD, setQExpD] = useState('');
  const [qPageNumber, setQPageNumber] = useState('');
  const [qDifficulty, setQDifficulty] = useState<'Easy' | 'Medium' | 'Hard'>(
    'Medium'
  );
  const [qTags, setQTags] = useState('');
  const [qSpecialTags, setQSpecialTags] = useState('');
  const [qStatus, setQStatus] = useState<'published' | 'draft' | 'archived'>(
    'published'
  );

  // CSV Bulk Import state
  const [csvFileName, setCsvFileName] = useState('sample_medical_import.csv');
  const [csvContent, setCsvContent] = useState('');
  const [csvPreviewReport, setCsvPreviewReport] = useState<any | null>(null);
  const [csvImportResult, setCsvImportResult] = useState<any | null>(null);
  const [validatingCsv, setValidatingCsv] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);
  const [importTargetLectureId, setImportTargetLectureId] = useState<number | 'auto'>('auto');

  if (loading || !adminData) {
    return (
      <div className="p-8 bg-white rounded-xl border border-slate-200 animate-pulse space-y-4">
        <div className="h-6 w-64 bg-slate-200 rounded" />
        <div className="h-32 bg-slate-100 rounded" />
      </div>
    );
  }

  const {
    metrics,
    users = [],
    modules: modulesList = [],
    subjects = [],
    lectures = [],
    questionBanks = [],
    questions = [],
    recentActivity = [],
    recentImports = [],
    auditLogs = [],
  } = adminData;

  const clearAlerts = () => {
    setFeedbackMsg(null);
    setErrorMsg(null);
  };

  // Module Handlers
  const startEditModule = (mod?: any) => {
    clearAlerts();
    if (mod) {
      setEditingModule(mod);
      setModCode(mod.code || '');
      setModTitle(mod.title || '');
      setModDesc(mod.description || '');
      setModOrder(mod.displayOrder || 1);
      setModStatus(mod.status || 'published');
    } else {
      setEditingModule({ id: undefined });
      setModCode('');
      setModTitle('');
      setModDesc('');
      setModOrder(modulesList.length + 1);
      setModStatus('published');
    }
  };

  const handleSaveModule = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAlerts();
    try {
      await api.saveModule({
        id: editingModule?.id,
        code: modCode.trim(),
        title: modTitle.trim(),
        description: modDesc.trim(),
        displayOrder: modOrder,
        status: modStatus,
      });
      setEditingModule(null);
      setFeedbackMsg(`Module "${modCode}: ${modTitle}" saved successfully.`);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save module.');
    }
  };

  const handleDeleteModule = async (id: number) => {
    clearAlerts();
    try {
      await api.deleteModule(id);
      setConfirmDeleteModuleId(null);
      setFeedbackMsg('Module deleted successfully.');
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to delete module.');
    }
  };

  // User Role & Individual User Deletion Handlers
  const handleToggleUserRole = async (
    targetUid: string,
    newRole: 'student' | 'admin'
  ) => {
    clearAlerts();
    try {
      const res = await api.updateUserRole(targetUid, newRole);
      setFeedbackMsg(res.message);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update user role.');
    }
  };

  const handleDeleteUser = async (targetUid: string) => {
    clearAlerts();
    try {
      const res = await api.deleteUserAdmin(targetUid);
      setConfirmDeleteUserUid(null);
      setFeedbackMsg(res.message);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to delete user.');
    }
  };

  // Subject Handlers
  const startEditSubject = (subj?: any, defaultModuleId?: number) => {
    clearAlerts();
    if (subj) {
      setEditingSubject(subj);
      setSubjModuleId(subj.moduleId || '');
      setSubjTitle(subj.title);
      setSubjDesc(subj.description);
      setSubjOrder(subj.displayOrder);
      setSubjStatus(subj.status);
    } else {
      setEditingSubject({ id: undefined });
      setSubjModuleId(defaultModuleId !== undefined ? defaultModuleId : modulesList[0]?.id || '');
      setSubjTitle('');
      setSubjDesc('');
      setSubjOrder(subjects.length + 1);
      setSubjStatus('published');
    }
  };

  const handleSaveSubject = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAlerts();
    try {
      await api.saveSubject({
        id: editingSubject?.id,
        moduleId: subjModuleId ? Number(subjModuleId) : null,
        title: subjTitle,
        description: subjDesc,
        displayOrder: subjOrder,
        status: subjStatus,
      });
      setEditingSubject(null);
      setFeedbackMsg('Subject saved successfully.');
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save subject.');
    }
  };

  // Lecture Handlers
  const startEditLecture = (lect?: any) => {
    clearAlerts();
    setUploadedPdfSuccess(null);
    const defaultSubjId = subjects[0]?.id || 0;
    if (lect) {
      setEditingLecture(lect);
      setLectSubjectId(lect.subjectId);
      setLectTitle(lect.title);
      setLectDesc(lect.description);
      setLectNumber(lect.lectureNumber);
      setLectNotes(lect.educationalNotes || '');
      setLectPdfUrl(lect.pdfUrl || '');
      setLectStatus(lect.status);
    } else {
      setEditingLecture({ id: undefined });
      setLectSubjectId(defaultSubjId);
      setLectTitle('');
      setLectDesc('');
      setLectNumber(lectures.length + 1);
      setLectNotes('');
      setLectPdfUrl('');
      setLectStatus('published');
    }
  };

  const handlePdfFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setErrorMsg('Invalid file format. Please select a valid .pdf file.');
      return;
    }

    clearAlerts();
    setUploadingPdf(true);
    setUploadedPdfSuccess(null);
    try {
      const res = await api.uploadPdf(file);
      setLectPdfUrl(res.url);
      setUploadedPdfSuccess(
        `✓ Uploaded "${file.name}" (${(res.fileSize / 1024).toFixed(0)} KB) and saved to database (${res.url})`
      );
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to upload lecture PDF.');
    } finally {
      setUploadingPdf(false);
      e.target.value = '';
    }
  };

  const handleSaveLecture = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAlerts();
    try {
      await api.saveLecture({
        id: editingLecture?.id,
        subjectId: lectSubjectId,
        title: lectTitle,
        description: lectDesc,
        lectureNumber: lectNumber,
        educationalNotes: lectNotes,
        pdfUrl: lectPdfUrl.trim() || null,
        status: lectStatus,
      });
      setEditingLecture(null);
      setFeedbackMsg('Lecture saved successfully.');
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save lecture.');
    }
  };

  // Question Handlers
  const startEditQuestion = (q?: any) => {
    clearAlerts();
    const defaultSubj = subjects[0]?.id || 0;
    const defaultLect =
      lectures.find((l: any) => l.subjectId === defaultSubj)?.id ||
      lectures[0]?.id ||
      0;

    if (q) {
      setEditingQuestion(q);
      setQSubjectId(q.subjectId);
      setQLectureId(q.lectureId);
      setQText(q.questionText);
      setQOptA(q.optionA);
      setQOptB(q.optionB);
      setQOptC(q.optionC);
      setQOptD(q.optionD);
      setQCorrect(q.correctAnswer);
      setQExplanation(q.explanation);
      setQExpA(q.explanationA || '');
      setQExpB(q.explanationB || '');
      setQExpC(q.explanationC || '');
      setQExpD(q.explanationD || '');
      setQPageNumber(
        q.pageNumber !== undefined && q.pageNumber !== null ? String(q.pageNumber) : ''
      );
      setQDifficulty(q.difficulty);
      setQTags(q.tags || '');
      setQSpecialTags(q.specialTags || '');
      setQStatus(q.status);
    } else {
      setEditingQuestion({ id: undefined });
      setQSubjectId(defaultSubj);
      setQLectureId(defaultLect);
      setQText('');
      setQOptA('');
      setQOptB('');
      setQOptC('');
      setQOptD('');
      setQCorrect('B');
      setQExplanation('');
      setQExpA('');
      setQExpB('');
      setQExpC('');
      setQExpD('');
      setQPageNumber('');
      setQDifficulty('Medium');
      setQTags('');
      setQSpecialTags('');
      setQStatus('published');
    }
  };

  const handleSaveQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAlerts();

    let cleanPageNumber: number | null = null;
    if (qPageNumber && qPageNumber.trim() !== '') {
      const p = Number(qPageNumber);
      if (!Number.isInteger(p) || p <= 0) {
        setErrorMsg('PDF Page Number must be a positive integer (e.g. 1, 2, 3...).');
        return;
      }
      cleanPageNumber = p;
    }

    try {
      await api.saveQuestion({
        id: editingQuestion?.id,
        subjectId: qSubjectId,
        lectureId: qLectureId,
        questionText: qText,
        optionA: qOptA,
        optionB: qOptB,
        optionC: qOptC,
        optionD: qOptD,
        correctAnswer: qCorrect,
        explanation: qExplanation,
        explanationA: qExpA,
        explanationB: qExpB,
        explanationC: qExpC,
        explanationD: qExpD,
        pageNumber: cleanPageNumber,
        difficulty: qDifficulty,
        tags: qTags,
        specialTags: qSpecialTags,
        status: qStatus,
      });
      setEditingQuestion(null);
      setFeedbackMsg(
        editingQuestion?.id
          ? 'Question updated with new version (historical student attempts preserved).'
          : 'New question added to the question bank.'
      );
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save question.');
    }
  };

  const handleDeleteSubject = async (subjectId: number) => {
    clearAlerts();
    try {
      const res = await api.deleteSubject(subjectId);
      setConfirmDeleteSubjectId(null);
      setFeedbackMsg(res.message);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to delete subject.');
    }
  };

  const handleDeleteLecture = async (lectureId: number) => {
    clearAlerts();
    try {
      const res = await api.deleteLecture(lectureId);
      setConfirmDeleteLectureId(null);
      setFeedbackMsg(res.message);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to delete lecture.');
    }
  };

  const handleDeleteQuestionBank = async (bankId: number) => {
    clearAlerts();
    try {
      const res = await api.deleteQuestionBank(bankId);
      setConfirmDeleteBankId(null);
      setFeedbackMsg(res.message);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to delete quiz bank.');
    }
  };

  const handleDeleteOrArchiveQuestion = async (questionId: number) => {
    clearAlerts();
    try {
      const res = await api.deleteOrArchiveQuestion(questionId);
      setConfirmDeleteQuestionId(null);
      setFeedbackMsg(res.message);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to delete question.');
    }
  };

  const handleDeleteSession = async (sessionId: number) => {
    clearAlerts();
    try {
      const res = await api.deleteSessionAdmin(sessionId);
      setConfirmDeleteSessionId(null);
      setFeedbackMsg(res.message);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to delete quiz session.');
    }
  };

  // CSV Import & Export Handlers
  const handleDownloadSampleTemplate = () => {
    const csv = getSampleCsvTemplate();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'medatlas_mcq_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportFullQuestionBank = async () => {
    clearAlerts();
    try {
      const csv = await api.exportQuestionBankCsv();
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'medatlas_question_bank_backup.csv';
      a.click();
      URL.revokeObjectURL(url);
      setFeedbackMsg('Exported full question bank backup CSV.');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to export question bank.');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    clearAlerts();
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setErrorMsg('Invalid file format. Please upload a .csv file.');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setErrorMsg('File exceeds the 4 MB size limit.');
      return;
    }
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = String(ev.target?.result || '');
      setCsvContent(text);
      setCsvPreviewReport(null);
      setCsvImportResult(null);
    };
    reader.readAsText(file);
  };

  const handleLoadSampleIntoEditor = () => {
    clearAlerts();
    setCsvFileName('sample_batch_import.csv');
    setCsvContent(getSampleCsvTemplate());
    setCsvPreviewReport(null);
    setCsvImportResult(null);
  };

  const handleValidateCsv = async () => {
    clearAlerts();
    if (!csvContent.trim()) {
      setErrorMsg('Please upload a CSV file or load the sample CSV template first.');
      return;
    }
    setValidatingCsv(true);
    try {
      const targetId = importTargetLectureId !== 'auto' ? Number(importTargetLectureId) : undefined;
      const report = await api.previewCsvImport(csvContent, targetId);
      setCsvPreviewReport(report);
    } catch (err: any) {
      setErrorMsg(err.message || 'CSV validation failed.');
    } finally {
      setValidatingCsv(false);
    }
  };

  const handleConfirmCsvImport = async () => {
    clearAlerts();
    setImportingCsv(true);
    try {
      const targetId = importTargetLectureId !== 'auto' ? Number(importTargetLectureId) : undefined;
      const res = await api.executeCsvImport(csvFileName, csvContent, targetId);
      setCsvImportResult(res);
      const affectedCount = res.affectedLectures?.length || 1;
      setFeedbackMsg(
        `Bulk import completed: ${res.batch.importedCount} question(s) successfully added across ${affectedCount} lecture(s). You can now upload or attach PDF slide decks below.`
      );
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'CSV import failed.');
    } finally {
      setImportingCsv(false);
    }
  };

  const filteredQuestions = questions.filter((q: any) => {
    const matchSubj =
      qSubjectFilter === 'all' || q.subjectId === qSubjectFilter;
    const matchStatus = qStatusFilter === 'all' || q.status === qStatusFilter;
    const matchText =
      !qSearch.trim() ||
      q.questionText.toLowerCase().includes(qSearch.toLowerCase()) ||
      q.tags.toLowerCase().includes(qSearch.toLowerCase()) ||
      (q.specialTags || '').toLowerCase().includes(qSearch.toLowerCase());
    return matchSubj && matchStatus && matchText;
  });

  return (
    <div className="space-y-6">
      {/* Admin Top Header & Navigation Tabs */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#0284C7]">
              <ShieldCheck className="w-4 h-4" />
              <span>Verified Administrator Console · Server-Enforced RBAC</span>
            </div>
            <h1 className="text-2xl font-bold text-slate-900">
              Curriculum &amp; Question Bank Administration
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-1.5 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          {(
            [
              { id: 'overview', label: 'Overview & Logs' },
              { id: 'users', label: `Users & Roles (${users.length})` },
              { id: 'modules', label: `Modules & Subjects (${modulesList.length} / ${subjects.length})` },
              { id: 'lectures', label: `Lectures (${lectures.length})` },
              { id: 'questions', label: `Question Bank (${questions.length})` },
              { id: 'import', label: 'Bulk CSV Import & Export' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setSection(tab.id);
                clearAlerts();
              }}
              className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                section === tab.id
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {feedbackMsg && (
        <div
          role="status"
          className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800"
        >
          {feedbackMsg}
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

      {/* ====================================================================
          SECTION 1: ADMIN OVERVIEW & AUDIT LOGS
      ==================================================================== */}
      {section === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 font-mono-tabular">
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <p className="text-xs font-sans text-slate-500">Registered Users</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">
                {metrics.totalUsers}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <p className="text-xs font-sans text-slate-500">Published Subjects</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">
                {metrics.publishedSubjects} / {metrics.totalSubjects}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <p className="text-xs font-sans text-slate-500">Published Lectures</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">
                {metrics.publishedLectures} / {metrics.totalLectures}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <p className="text-xs font-sans text-slate-500">Published Questions</p>
              <p className="text-2xl font-bold text-[#0284C7] mt-1">
                {metrics.publishedQuestions} / {metrics.totalQuestions}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-6 bg-white rounded-xl border border-slate-200 p-6 space-y-4">
              <h2 className="text-base font-bold text-slate-900">
                Recent Student Sessions
              </h2>
              {recentActivity.length === 0 ? (
                <p className="text-xs text-slate-500">No recent sessions recorded.</p>
              ) : (
                <div className="space-y-2.5 text-xs">
                  {recentActivity.slice(0, 8).map((act: any) => (
                    <div
                      key={act.id}
                      className="p-3 rounded-lg border border-slate-200 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold text-slate-900">{act.title}</p>
                          <p className="text-slate-500 font-mono-tabular">
                            UID: {act.userUid} · Mode: {act.mode}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono-tabular font-bold text-slate-800">
                            {act.status === 'completed'
                              ? `${act.scorePercentage}%`
                              : 'Active'}
                          </span>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteSessionId(act.id)}
                            className="text-red-700 hover:underline font-semibold cursor-pointer"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                      {confirmDeleteSessionId === act.id && (
                        <div className="p-2.5 rounded bg-red-50 border border-red-200 flex items-center justify-between gap-2 text-xs">
                          <span className="font-semibold text-red-900">
                            Delete this quiz session #{act.id}?
                          </span>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleDeleteSession(act.id)}
                              className="px-2.5 py-1 font-semibold text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer"
                            >
                              Confirm Delete
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteSessionId(null)}
                              className="px-2.5 py-1 font-semibold text-slate-700 bg-white border border-slate-300 rounded cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="lg:col-span-6 bg-white rounded-xl border border-slate-200 p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-900">
                  Administrative Audit Logs
                </h2>
              </div>
              {auditLogs.length === 0 ? (
                <p className="text-xs text-slate-500">No audit entries yet.</p>
              ) : (
                <div className="space-y-2.5 text-xs max-h-72 overflow-y-auto">
                  {auditLogs.map((log: any) => (
                    <div
                      key={log.id}
                      className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1"
                    >
                      <div className="flex items-center justify-between font-mono-tabular text-[11px] text-slate-500">
                        <span className="font-semibold text-slate-800">
                          {log.action}
                        </span>
                        <span>{new Date(log.createdAt).toLocaleString()}</span>
                      </div>
                      <p className="text-slate-700">{log.details}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          SECTION 1.5: USERS & ROLES (PROMOTE STUDENT TO ADMIN OR DEMOTE)
      ==================================================================== */}
      {section === 'users' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Registered Accounts &amp; Role Management
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                Promote any student account to Administrator (&ldquo;Make Admin&rdquo;) or change an administrator back to Student (&ldquo;Change to Student&rdquo;). The primary owner account is permanently protected.
              </p>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            {users.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                No registered users found.
              </div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-3 px-4 font-semibold">User</th>
                    <th className="py-3 px-4 font-semibold">Email</th>
                    <th className="py-3 px-4 font-semibold">Role</th>
                    <th className="py-3 px-4 font-semibold">Joined</th>
                    <th className="py-3 px-4 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {users.map((u: any) => (
                    <React.Fragment key={u.uid}>
                      <tr className="hover:bg-slate-50">
                        <td className="py-3 px-4 font-semibold text-slate-900">
                          {u.displayName}
                          {u.isOwner && (
                            <span className="ml-2 text-[11px] font-mono-tabular text-[#0284C7]">
                              (Primary Owner)
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono-tabular text-slate-700">
                          {u.email}
                        </td>
                        <td className="py-3 px-4 uppercase font-mono-tabular font-bold">
                          <span
                            className={
                              u.role === 'admin'
                                ? 'text-[#0284C7]'
                                : 'text-slate-600'
                            }
                          >
                            {u.role}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-mono-tabular text-slate-500">
                          {u.createdAt
                            ? new Date(u.createdAt).toLocaleDateString()
                            : '—'}
                        </td>
                        <td className="py-3 px-4 text-right space-x-3 whitespace-nowrap">
                          {u.isOwner ? (
                            <span className="text-slate-400 font-medium">
                              Protected Owner Admin
                            </span>
                          ) : (
                            <>
                              {u.role === 'student' ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleToggleUserRole(u.uid, 'admin')
                                  }
                                  className="px-3 py-1 font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded cursor-pointer"
                                >
                                  Make Admin
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleToggleUserRole(u.uid, 'student')
                                  }
                                  className="px-3 py-1 font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded cursor-pointer"
                                >
                                  Change to Student
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setResetUserModal({
                                    uid: u.uid,
                                    email: u.email,
                                    name: u.displayName || u.email,
                                  });
                                  setSelectedLectureForReset(lectures[0]?.id || null);
                                }}
                                className="font-semibold text-amber-700 hover:underline cursor-pointer"
                              >
                                Reset Lecture
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteUserUid(u.uid)}
                                className="font-semibold text-red-700 hover:underline cursor-pointer"
                              >
                                Delete User
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                      {confirmDeleteUserUid === u.uid && (
                        <tr className="bg-red-50/80">
                          <td colSpan={5} className="p-3">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                              <span className="font-semibold text-red-900">
                                Permanently delete user &ldquo;{u.email}&rdquo; and all of their sessions and progress?
                              </span>
                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteUser(u.uid)}
                                  className="px-3 py-1 font-semibold text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer"
                                >
                                  Confirm Delete User
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteUserUid(null)}
                                  className="px-3 py-1 font-semibold text-slate-700 bg-white border border-slate-300 rounded cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ====================================================================
          SECTION 2: MODULE & SUBJECT MANAGEMENT (ACADEMIC STRUCTURE)
      ==================================================================== */}
      {section === 'modules' && (
        <div className="space-y-8">
          {/* Top Half: Academic Modules */}
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  Academic Modules
                  <span className="text-xs px-2.5 py-0.5 rounded-full bg-teal-100 text-teal-800 font-semibold font-mono">
                    {modulesList.length}
                  </span>
                </h2>
                <p className="text-xs text-slate-500">
                  Top-level curriculum modules (e.g. BSF 112) containing multi-disciplinary subjects.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => startEditModule()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#08a39d] hover:bg-[#06847f] rounded-lg cursor-pointer shadow-xs transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  New Module
                </button>
              </div>
            </div>

            {editingModule && (
              <form
                onSubmit={handleSaveModule}
                className="bg-white rounded-xl border border-teal-200 shadow-xs p-6 space-y-4"
              >
                <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#08a39d]" />
                    {editingModule.id ? `Edit Module (${modCode})` : 'Create New Academic Module'}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setEditingModule(null)}
                    className="text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 text-xs">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Module Code
                    </label>
                    <input
                      type="text"
                      required
                      value={modCode}
                      onChange={(e) => setModCode(e.target.value)}
                      placeholder="e.g. BSF 112"
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 uppercase font-mono font-bold"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block font-semibold text-slate-700 mb-1">
                      Module Title
                    </label>
                    <input
                      type="text"
                      required
                      value={modTitle}
                      onChange={(e) => setModTitle(e.target.value)}
                      placeholder="e.g. Basic Structure & Function"
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">
                        Order
                      </label>
                      <input
                        type="number"
                        value={modOrder}
                        onChange={(e) => setModOrder(Number(e.target.value))}
                        className="w-full px-3 py-2 text-sm font-mono-tabular rounded-lg border border-slate-300"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">
                        Status
                      </label>
                      <select
                        value={modStatus}
                        onChange={(e) => setModStatus(e.target.value as any)}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                      >
                        <option value="published">Published</option>
                        <option value="draft">Draft</option>
                        <option value="archived">Archived</option>
                      </select>
                    </div>
                  </div>
                </div>
                <div className="text-xs">
                  <label className="block font-semibold text-slate-700 mb-1">
                    Description
                  </label>
                  <textarea
                    rows={2}
                    value={modDesc}
                    onChange={(e) => setModDesc(e.target.value)}
                    placeholder="Brief description of learning outcomes or curriculum scope..."
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditingModule(null)}
                    className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-semibold text-white bg-[#08a39d] hover:bg-[#06847f] rounded-lg cursor-pointer"
                  >
                    Save Module
                  </button>
                </div>
              </form>
            )}

            {/* Modules Cards Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {modulesList.map((m: any) => {
                const assignedSubjects = subjects.filter((s: any) => s.moduleId === m.id);
                const totalQ = assignedSubjects.reduce((acc: number, s: any) => acc + (s.questionCount || 0), 0);
                const totalL = assignedSubjects.reduce((acc: number, s: any) => acc + (s.lectureCount || 0), 0);
                return (
                  <div
                    key={m.id}
                    className="bg-white rounded-xl border border-slate-200 hover:border-teal-400 p-5 shadow-xs flex flex-col justify-between transition-all"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-teal-50 text-teal-800 border border-teal-200">
                          {m.code}
                        </div>
                        <span
                          className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                            m.status === 'published'
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {m.status}
                        </span>
                      </div>
                      <h3 className="font-bold text-slate-900 text-sm mb-1">{m.title}</h3>
                      <p className="text-xs text-slate-500 mb-3 line-clamp-2">
                        {m.description || 'No description provided.'}
                      </p>

                      <div className="flex items-center gap-3 text-xs text-slate-500 font-mono-tabular mb-3">
                        <span>{assignedSubjects.length} Subjects</span>
                        <span>·</span>
                        <span>{totalL} Lectures</span>
                        <span>·</span>
                        <span>{totalQ} Questions</span>
                      </div>

                      <div className="space-y-1.5 pt-2 border-t border-slate-100">
                        <span className="text-[11px] font-semibold text-slate-600">
                          Assigned Subjects ({assignedSubjects.length}):
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {assignedSubjects.length === 0 ? (
                            <span className="text-xs text-slate-400 italic">No subjects assigned yet</span>
                          ) : (
                            assignedSubjects.map((s: any) => (
                              <span
                                key={s.id}
                                className="inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-md bg-teal-50/70 text-teal-800 border border-teal-200/60"
                              >
                                {s.title}
                              </span>
                            ))
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-4 mt-4 border-t border-slate-100 text-xs">
                      <button
                        type="button"
                        onClick={() => startEditSubject(undefined, m.id)}
                        className="text-teal-700 hover:text-teal-900 font-semibold inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add Subject
                      </button>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => startEditModule(m)}
                          className="font-semibold text-slate-700 hover:text-slate-900 cursor-pointer"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteModuleId(m.id)}
                          className="font-semibold text-red-600 hover:text-red-700 cursor-pointer"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {confirmDeleteModuleId === m.id && (
                      <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-xs space-y-2">
                        <p className="font-semibold text-red-900">
                          Delete module &ldquo;{m.code}&rdquo;? Assigned subjects will remain unlinked.
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleDeleteModule(m.id)}
                            className="px-2.5 py-1 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer"
                          >
                            Confirm Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteModuleId(null)}
                            className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="border-t border-slate-200 pt-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  Subjects &amp; Modules Assignment
                  <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 font-semibold font-mono">
                    {subjects.length}
                  </span>
                </h2>
                <p className="text-xs text-slate-500">
                  Manage individual subject disciplines and link them under academic modules.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => startEditSubject()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-lg cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  New Subject
                </button>
              </div>
            </div>

            {editingSubject && (
              <form
                onSubmit={handleSaveSubject}
                className="bg-white rounded-xl border border-slate-200 p-6 space-y-4"
              >
                <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                  <h3 className="text-sm font-bold text-slate-900">
                    {editingSubject.id ? 'Edit Subject' : 'Create New Subject'}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setEditingSubject(null)}
                    className="text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 text-xs">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Parent Academic Module
                    </label>
                    <select
                      value={subjModuleId}
                      onChange={(e) => setSubjModuleId(e.target.value ? Number(e.target.value) : '')}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                    >
                      <option value="">-- Standalone (No Module) --</option>
                      {modulesList.map((m: any) => (
                        <option key={m.id} value={m.id}>
                          {m.code} - {m.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Subject Title
                    </label>
                    <input
                      type="text"
                      required
                      value={subjTitle}
                      onChange={(e) => setSubjTitle(e.target.value)}
                      placeholder="e.g., Physiology or Biochemistry"
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Display Order
                    </label>
                    <input
                      type="number"
                      value={subjOrder}
                      onChange={(e) => setSubjOrder(Number(e.target.value))}
                      className="w-full px-3 py-2 text-sm font-mono-tabular rounded-lg border border-slate-300"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Status
                    </label>
                    <select
                      value={subjStatus}
                      onChange={(e) => setSubjStatus(e.target.value as any)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                    >
                      <option value="published">Published</option>
                      <option value="draft">Draft</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>
                </div>
                <div className="text-xs">
                  <label className="block font-semibold text-slate-700 mb-1">
                    Description
                  </label>
                  <textarea
                    rows={2}
                    required
                    value={subjDesc}
                    onChange={(e) => setSubjDesc(e.target.value)}
                    placeholder="Short summary of topics covered in this subject..."
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditingSubject(null)}
                    className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-lg cursor-pointer"
                  >
                    Save Subject
                  </button>
                </div>
              </form>
            )}

            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              {subjects.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  No subjects exist in the database. Click &ldquo;New Subject&rdquo; above or import via CSV to add your subjects.
                </div>
              ) : (
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      <th className="py-3 px-4 font-semibold">Order</th>
                      <th className="py-3 px-4 font-semibold">Academic Module</th>
                      <th className="py-3 px-4 font-semibold">Subject Title</th>
                      <th className="py-3 px-4 font-semibold">Content</th>
                      <th className="py-3 px-4 font-semibold">Status</th>
                      <th className="py-3 px-4 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {subjects.map((s: any) => {
                      const parentMod = modulesList.find((m: any) => m.id === s.moduleId);
                      return (
                        <React.Fragment key={s.id}>
                          <tr className="hover:bg-slate-50">
                            <td className="py-3 px-4 font-mono-tabular">
                              {s.displayOrder}
                            </td>
                            <td className="py-3 px-4">
                              {parentMod ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold font-mono bg-teal-50 text-teal-800 border border-teal-200">
                                  {parentMod.code}
                                </span>
                              ) : (
                                <span className="text-slate-400 text-xs italic">Standalone</span>
                              )}
                            </td>
                            <td className="py-3 px-4">
                              <p className="font-bold text-slate-900">{s.title}</p>
                              <p className="text-slate-500 text-[11px]">{s.description}</p>
                            </td>
                            <td className="py-3 px-4 font-mono-tabular text-slate-600">
                              {s.lectureCount ?? 0} Lectures · {s.questionCount ?? 0} MCQs
                            </td>
                            <td className="py-3 px-4 uppercase font-mono-tabular font-semibold">
                              {s.status}
                            </td>
                            <td className="py-3 px-4 text-right space-x-3 whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => startEditSubject(s)}
                                className="font-semibold text-[#0284C7] hover:underline cursor-pointer"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteSubjectId(s.id)}
                                className="font-semibold text-red-700 hover:underline cursor-pointer"
                              >
                                Delete Subject
                              </button>
                            </td>
                          </tr>
                          {confirmDeleteSubjectId === s.id && (
                            <tr className="bg-red-50/80">
                              <td colSpan={6} className="p-3">
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                                  <span className="font-semibold text-red-900">
                                    Permanently delete subject &ldquo;{s.title}&rdquo; along with its lectures, quizzes, and questions?
                                  </span>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteSubject(s.id)}
                                      className="px-3 py-1 font-semibold text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer"
                                    >
                                      Confirm Permanent Delete
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteSubjectId(null)}
                                      className="px-3 py-1 font-semibold text-slate-700 bg-white border border-slate-300 rounded cursor-pointer"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          SECTION 3: LECTURE & QUIZ MANAGEMENT
      ==================================================================== */}
      {section === 'lectures' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Manage Lectures &amp; Quizzes
              </h2>
              <p className="text-xs text-slate-500">
                Create lectures, organize modules, and upload or replace lecture PDF slide decks.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  clearAlerts();
                  setUploadPdfTargetLecture(null);
                  setShowUploadPdfModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer transition-colors shadow-xs"
              >
                <Upload className="w-4 h-4 text-[#0284C7]" />
                <span>Upload PDF to Lecture</span>
              </button>
              <button
                type="button"
                onClick={() => startEditLecture()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-lg cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>New Lecture</span>
              </button>
            </div>
          </div>

          {editingLecture && (
            <form
              onSubmit={handleSaveLecture}
              className="bg-white rounded-xl border border-slate-200 p-6 space-y-4 text-xs"
            >
              <h3 className="text-sm font-bold text-slate-900">
                {editingLecture.id ? 'Edit Lecture' : 'Create New Lecture'}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Parent Subject
                  </label>
                  <select
                    value={lectSubjectId}
                    onChange={(e) => setLectSubjectId(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                  >
                    {subjects.map((s: any) => {
                      const mod = modulesList.find((m: any) => m.id === s.moduleId);
                      return (
                        <option key={s.id} value={s.id}>
                          {mod ? `[${mod.code}] ` : ''}{s.title}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Lecture Number
                  </label>
                  <input
                    type="number"
                    value={lectNumber}
                    onChange={(e) => setLectNumber(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm font-mono-tabular rounded-lg border border-slate-300"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Publication Status
                  </label>
                  <select
                    value={lectStatus}
                    onChange={(e) => setLectStatus(e.target.value as any)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                  >
                    <option value="published">Published</option>
                    <option value="draft">Draft</option>
                    <option value="archived">Archived</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Lecture Title
                </label>
                <input
                  type="text"
                  required
                  value={lectTitle}
                  onChange={(e) => setLectTitle(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Description
                </label>
                <textarea
                  rows={2}
                  required
                  value={lectDesc}
                  onChange={(e) => setLectDesc(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                />
              </div>

              <div className="space-y-3 p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <label className="block font-semibold text-slate-800 text-xs">
                      Lecture Slide Deck / PDF Document
                    </label>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Upload a PDF file to save directly into the database, or enter an existing URL.
                    </p>
                  </div>
                  {lectPdfUrl && (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          setPreviewPdfModal({
                            url: lectPdfUrl,
                            title: lectTitle || 'Lecture PDF Preview',
                          })
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#0284C7] bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-lg transition-colors cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Preview PDF</span>
                      </button>
                      <a
                        href={lectPdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 rounded-lg transition-colors cursor-pointer"
                      >
                        <ExternalLink className="w-3.5 h-3.5 text-slate-500" />
                        <span>Open in New Tab</span>
                      </a>
                    </div>
                  )}
                </div>

                {/* Upload Action Button */}
                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer transition-colors shadow-xs">
                    <Upload className="w-4 h-4" />
                    <span>{uploadingPdf ? 'Uploading to Database...' : 'Upload PDF File'}</span>
                    <input
                      type="file"
                      accept=".pdf,application/pdf"
                      disabled={uploadingPdf}
                      onChange={handlePdfFileUpload}
                      className="hidden"
                    />
                  </label>
                  <span className="text-xs text-slate-400">
                    PDF files up to 50MB are stored persistently in the database
                  </span>
                </div>

                {uploadedPdfSuccess && (
                  <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span className="font-medium">{uploadedPdfSuccess}</span>
                  </div>
                )}

                <div>
                  <label className="block font-medium text-slate-600 text-[11px] mb-1">
                    PDF Document URL / Reference
                  </label>
                  <input
                    type="text"
                    value={lectPdfUrl}
                    onChange={(e) => {
                      setLectPdfUrl(e.target.value);
                      setUploadedPdfSuccess(null);
                    }}
                    placeholder="e.g. /lectures/cardiology-acs.pdf"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 bg-white"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    The URL automatically populates when you upload a PDF file above.
                  </p>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Educational Notes / High-Yield Summary (Optional)
                </label>
                <textarea
                  rows={4}
                  value={lectNotes}
                  onChange={(e) => setLectNotes(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingLecture(null)}
                  className="px-4 py-2 font-semibold text-slate-700 bg-slate-100 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 font-semibold text-white bg-[#0284C7] rounded-lg cursor-pointer"
                >
                  Save Lecture
                </button>
              </div>
            </form>
          )}

          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            {lectures.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                No lectures or quizzes exist in the database.
              </div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-3 px-4 font-semibold">Subject</th>
                    <th className="py-3 px-4 font-semibold">#</th>
                    <th className="py-3 px-4 font-semibold">Lecture Title</th>
                    <th className="py-3 px-4 font-semibold">PDF Document</th>
                    <th className="py-3 px-4 font-semibold">Questions</th>
                    <th className="py-3 px-4 font-semibold">Status</th>
                    <th className="py-3 px-4 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lectures.map((l: any) => (
                    <React.Fragment key={l.id}>
                      <tr className="hover:bg-slate-50">
                        <td className="py-3 px-4 font-medium text-slate-700">
                          {l.subjectTitle}
                        </td>
                        <td className="py-3 px-4 font-mono-tabular">
                          {l.lectureNumber}
                        </td>
                        <td className="py-3 px-4">
                          <p className="font-bold text-slate-900">{l.title}</p>
                          <p className="text-slate-500">{l.description}</p>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          {l.pdfUrl ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setPreviewPdfModal({ url: l.pdfUrl, title: l.title })}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold bg-sky-50 text-[#0284C7] hover:bg-sky-100 transition-colors cursor-pointer"
                                title="View attached lecture PDF"
                              >
                                <FileText className="w-3.5 h-3.5" />
                                <span>View PDF</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  clearAlerts();
                                  setUploadPdfTargetLecture(l);
                                  setShowUploadPdfModal(true);
                                }}
                                className="text-[11px] font-medium text-slate-500 hover:text-slate-800 hover:underline cursor-pointer"
                                title="Upload a new or replacement PDF file"
                              >
                                Change
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                clearAlerts();
                                setUploadPdfTargetLecture(l);
                                setShowUploadPdfModal(true);
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-[#0284C7] bg-sky-50 hover:bg-sky-100 border border-sky-200 transition-colors cursor-pointer"
                              title="Upload PDF slide deck to this lecture"
                            >
                              <Upload className="w-3 h-3" />
                              <span>Upload PDF</span>
                            </button>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono-tabular text-slate-600">
                          {l.questionCount ?? 0} MCQs
                        </td>
                        <td className="py-3 px-4 uppercase font-mono-tabular font-semibold">
                          {l.status}
                        </td>
                        <td className="py-3 px-4 text-right space-x-3 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => {
                              clearAlerts();
                              setUploadPdfTargetLecture(l);
                              setShowUploadPdfModal(true);
                            }}
                            className="font-semibold text-[#0284C7] hover:underline cursor-pointer"
                          >
                            {l.pdfUrl ? 'Update PDF' : 'Upload PDF'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setImportTargetLectureId(l.id);
                              setSection('import');
                              clearAlerts();
                            }}
                            className="font-semibold text-emerald-600 hover:text-emerald-700 hover:underline cursor-pointer"
                          >
                            Import MCQs
                          </button>
                          <button
                            type="button"
                            onClick={() => startEditLecture(l)}
                            className="font-semibold text-slate-700 hover:text-slate-900 hover:underline cursor-pointer"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteLectureId(l.id)}
                            className="font-semibold text-red-700 hover:underline cursor-pointer"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                      {confirmDeleteLectureId === l.id && (
                        <tr className="bg-red-50/80">
                          <td colSpan={6} className="p-3">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                              <span className="font-semibold text-red-900">
                                Permanently delete lecture &ldquo;{l.title}&rdquo; and its quizzes and questions?
                              </span>
                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteLecture(l.id)}
                                  className="px-3 py-1 font-semibold text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer"
                                >
                                  Confirm Permanent Delete
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteLectureId(null)}
                                  className="px-3 py-1 font-semibold text-slate-700 bg-white border border-slate-300 rounded cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {questionBanks.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <h3 className="text-xs font-bold text-slate-800">
                  Individual Quiz Banks ({questionBanks.length})
                </h3>
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2.5 px-4 font-semibold">Quiz Title</th>
                    <th className="py-2.5 px-4 font-semibold">Subject / Lecture</th>
                    <th className="py-2.5 px-4 font-semibold">Type</th>
                    <th className="py-2.5 px-4 font-semibold text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {questionBanks.map((b: any) => (
                    <React.Fragment key={b.id}>
                      <tr className="hover:bg-slate-50">
                        <td className="py-2.5 px-4 font-semibold text-slate-900">
                          {b.title}
                        </td>
                        <td className="py-2.5 px-4 text-slate-600">
                          {b.subjectTitle} · {b.lectureTitle}
                        </td>
                        <td className="py-2.5 px-4 font-mono-tabular uppercase">
                          {b.bankType}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteBankId(b.id)}
                            className="font-semibold text-red-700 hover:underline cursor-pointer"
                          >
                            Delete Quiz
                          </button>
                        </td>
                      </tr>
                      {confirmDeleteBankId === b.id && (
                        <tr className="bg-red-50/80">
                          <td colSpan={4} className="p-3">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="font-semibold text-red-900">
                                Permanently delete quiz &ldquo;{b.title}&rdquo;?
                              </span>
                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteQuestionBank(b.id)}
                                  className="px-3 py-1 font-semibold text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer"
                                >
                                  Confirm Delete
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteBankId(null)}
                                  className="px-3 py-1 font-semibold text-slate-700 bg-white border border-slate-300 rounded cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ====================================================================
          SECTION 4: QUESTION BANK MANAGEMENT & STUDENT PREVIEW
      ==================================================================== */}
      {section === 'questions' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={qSearch}
                  onChange={(e) => setQSearch(e.target.value)}
                  placeholder="Search question stem or tags..."
                  className="pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white w-64"
                />
              </div>

              <select
                aria-label="Filter questions by subject"
                value={qSubjectFilter}
                onChange={(e) =>
                  setQSubjectFilter(
                    e.target.value === 'all' ? 'all' : Number(e.target.value)
                  )
                }
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white"
              >
                <option value="all">All Subjects</option>
                {subjects.map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter questions by status"
                value={qStatusFilter}
                onChange={(e) => setQStatusFilter(e.target.value)}
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white"
              >
                <option value="all">All Statuses</option>
                <option value="published">Published</option>
                <option value="draft">Draft</option>
                <option value="archived">Archived</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => startEditQuestion()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-lg cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Create Question Manually
              </button>
            </div>
          </div>

          {editingQuestion && (
            <form
              onSubmit={handleSaveQuestion}
              className="bg-white rounded-xl border border-slate-200 p-6 space-y-4 text-xs"
            >
              <h3 className="text-sm font-bold text-slate-900">
                {editingQuestion.id
                  ? `Edit Question #${editingQuestion.id} (v${editingQuestion.version})`
                  : 'Create New Multiple-Choice Question'}
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Subject
                  </label>
                  <select
                    value={qSubjectId}
                    onChange={(e) => {
                      const nextSubj = Number(e.target.value);
                      setQSubjectId(nextSubj);
                      const firstLect = lectures.find(
                        (l: any) => l.subjectId === nextSubj
                      );
                      if (firstLect) setQLectureId(firstLect.id);
                    }}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                  >
                    {subjects.map((s: any) => {
                      const mod = modulesList.find((m: any) => m.id === s.moduleId);
                      return (
                        <option key={s.id} value={s.id}>
                          {mod ? `[${mod.code}] ` : ''}{s.title}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Lecture
                  </label>
                  <select
                    value={qLectureId}
                    onChange={(e) => setQLectureId(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                  >
                    {lectures
                      .filter((l: any) => l.subjectId === qSubjectId)
                      .map((l: any) => (
                        <option key={l.id} value={l.id}>
                          {l.title}
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Difficulty
                  </label>
                  <select
                    value={qDifficulty}
                    onChange={(e) => setQDifficulty(e.target.value as any)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                  >
                    <option value="Easy">Easy</option>
                    <option value="Medium">Medium</option>
                    <option value="Hard">Hard</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Status
                  </label>
                  <select
                    value={qStatus}
                    onChange={(e) => setQStatus(e.target.value as any)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                  >
                    <option value="published">Published</option>
                    <option value="draft">Draft</option>
                    <option value="archived">Archived</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Clinical Vignette / Question Stem
                </label>
                <textarea
                  rows={3}
                  required
                  value={qText}
                  onChange={(e) => setQText(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Option A
                  </label>
                  <input
                    type="text"
                    required
                    value={qOptA}
                    onChange={(e) => setQOptA(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Option B
                  </label>
                  <input
                    type="text"
                    required
                    value={qOptB}
                    onChange={(e) => setQOptB(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Option C
                  </label>
                  <input
                    type="text"
                    required
                    value={qOptC}
                    onChange={(e) => setQOptC(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Option D
                  </label>
                  <input
                    type="text"
                    required
                    value={qOptD}
                    onChange={(e) => setQOptD(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Correct Answer Key
                  </label>
                  <select
                    value={qCorrect}
                    onChange={(e) => setQCorrect(e.target.value as any)}
                    className="w-full px-3 py-2 text-sm font-mono-tabular font-bold rounded-lg border border-slate-300 bg-white"
                  >
                    <option value="A">Option A</option>
                    <option value="B">Option B</option>
                    <option value="C">Option C</option>
                    <option value="D">Option D</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    PDF Page Number
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={qPageNumber}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '' || (/^\d+$/.test(val) && Number(val) > 0)) {
                        setQPageNumber(val);
                      }
                    }}
                    placeholder="e.g. 2"
                    className="w-full px-3 py-2 text-sm font-mono-tabular rounded-lg border border-slate-300"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Positive integer for lecture slide/page.
                  </p>
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Topic Tags (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={qTags}
                    onChange={(e) => setQTags(e.target.value)}
                    placeholder="e.g., Collagen,Extracellular Matrix"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Special Tags / Student Labels
                  </label>
                  <input
                    type="text"
                    value={qSpecialTags}
                    onChange={(e) => setQSpecialTags(e.target.value)}
                    placeholder="e.g., Old Exam, كتاب القسم"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-amber-300 bg-amber-50/30"
                  />
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {['Old Exams', 'كتاب القسم', 'Important'].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => {
                          const current = parseSpecialTags(qSpecialTags);
                          if (!current.some((t) => t.toLowerCase() === preset.toLowerCase())) {
                            setQSpecialTags([...current, preset].join(', '));
                          }
                        }}
                        className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200 cursor-pointer"
                      >
                        + {preset}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Primary Explanation for Correct Answer (General Explanation)
                </label>
                <textarea
                  rows={2}
                  required
                  value={qExplanation}
                  onChange={(e) => setQExplanation(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                />
              </div>

              <div className="space-y-3 pt-2 border-t border-slate-100">
                <h4 className="font-semibold text-slate-800 text-xs uppercase tracking-wider">
                  Individual Option Explanations &amp; Rationales
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Option A Explanation
                    </label>
                    <textarea
                      rows={2}
                      value={qExpA}
                      onChange={(e) => setQExpA(e.target.value)}
                      placeholder="Why Option A is correct or incorrect..."
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Option B Explanation
                    </label>
                    <textarea
                      rows={2}
                      value={qExpB}
                      onChange={(e) => setQExpB(e.target.value)}
                      placeholder="Why Option B is correct or incorrect..."
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Option C Explanation
                    </label>
                    <textarea
                      rows={2}
                      value={qExpC}
                      onChange={(e) => setQExpC(e.target.value)}
                      placeholder="Why Option C is correct or incorrect..."
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Option D Explanation
                    </label>
                    <textarea
                      rows={2}
                      value={qExpD}
                      onChange={(e) => setQExpD(e.target.value)}
                      placeholder="Why Option D is correct or incorrect..."
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingQuestion(null)}
                  className="px-4 py-2 font-semibold text-slate-700 bg-slate-100 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 font-semibold text-white bg-[#0284C7] rounded-lg cursor-pointer"
                >
                  Save Question
                </button>
              </div>
            </form>
          )}

          <div className="space-y-3">
            {filteredQuestions.map((q: any) => (
              <div
                key={q.id}
                className="bg-white rounded-xl border border-slate-200 p-5 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <div className="flex flex-wrap items-center gap-2 font-mono-tabular">
                    <span>
                      #{q.id} (v{q.version}) · {q.subjectTitle} · {q.lectureTitle} ·{' '}
                      Difficulty: {q.difficulty} · Status: {q.status.toUpperCase()}
                      {q.pageNumber ? ` · PDF Page: ${q.pageNumber}` : ''}
                    </span>
                    {parseAllQuestionTags(q.tags, q.specialTags).map((tagItem) => (
                      <span
                        key={tagItem.label}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-sans border ${
                          tagItem.isSpecial
                            ? 'font-bold bg-amber-100 text-amber-800 border-amber-300'
                            : 'font-medium bg-sky-50 text-sky-800 border-sky-200'
                        }`}
                        title={tagItem.isSpecial ? `Special Source Label: ${tagItem.label}` : `Topic Tag: ${tagItem.label}`}
                      >
                        <Tag className={`w-2.5 h-2.5 shrink-0 ${tagItem.isSpecial ? 'text-amber-600' : 'text-sky-600'}`} />
                        {tagItem.label}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setPreviewQuestion(q)}
                      className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-slate-900 cursor-pointer"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Student Preview
                    </button>
                    <button
                      type="button"
                      onClick={() => startEditQuestion(q)}
                      className="font-semibold text-[#0284C7] hover:underline cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteQuestionId(q.id)}
                      className="font-semibold text-red-700 hover:underline cursor-pointer"
                    >
                      Delete Permanently
                    </button>
                  </div>
                </div>

                <p className="text-sm font-serif-academic text-slate-900">
                  {q.questionText}
                </p>

                <div className="text-xs text-slate-500 font-mono-tabular">
                  Correct Answer: Option {q.correctAnswer} ({q[`option${q.correctAnswer}`]})
                </div>

                {confirmDeleteQuestionId === q.id && (
                  <div className="p-3 rounded-lg bg-red-50 border border-red-200 flex items-center justify-between text-xs">
                    <span className="text-red-900 font-medium">
                      Permanently delete Question #{q.id} from the database?
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleDeleteOrArchiveQuestion(q.id)}
                        className="px-3 py-1 font-semibold text-white bg-red-600 rounded cursor-pointer"
                      >
                        Confirm Permanent Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteQuestionId(null)}
                        className="px-3 py-1 font-semibold text-slate-700 bg-white border border-slate-300 rounded cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ====================================================================
          SECTION 5: BULK CSV QUESTION IMPORT & EXPORT
      ==================================================================== */}
      {section === 'import' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  Bulk CSV Question Bank Import &amp; Backup Export
                </h2>
                <p className="text-xs text-slate-600 mt-0.5">
                  Download the official 16-column CSV template, validate your rows before importing, or export the entire question bank as a backup.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleDownloadSampleTemplate}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  1. Download CSV Template
                </button>
                <button
                  type="button"
                  onClick={handleLoadSampleIntoEditor}
                  className="px-3.5 py-2 text-xs font-semibold text-[#0284C7] bg-sky-50 hover:bg-sky-100 rounded-lg cursor-pointer"
                >
                  Load Sample CSV Rows
                </button>
                <button
                  type="button"
                  onClick={handleExportFullQuestionBank}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  Export Full Question Bank CSV
                </button>
              </div>
            </div>

            {/* Step 1: Target Lecture Destination */}
            <div className="p-4 rounded-xl border border-sky-100 bg-sky-50/50 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <label htmlFor="import-target-lecture" className="block text-xs font-bold text-slate-900">
                    Step 1: Choose Target Lecture (Recommended)
                  </label>
                  <p className="text-[11px] text-slate-600">
                    Select a lecture to automatically route and attach all imported MCQs into it. Columns &lsquo;subject&rsquo; and &lsquo;lecture&rsquo; in your CSV will be optional.
                  </p>
                </div>
                {importTargetLectureId !== 'auto' && (
                  <button
                    type="button"
                    onClick={() => {
                      setImportTargetLectureId('auto');
                      setCsvPreviewReport(null);
                    }}
                    className="text-[11px] font-semibold text-slate-500 hover:text-slate-800 underline self-start sm:self-auto cursor-pointer"
                  >
                    Reset to Auto-detect
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
                <select
                  id="import-target-lecture"
                  value={importTargetLectureId}
                  onChange={(e) => {
                    const val = e.target.value === 'auto' ? 'auto' : Number(e.target.value);
                    setImportTargetLectureId(val);
                    setCsvPreviewReport(null);
                  }}
                  className="w-full text-xs p-2.5 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0284C7] font-medium text-slate-800 cursor-pointer"
                >
                  <option value="auto">
                    -- Auto-detect from CSV &lsquo;subject&rsquo; and &lsquo;lecture&rsquo; columns --
                  </option>
                  {lectures.map((l: any) => (
                    <option key={l.id} value={l.id}>
                      {l.subjectTitle ? `${l.subjectTitle} → ` : ''}{l.title} ({l.questionCount ?? 0} current MCQs)
                    </option>
                  ))}
                </select>

                {(() => {
                  const targetLec = lectures.find((l: any) => l.id === importTargetLectureId);
                  if (!targetLec) return (
                    <div className="text-[11px] text-slate-500 italic p-2.5 bg-white border border-slate-200 rounded-lg">
                      Importing in auto-detect mode: CSV must specify &lsquo;subject&rsquo; and &lsquo;lecture&rsquo; matching existing names.
                    </div>
                  );
                  return (
                    <div className="flex items-center justify-between gap-2 p-2 px-3 bg-white border border-sky-200 rounded-lg text-xs text-slate-700">
                      <div className="flex-1 min-w-0">
                        <span className="font-bold text-slate-900 truncate block">
                          Target: {targetLec.title}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          {targetLec.subjectTitle || 'Unknown Subject'} · {targetLec.questionCount ?? 0} MCQs
                        </span>
                      </div>
                      {targetLec.pdfUrl ? (
                        <button
                          type="button"
                          onClick={() => setPreviewPdfModal({ url: targetLec.pdfUrl, title: targetLec.title })}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold bg-sky-100 text-[#0284C7] hover:bg-sky-200 transition-colors shrink-0 cursor-pointer"
                          title="View attached lecture PDF"
                        >
                          <FileText className="w-3 h-3" />
                          <span>View PDF</span>
                        </button>
                      ) : (
                        <span className="text-[10px] text-slate-400 italic shrink-0">No PDF attached</span>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-5 space-y-3 text-xs">
                <label className="block font-bold text-slate-900">
                  Step 2: Upload CSV File (.csv, max 4 MB)
                </label>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileUpload}
                  className="block w-full text-xs text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-[#0284C7] file:text-white hover:file:bg-[#0369A1] cursor-pointer"
                />
                <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5 text-slate-600">
                  <p className="font-semibold text-slate-900">
                    Documented CSV Columns:
                  </p>
                  <p className="font-mono-tabular text-[11px] leading-relaxed">
                    subject, lecture, question_text, option_a, option_b, option_c, option_d, correct_answer, explanation, explanation_a, explanation_b, explanation_c, explanation_d, difficulty, tags, &quot;old exams&quot;, &quot;كتاب القسم&quot;, &quot;important&quot;, page_number, status
                  </p>
                  <p className="text-[11px] text-amber-800 pt-0.5">
                    <strong>New Tag System (0 or 1):</strong> Add columns named <code className="font-mono bg-amber-100 px-1 rounded">&quot;old exams&quot;</code>, <code className="font-mono bg-amber-100 px-1 rounded">&quot;كتاب القسم&quot;</code>, and <code className="font-mono bg-amber-100 px-1 rounded">&quot;important&quot;</code> with values <code className="font-mono font-bold">1</code> or <code className="font-mono font-bold">0</code> to tag questions with student notification badges.
                  </p>
                </div>
              </div>

              <div className="lg:col-span-7 space-y-3 text-xs">
                <label
                  htmlFor="csv-textarea"
                  className="block font-bold text-slate-900"
                >
                  CSV Payload Inspector / Editor ({csvFileName})
                </label>
                <textarea
                  id="csv-textarea"
                  rows={6}
                  value={csvContent}
                  onChange={(e) => {
                    setCsvContent(e.target.value);
                    setCsvPreviewReport(null);
                  }}
                  placeholder="Paste CSV rows here or click 'Load Sample CSV Rows' above..."
                  className="w-full p-3 font-mono-tabular text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#0284C7]"
                />
                <div className="flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={handleValidateCsv}
                    disabled={validatingCsv}
                    className="px-4 py-2 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-lg cursor-pointer"
                  >
                    {validatingCsv
                      ? 'Validating...'
                      : 'Step 3: Validate & Preview Import'}
                  </button>
                </div>
              </div>
            </div>

            {/* Validation Preview Report */}
            {csvPreviewReport && (
              <div className="pt-5 border-t border-slate-200 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <h3 className="text-sm font-bold text-slate-900">
                      Validation Preview Report
                    </h3>
                    <p className="text-xs text-slate-600 font-mono-tabular">
                      Total Rows: {csvPreviewReport.totalRows} · Valid:{' '}
                      <span className="text-emerald-700 font-bold">
                        {csvPreviewReport.validCount}
                      </span>{' '}
                      · Duplicates:{' '}
                      <span className="text-amber-700 font-bold">
                        {csvPreviewReport.duplicateCount}
                      </span>{' '}
                      · Invalid:{' '}
                      <span className="text-red-700 font-bold">
                        {csvPreviewReport.invalidCount}
                      </span>
                    </p>
                  </div>

                  {csvPreviewReport.validCount > 0 && (
                    <button
                      type="button"
                      onClick={handleConfirmCsvImport}
                      disabled={importingCsv}
                      className="px-5 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer"
                    >
                      {importingCsv
                        ? 'Importing...'
                        : `Step 4: Confirm Import of ${csvPreviewReport.validCount} Valid Record(s)`}
                    </button>
                  )}
                </div>

                {csvPreviewReport.targetLectureContext && (
                  <div className="p-3 rounded-lg bg-sky-50 border border-sky-200 text-xs text-sky-900 flex items-center justify-between">
                    <span>
                      <strong className="font-semibold">Import Destination:</strong> {csvPreviewReport.targetLectureContext.subjectTitle} &rarr; {csvPreviewReport.targetLectureContext.lectureTitle} (ID #{csvPreviewReport.targetLectureContext.lectureId})
                    </span>
                    <span className="text-[11px] text-sky-700 font-medium">All MCQs attach directly to this lecture</span>
                  </div>
                )}

                {csvPreviewReport.headerErrors?.length > 0 && (
                  <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                    {csvPreviewReport.headerErrors.join(' ')}
                  </div>
                )}

                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {(csvPreviewReport.rows || []).map((r: any) => (
                    <div
                      key={r.rowNumber}
                      className={`p-3 rounded-lg border text-xs ${
                        r.isValid
                          ? 'border-emerald-200 bg-emerald-50/40'
                          : r.isDuplicate
                          ? 'border-amber-200 bg-amber-50/40'
                          : 'border-red-200 bg-red-50/40'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tabular">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-bold text-slate-900">
                            CSV Row #{r.rowNumber} · {r.subject || 'Missing Subject'} →{' '}
                            {r.lecture || 'Missing Lecture'}
                          </span>
                          {parseAllQuestionTags(r.tags, r.specialTags).map((tagItem) => (
                            <span
                              key={tagItem.label}
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-sans border ${
                                tagItem.isSpecial
                                  ? 'font-bold bg-amber-100 text-amber-800 border-amber-300'
                                  : 'font-medium bg-sky-50 text-sky-800 border-sky-200'
                              }`}
                              title={tagItem.isSpecial ? `Special Source Label: ${tagItem.label}` : `Topic Tag: ${tagItem.label}`}
                            >
                              <Tag className={`w-2.5 h-2.5 shrink-0 ${tagItem.isSpecial ? 'text-amber-600' : 'text-sky-600'}`} />
                              {tagItem.label}
                            </span>
                          ))}
                        </div>
                        <span
                          className={`font-semibold ${
                            r.isValid
                              ? 'text-emerald-700'
                              : r.isDuplicate
                              ? 'text-amber-700'
                              : 'text-red-700'
                          }`}
                        >
                          {r.isValid
                            ? '✓ Ready to Import'
                            : r.isDuplicate
                            ? 'Skipped (Duplicate)'
                            : '✕ Invalid Row'}
                        </span>
                      </div>
                      <p className="text-slate-700 truncate mt-1">
                        {r.questionText || '(Empty question stem)'}
                      </p>
                      {r.errors?.length > 0 && (
                        <ul className="mt-1.5 text-red-700 list-disc list-inside space-y-0.5">
                          {r.errors.map((err: string, i: number) => (
                            <li key={i}>{err}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Post-Import Generated Lectures & PDF Setup */}
            {csvImportResult && (
              <div className="pt-6 border-t border-slate-200 space-y-4">
                <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 space-y-1">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                    <h3 className="text-sm font-bold text-emerald-950">
                      Import Complete: {csvImportResult.batch?.importedCount || 0} Questions Added!
                    </h3>
                  </div>
                  <p className="text-xs text-emerald-800 leading-relaxed">
                    All valid multiple choice questions have been parsed and committed to the database.
                    Below are the lectures that were generated or updated by this import. You can upload PDF slide decks directly to each lecture right here.
                  </p>
                </div>

                {/* Generated Lectures List */}
                <div className="space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      Generated &amp; Updated Lectures ({csvImportResult.affectedLectures?.length || (importTargetLectureId !== 'auto' ? 1 : 0)})
                    </h4>
                    <span className="text-[11px] text-slate-500">
                      Upload PDFs to make slide decks instantly viewable by students
                    </span>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {(() => {
                      const affected =
                        csvImportResult.affectedLectures && csvImportResult.affectedLectures.length > 0
                          ? csvImportResult.affectedLectures
                          : lectures.filter((l: any) => l.id === importTargetLectureId);

                      if (affected.length === 0) {
                        return (
                          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-500 text-center">
                            No specific lecture breakdown available. View all lectures in the Lectures tab.
                          </div>
                        );
                      }

                      return affected.map((affLect: any) => {
                        const currentLect = lectures.find((l: any) => l.id === affLect.id) || affLect;
                        const hasPdf = Boolean(currentLect.pdfUrl);

                        return (
                          <div
                            key={affLect.id}
                            className="p-4 rounded-xl border border-slate-200 bg-white hover:border-slate-300 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs"
                          >
                            <div className="space-y-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-teal-50 text-teal-800 border border-teal-200">
                                  {currentLect.subjectTitle || 'Medical Module'}
                                </span>
                                {affLect.isNew && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                                    ★ Newly Generated
                                  </span>
                                )}
                              </div>
                              <h5 className="font-bold text-sm text-slate-900 truncate">
                                Lecture {currentLect.lectureNumber || 1}: {currentLect.title}
                              </h5>
                              <p className="text-xs text-slate-500">
                                {currentLect.questionCount ?? currentLect.questionsCount ?? 'Includes new'} MCQs attached ·{' '}
                                {hasPdf ? (
                                  <span className="text-emerald-700 font-medium">✓ PDF attached ({currentLect.pdfUrl})</span>
                                ) : (
                                  <span className="text-amber-700 font-medium">⚠ No PDF slide deck attached yet</span>
                                )}
                              </p>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {hasPdf && (
                                <button
                                  type="button"
                                  onClick={() => setPreviewPdfModal({ url: currentLect.pdfUrl, title: currentLect.title })}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#0284C7] bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-lg transition-colors cursor-pointer"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                  <span>Preview PDF</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  clearAlerts();
                                  setUploadPdfTargetLecture(currentLect);
                                  setShowUploadPdfModal(true);
                                }}
                                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer shadow-xs ${
                                  hasPdf
                                    ? 'text-slate-700 bg-slate-100 hover:bg-slate-200'
                                    : 'text-white bg-[#0284C7] hover:bg-[#0369A1]'
                                }`}
                              >
                                <Upload className="w-3.5 h-3.5" />
                                <span>{hasPdf ? 'Replace PDF' : 'Upload PDF for this Lecture'}</span>
                              </button>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => {
                      setCsvImportResult(null);
                      setCsvPreviewReport(null);
                      setCsvContent('');
                    }}
                    className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                  >
                    ← Import Another CSV File
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSection('lectures');
                      clearAlerts();
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                  >
                    <span>View All Lectures &amp; Quizzes</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Student Preview Modal */}
      {previewQuestion && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4"
        >
          <div className="w-full max-w-2xl rounded-xl bg-white border border-slate-200 shadow-lg p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <p className="text-xs text-slate-500">
                  Student Interface Preview · {previewQuestion.subjectTitle} ·{' '}
                  {previewQuestion.lectureTitle}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-bold text-slate-900">
                    Question #{previewQuestion.id} ({previewQuestion.difficulty})
                  </h3>
                  {parseAllQuestionTags(previewQuestion.tags, previewQuestion.specialTags).map((tagItem) => (
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
              </div>
              <button
                type="button"
                aria-label="Close preview"
                onClick={() => setPreviewQuestion(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-base font-serif-academic text-slate-900 leading-relaxed">
              {previewQuestion.questionText}
            </p>

            <div className="space-y-2 text-xs">
              {(['A', 'B', 'C', 'D'] as const).map((opt) => {
                const isCorrect = previewQuestion.correctAnswer === opt;
                return (
                  <div
                    key={opt}
                    className={`p-3 rounded-lg border ${
                      isCorrect
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-950 font-semibold'
                        : 'border-slate-200 text-slate-700'
                    }`}
                  >
                    <span className="font-mono-tabular font-bold mr-2">{opt}.</span>
                    {previewQuestion[`option${opt}`]}
                  </div>
                );
              })}
            </div>

            <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 space-y-1">
              <p className="font-bold text-slate-900">Explanation:</p>
              <p>{previewQuestion.explanation}</p>
            </div>
          </div>
        </div>
      )}

      {/* Admin PDF Preview Modal */}
      {previewPdfModal && (
        <PdfViewerModal
          pdfUrl={previewPdfModal.url}
          lectureTitle={previewPdfModal.title}
          initialPage={1}
          onClose={() => setPreviewPdfModal(null)}
        />
      )}

      {/* Admin Quick Upload PDF to Lecture Modal */}
      {showUploadPdfModal && (
        <UploadPdfModal
          isOpen={showUploadPdfModal}
          onClose={() => {
            setShowUploadPdfModal(false);
            setUploadPdfTargetLecture(null);
          }}
          targetLecture={uploadPdfTargetLecture}
          availableLectures={lectures}
          onSuccess={(updatedLect) => {
            onRefresh();
            setFeedbackMsg(
              `PDF successfully attached to lecture "${updatedLect.title}".`
            );
          }}
        />
      )}

      {/* Admin Reset User Lecture Progress Modal */}
      {resetUserModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4"
        >
          <div className="bg-white rounded-xl max-w-lg w-full p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2.5 text-amber-600">
                <div className="p-2 bg-amber-50 rounded-lg">
                  <RotateCcw className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    Reset Lecture Progress
                  </h3>
                  <p className="text-xs text-slate-500">
                    User: {resetUserModal.name} ({resetUserModal.email})
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setResetUserModal(null);
                  setSelectedLectureForReset(null);
                }}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <label className="block text-xs font-semibold text-slate-700">
                Select Lecture to Reset:
              </label>
              {lectures.length === 0 ? (
                <p className="text-xs text-slate-500 italic">No lectures available.</p>
              ) : (
                <select
                  value={selectedLectureForReset ?? ''}
                  onChange={(e) =>
                    setSelectedLectureForReset(Number(e.target.value) || null)
                  }
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white"
                >
                  <option value="">-- Choose a Lecture --</option>
                  {lectures.map((l: any) => (
                    <option key={l.id} value={l.id}>
                      {l.subjectTitle ? `[${l.subjectTitle}] ` : ''}Lecture {l.lectureNumber}: {l.title} (ID: {l.id})
                    </option>
                  ))}
                </select>
              )}

              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 space-y-1">
                <p className="font-semibold">What will this do?</p>
                <p className="text-amber-800">
                  This will completely clear this student&rsquo;s submitted answers, score history, and active sessions for this lecture. When the user opens the lecture again, they will start fresh from Question 1.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                type="button"
                disabled={isResettingUserLecture}
                onClick={() => {
                  setResetUserModal(null);
                  setSelectedLectureForReset(null);
                }}
                className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isResettingUserLecture || !selectedLectureForReset}
                onClick={async () => {
                  if (!selectedLectureForReset) return;
                  try {
                    setIsResettingUserLecture(true);
                    const res = await api.resetUserLectureProgressAdmin(
                      resetUserModal.uid,
                      selectedLectureForReset
                    );
                    setFeedbackMsg(res.message);
                    setResetUserModal(null);
                    setSelectedLectureForReset(null);
                    onRefresh();
                  } catch (err: any) {
                    setErrorMsg(err.message || 'Failed to reset user lecture progress.');
                  } finally {
                    setIsResettingUserLecture(false);
                  }
                }}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50 cursor-pointer"
              >
                {isResettingUserLecture ? 'Resetting...' : 'Confirm Reset Progress'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
