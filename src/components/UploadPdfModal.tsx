import React, { useState, useRef } from 'react';
import {
  X,
  Upload,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Eye,
  ExternalLink,
  ArrowRight,
} from 'lucide-react';
import { api } from '../lib/api.ts';
import { PdfViewerModal } from './PdfViewerModal.tsx';

export interface UploadPdfModalProps {
  isOpen: boolean;
  onClose: () => void;
  // If provided, targets this lecture; otherwise user can select from `availableLectures`
  targetLecture?: {
    id: number;
    title: string;
    subjectTitle?: string;
    lectureNumber?: number;
    pdfUrl?: string | null;
  } | null;
  availableLectures?: Array<{
    id: number;
    title: string;
    subjectTitle?: string;
    lectureNumber?: number;
    pdfUrl?: string | null;
  }>;
  onSuccess?: (updatedLecture: any) => void;
}

export const UploadPdfModal: React.FC<UploadPdfModalProps> = ({
  isOpen,
  onClose,
  targetLecture,
  availableLectures = [],
  onSuccess,
}) => {
  const [selectedLectureId, setSelectedLectureId] = useState<number>(() => {
    return targetLecture?.id || (availableLectures[0]?.id ?? 0);
  });

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<{
    url: string;
    fileName: string;
    lectureTitle: string;
  } | null>(null);

  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [manualUrl, setManualUrl] = useState('');
  const [useManualUrl, setUseManualUrl] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Update selectedLectureId when targetLecture changes
  React.useEffect(() => {
    if (targetLecture?.id) {
      setSelectedLectureId(targetLecture.id);
    } else if (availableLectures.length > 0 && !selectedLectureId) {
      setSelectedLectureId(availableLectures[0].id);
    }
    setSelectedFile(null);
    setErrorMsg(null);
    setSuccessInfo(null);
  }, [targetLecture, isOpen]);

  if (!isOpen) return null;

  // Find active lecture
  const currentLecture =
    (targetLecture && targetLecture.id === selectedLectureId ? targetLecture : null) ||
    availableLectures.find((l) => l.id === selectedLectureId) ||
    targetLecture;

  const handleFileSelect = (file: File) => {
    setErrorMsg(null);
    setSuccessInfo(null);

    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setErrorMsg('Invalid file format. Please select a valid PDF file (.pdf).');
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      setErrorMsg(
        `File is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum allowed size is 50 MB.`
      );
      return;
    }

    setSelectedFile(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentLecture || !currentLecture.id) {
      setErrorMsg('Please select a target lecture.');
      return;
    }

    if (!useManualUrl && !selectedFile) {
      setErrorMsg('Please choose a PDF file to upload.');
      return;
    }

    if (useManualUrl && !manualUrl.trim()) {
      setErrorMsg('Please enter a valid PDF URL.');
      return;
    }

    setIsUploading(true);
    setErrorMsg(null);

    try {
      if (useManualUrl) {
        const res = await api.attachPdfToLecture(currentLecture.id, manualUrl.trim());
        setSuccessInfo({
          url: res.url || manualUrl.trim(),
          fileName: manualUrl.trim().split('/').pop() || 'lecture.pdf',
          lectureTitle: res.lecture?.title || currentLecture.title,
        });
        if (onSuccess) onSuccess(res.lecture);
      } else if (selectedFile) {
        const res = await api.attachPdfToLecture(currentLecture.id, selectedFile);
        setSuccessInfo({
          url: res.url || `/lectures/${selectedFile.name}`,
          fileName: selectedFile.name,
          lectureTitle: res.lecture?.title || currentLecture.title,
        });
        if (onSuccess) onSuccess(res.lecture);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to attach PDF to lecture.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleResetForAnother = () => {
    setSelectedFile(null);
    setSuccessInfo(null);
    setErrorMsg(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-pdf-modal-title"
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto"
      >
        <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-200 space-y-5 animate-in fade-in duration-200">
          {/* Header */}
          <div className="flex items-start justify-between border-b border-slate-100 pb-3.5">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-sky-50 text-[#0284C7] border border-sky-100">
                <Upload className="w-5 h-5" />
              </div>
              <div>
                <h3 id="upload-pdf-modal-title" className="text-base font-bold text-slate-900">
                  Upload PDF to Lecture
                </h3>
                <p className="text-xs text-slate-500">
                  Attach or update slide decks &amp; study notes for generated lectures
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isUploading}
              aria-label="Close dialog"
              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2.5"
            >
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <div className="flex-1 font-medium">{errorMsg}</div>
            </div>
          )}

          {successInfo ? (
            /* Success State */
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-2">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                  <span className="font-bold text-sm text-emerald-950">
                    PDF Attached Successfully!
                  </span>
                </div>
                <p className="text-emerald-800 text-xs">
                  Document <strong>&ldquo;{successInfo.fileName}&rdquo;</strong> has been uploaded and
                  permanently attached to lecture <strong>&ldquo;{successInfo.lectureTitle}&rdquo;</strong>.
                  Students can now view these slides in the study interface and PDF reader.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowPreviewModal(true)}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] rounded-xl transition-colors cursor-pointer shadow-xs"
                >
                  <Eye className="w-4 h-4" />
                  <span>Preview Attached PDF</span>
                </button>
                <button
                  type="button"
                  onClick={handleResetForAnother}
                  className="px-4 py-2.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer"
                >
                  Upload Another File
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-xl transition-colors cursor-pointer"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            /* Upload Form */
            <form onSubmit={handleSubmit} className="space-y-4 text-xs">
              {/* Target Lecture Selector */}
              <div>
                <label htmlFor="target-lecture-select" className="block font-semibold text-slate-700 mb-1.5">
                  Target Lecture
                </label>
                {availableLectures.length > 0 && !targetLecture ? (
                  <select
                    id="target-lecture-select"
                    value={selectedLectureId}
                    onChange={(e) => {
                      setSelectedLectureId(Number(e.target.value));
                      setSelectedFile(null);
                      setErrorMsg(null);
                    }}
                    className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#0284C7]"
                  >
                    {availableLectures.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.subjectTitle ? `[${l.subjectTitle}] ` : ''}
                        {l.lectureNumber ? `Lecture ${l.lectureNumber}: ` : ''}
                        {l.title} {l.pdfUrl ? '(Has PDF)' : '(No PDF)'}
                      </option>
                    ))}
                  </select>
                ) : currentLecture ? (
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-slate-900 truncate">
                        {currentLecture.subjectTitle ? `${currentLecture.subjectTitle} → ` : ''}
                        {currentLecture.title}
                      </p>
                      <p className="text-[11px] text-slate-500 font-mono-tabular">
                        Lecture ID: #{currentLecture.id}
                        {currentLecture.lectureNumber ? ` · Lecture #${currentLecture.lectureNumber}` : ''}
                      </p>
                    </div>
                    {currentLecture.pdfUrl ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 shrink-0">
                        <CheckCircle2 className="w-3 h-3" />
                        Existing PDF Attached
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 shrink-0">
                        No PDF Attached
                      </span>
                    )}
                  </div>
                ) : null}
              </div>

              {/* Upload mode toggle */}
              <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
                <span>Upload PDF file from disk or specify a URL:</span>
                <button
                  type="button"
                  onClick={() => {
                    setUseManualUrl(!useManualUrl);
                    setErrorMsg(null);
                  }}
                  className="font-semibold text-[#0284C7] hover:underline cursor-pointer"
                >
                  {useManualUrl ? 'Switch to File Upload' : 'Enter existing PDF URL'}
                </button>
              </div>

              {useManualUrl ? (
                <div>
                  <label htmlFor="manual-pdf-url" className="block font-semibold text-slate-700 mb-1">
                    Direct PDF URL / Path
                  </label>
                  <input
                    id="manual-pdf-url"
                    type="text"
                    value={manualUrl}
                    onChange={(e) => setManualUrl(e.target.value)}
                    placeholder="e.g. /lectures/my-custom-lecture.pdf"
                    className="w-full px-3 py-2 text-xs font-mono rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#0284C7]"
                  />
                  <p className="text-[11px] text-slate-400 mt-1">
                    Enter a relative path or HTTPS URL pointing to a valid PDF document.
                  </p>
                </div>
              ) : (
                /* Drag & Drop File Upload Area */
                <div>
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDragOver(true);
                    }}
                    onDragLeave={() => setIsDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-2xl p-6 text-center cursor-pointer transition-all ${
                      isDragOver
                        ? 'border-[#0284C7] bg-sky-50/60'
                        : selectedFile
                        ? 'border-emerald-300 bg-emerald-50/30'
                        : 'border-slate-300 hover:border-slate-400 bg-slate-50/50 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,application/pdf"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFileSelect(file);
                      }}
                      className="hidden"
                    />

                    {selectedFile ? (
                      <div className="space-y-1.5">
                        <div className="w-10 h-10 mx-auto rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
                          <FileText className="w-5 h-5" />
                        </div>
                        <p className="font-bold text-slate-900 text-xs truncate max-w-xs mx-auto">
                          {selectedFile.name}
                        </p>
                        <p className="text-[11px] text-slate-500 font-mono-tabular">
                          {(selectedFile.size / 1024).toFixed(0)} KB · Ready to attach
                        </p>
                        <span className="text-[11px] text-[#0284C7] font-semibold hover:underline block pt-1">
                          Click to select a different file
                        </span>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="w-10 h-10 mx-auto rounded-full bg-sky-100 text-[#0284C7] flex items-center justify-center">
                          <Upload className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="font-bold text-slate-800 text-xs">
                            Click to browse or drag and drop your PDF here
                          </p>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            Standard PDF format (.pdf) up to 50 MB
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Modal Action Buttons */}
              <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  disabled={isUploading}
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUploading || (!useManualUrl && !selectedFile) || (useManualUrl && !manualUrl.trim())}
                  className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-[#0284C7] hover:bg-[#0369A1] disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-xs cursor-pointer"
                >
                  {isUploading ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>Uploading to Lecture...</span>
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      <span>{currentLecture?.pdfUrl ? 'Replace & Save PDF' : 'Upload & Attach PDF'}</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      {showPreviewModal && successInfo && (
        <PdfViewerModal
          pdfUrl={successInfo.url}
          lectureTitle={successInfo.lectureTitle}
          initialPage={1}
          onClose={() => setShowPreviewModal(false)}
        />
      )}
    </>
  );
};
