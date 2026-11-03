import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCcw, FileText, X, AlertCircle, Maximize2, Presentation, Loader2 } from 'lucide-react';
import { getAuthToken } from '../lib/api.ts';

interface PdfCanvasViewerProps {
  pdfUrl: string;
  pageNumber: number;
  zoomPercent: number;
  onTotalPagesResolved?: (total: number) => void;
  className?: string;
}

// This client only receives watermarked images. Original PDF bytes, PDF.js,
// Telegram credentials, and source file URLs stay on the server.
export const PdfCanvasViewer: React.FC<PdfCanvasViewerProps> = ({pdfUrl, pageNumber, zoomPercent, onTotalPagesResolved, className = ''}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const totalCallback = useRef(onTotalPagesResolved);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [resolvedReference, setResolvedReference] = useState<string | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => { totalCallback.current = onTotalPagesResolved; }, [onTotalPagesResolved]);

  const documentRequest = useCallback(async (url: string, signal: AbortSignal) => {
    const token = getAuthToken();
    if (!token) throw new Error('Please sign in to view this lecture.');
    if (!/^\/api\/documents\/[A-Za-z0-9_-]+(?:\/pages\/[1-9]\d*)?$/.test(url)) {
      throw new Error('Reopen this lecture from the Lectures page to load its protected viewer.');
    }
    const response = await fetch(url, {signal, cache:'no-store', credentials:'same-origin', headers:{Authorization:`Bearer ${token}`}});
    if (!response.ok) {
      const body = await response.json().catch(()=>null);
      throw new Error(body?.error || 'This page could not be loaded. Please retry.');
    }
    return response;
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setTotalPages(null); setResolvedReference(null); setError(null); setLoading(true); setImage(null);
    documentRequest(pdfUrl, abort.signal).then(r=>r.json()).then(meta=>{
      if (!Number.isInteger(meta.totalPages) || meta.totalPages < 1) throw new Error('Document information is unavailable.');
      if (!abort.signal.aborted) { setTotalPages(meta.totalPages); setResolvedReference(pdfUrl); totalCallback.current?.(meta.totalPages); }
    }).catch(err=>{if (!abort.signal.aborted) {setError(err.message);setLoading(false);}});
    return ()=>abort.abort();
  }, [pdfUrl, documentRequest, retry]);

  useEffect(() => {
    if (!totalPages || resolvedReference !== pdfUrl) return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    const targetPage = Math.min(Math.max(1, pageNumber), totalPages);
    setLoading(true); setError(null); setImage(null);
    documentRequest(`${pdfUrl}/pages/${targetPage}`, abort.signal).then(async response=>{
      if (response.headers.get('content-type')?.split(';')[0] !== 'image/webp') throw new Error('Invalid page preview.');
      const blob = await response.blob();
      if (abort.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      const preview = new Image();
      preview.onload=()=>{if (!abort.signal.aborted) {setImage(preview);setLoading(false);} if(objectUrl)URL.revokeObjectURL(objectUrl);};
      preview.onerror=()=>{if (!abort.signal.aborted) {setError('Page preview could not be displayed.');setLoading(false);} if(objectUrl)URL.revokeObjectURL(objectUrl);};
      preview.src=objectUrl;
    }).catch(err=>{if (!abort.signal.aborted) {setError(err.message);setLoading(false);}});
    return ()=>{abort.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  }, [pdfUrl, pageNumber, totalPages, resolvedReference, documentRequest]);

  useEffect(() => {
    const container=containerRef.current;
    const canvas=canvasRef.current;
    if(!container||!canvas||!image)return;
    const draw=()=>{
      const width=Math.max(240, container.clientWidth-32)*(zoomPercent/100);
      const height=width*image.naturalHeight/image.naturalWidth;
      const ratio=Math.min(window.devicePixelRatio||1,2);
      canvas.width=Math.round(width*ratio); canvas.height=Math.round(height*ratio);
      canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;
      const context=canvas.getContext('2d');
      if(context){context.setTransform(ratio,0,0,ratio,0,0);context.drawImage(image,0,0,width,height);}
    };
    draw();
    const observer=new ResizeObserver(draw);observer.observe(container);
    return ()=>observer.disconnect();
  },[image,zoomPercent]);

  return <div ref={containerRef} className={`ma-document-surface w-full h-full min-h-0 relative overflow-auto bg-slate-950 flex flex-col items-center p-3 sm:p-4 select-none ${className}`} onContextMenu={event=>event.preventDefault()}>
    {error?<div role="alert" className="my-auto max-w-md p-8 text-center space-y-4"><AlertCircle className="mx-auto w-9 h-9 text-rose-400"/><h4 className="text-sm font-bold text-white">Page unavailable</h4><p className="text-xs text-slate-300">{error}</p><button type="button" onClick={()=>setRetry(value=>value+1)} className="rounded-lg bg-white px-4 py-2 text-xs font-semibold text-slate-900">Retry page</button></div>:
      loading?<div role="status" className="my-auto p-8 text-center space-y-3"><Loader2 className="mx-auto w-8 h-8 text-emerald-300 animate-spin"/><p className="text-xs text-slate-300">Preparing your protected page…</p></div>:
      <canvas ref={canvasRef} role="img" aria-label={`Lecture page ${pageNumber} of ${totalPages}. Personal study preview.`} onDragStart={event=>event.preventDefault()} className="my-auto shrink-0 rounded-lg bg-white shadow-2xl"/>}
  </div>;
};

interface PdfViewerModalProps {
  isOpen?: boolean;
  onClose: () => void;
  pdfUrl?: string | null;
  initialPage?: number | null;
  title?: string;
  lectureTitle?: string;
  totalEstimatedPages?: number;
}

export const PdfViewerModal: React.FC<PdfViewerModalProps> = ({
  isOpen = true,
  onClose,
  pdfUrl,
  initialPage = 1,
  title,
  lectureTitle,
}) => {
  const displayTitle = title || lectureTitle || 'Lecture PDF Document';
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageInput, setPageInput] = useState<string>('1');
  const [zoomPercent, setZoomPercent] = useState<number>(100);
  const [totalPages, setTotalPages] = useState<number | null>(null);

  const handleTotalPages = useCallback((total: number) => {
    setTotalPages((prev) => (prev === total ? prev : total));
  }, []);

  useEffect(() => {
    if (isOpen) {
      const startPage =
        initialPage && Number.isInteger(Number(initialPage)) && Number(initialPage) > 0
          ? Number(initialPage)
          : 1;
      setCurrentPage(startPage);
      setPageInput(String(startPage));
    }
  }, [isOpen, initialPage]);

  useEffect(() => {
    setTotalPages(null);
    setZoomPercent(100);
  }, [pdfUrl]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handlePageChange = (newPage: number) => {
    let valid = Math.max(1, Math.floor(newPage));
    if (totalPages && valid > totalPages) valid = totalPages;
    setCurrentPage(valid);
    setPageInput(String(valid));
  };

  const handlePageInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInt(pageInput, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      handlePageChange(parsed);
    } else {
      setPageInput(String(currentPage));
    }
  };

  const handleZoom = (delta: number) => {
    setZoomPercent((prev) => Math.min(250, Math.max(40, prev + delta)));
  };

  const cleanPdfUrl = pdfUrl?.trim() || null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pdf-viewer-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 backdrop-blur-xs p-2 sm:p-4 lg:p-6 animate-fadeIn"
    >
      <div className="relative w-full max-w-6xl h-[92vh] sm:h-[88vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
        {/* Top Header & Toolbar */}
        <div className="bg-slate-900 text-white px-4 py-3 sm:px-6 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 shrink-0">
          {/* Title Area */}
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-sky-500/20 text-sky-400 flex items-center justify-center shrink-0">
              <FileText className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="pdf-viewer-title"
                className="text-sm sm:text-base font-bold text-white truncate"
              >
                {displayTitle}
              </h2>
              <p className="text-[11px] text-slate-400 font-mono-tabular">
                Lecture Reference · Showing Slide {currentPage}
                {totalPages ? ` of ${totalPages}` : ''}
              </p>
            </div>
          </div>

          {/* Navigation & Zoom Controls */}
          {cleanPdfUrl && (
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              {/* Page Navigator */}
              <div className="flex items-center bg-slate-800 rounded-lg p-1 border border-slate-700">
                <button
                  type="button"
                  aria-label="Previous Page"
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage <= 1}
                  className="p-1 rounded text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent transition-colors cursor-pointer"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>

                <form onSubmit={handlePageInputSubmit} className="flex items-center px-1.5 gap-1">
                  <span className="text-xs text-slate-400 font-sans">Slide</span>
                  <input
                    type="number"
                    min="1"
                    max={totalPages || undefined}
                    aria-label="Slide number"
                    value={pageInput}
                    onChange={(e) => setPageInput(e.target.value)}
                    onBlur={() => {
                      const parsed = parseInt(pageInput, 10);
                      if (!Number.isNaN(parsed) && parsed > 0) {
                        handlePageChange(parsed);
                      } else {
                        setPageInput(String(currentPage));
                      }
                    }}
                    className="w-12 h-6 text-center text-xs font-mono-tabular font-bold bg-slate-900 border border-slate-700 text-white rounded focus:outline-hidden focus:border-sky-500"
                  />
                  {totalPages && (
                    <span className="text-xs text-slate-400 font-mono-tabular">
                      / {totalPages}
                    </span>
                  )}
                </form>

                <button
                  type="button"
                  aria-label="Next Page"
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={Boolean(totalPages && currentPage >= totalPages)}
                  className="p-1 rounded text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent transition-colors cursor-pointer"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Zoom Controls */}
              <div className="hidden sm:flex items-center bg-slate-800 rounded-lg p-1 border border-slate-700 text-xs">
                <button
                  type="button"
                  onClick={() => handleZoom(-15)}
                  disabled={zoomPercent <= 40}
                  className="p-1 rounded text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-40 cursor-pointer"
                  title="Zoom Out"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <span className="px-2 text-xs font-mono-tabular text-slate-300 min-w-[42px] text-center">
                  {zoomPercent}%
                </span>
                <button
                  type="button"
                  onClick={() => handleZoom(15)}
                  disabled={zoomPercent >= 250}
                  className="p-1 rounded text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-40 cursor-pointer"
                  title="Zoom In"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setZoomPercent(100)}
                  className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-700 cursor-pointer"
                  title="Reset Zoom (100%)"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Open in New Tab Link */}

            </div>
          )}

          {/* Close Button */}
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body with Native Canvas Renderer */}
        <div className="flex-1 bg-slate-950 relative min-h-0 flex flex-col">
          {cleanPdfUrl ? (
            <PdfCanvasViewer
              pdfUrl={cleanPdfUrl}
              pageNumber={currentPage}
              zoomPercent={zoomPercent}
              onTotalPagesResolved={handleTotalPages}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3 bg-white">
              <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center">
                <AlertCircle className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold text-slate-900">
                No Lecture PDF Attached
              </h3>
              <p className="text-xs text-slate-600 max-w-sm">
                A PDF reference has not yet been configured for this lecture. Administrators can add PDF files via the Admin Console.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
              >
                Close Viewer
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Inline Slide Viewer (Used during Study Mode & Practice)                     */
/* -------------------------------------------------------------------------- */
export interface PdfSlideViewerProps {
  pdfUrl?: string | null;
  initialPage?: number | null;
  title?: string;
  lectureTitle?: string;
  onClose?: () => void;
  containerHeightClass?: string;
  onExpandToModal?: () => void;
}

export const PdfSlideViewer: React.FC<PdfSlideViewerProps> = ({
  pdfUrl,
  initialPage = 1,
  title = 'Lecture Slide Reference',
  onClose,
  containerHeightClass,
  onExpandToModal,
}) => {
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageInput, setPageInput] = useState<string>('1');
  const [zoomPercent, setZoomPercent] = useState<number>(100);
  const [totalPages, setTotalPages] = useState<number | null>(null);

  const handleTotalPages = useCallback((total: number) => {
    setTotalPages((prev) => (prev === total ? prev : total));
  }, []);

  useEffect(() => {
    const startPage =
      initialPage && Number.isInteger(Number(initialPage)) && Number(initialPage) > 0
        ? Number(initialPage)
        : 1;
    setCurrentPage(startPage);
    setPageInput(String(startPage));
  }, [initialPage]);

  useEffect(() => {
    setTotalPages(null);
    setZoomPercent(100);
  }, [pdfUrl]);

  const handlePageChange = (newPage: number) => {
    let valid = Math.max(1, Math.floor(newPage));
    if (totalPages && valid > totalPages) valid = totalPages;
    setCurrentPage(valid);
    setPageInput(String(valid));
  };

  const handlePageInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInt(pageInput, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      handlePageChange(parsed);
    } else {
      setPageInput(String(currentPage));
    }
  };

  const handleZoom = (delta: number) => {
    setZoomPercent((prev) => Math.min(250, Math.max(40, prev + delta)));
  };

  const cleanPdfUrl = pdfUrl?.trim() || null;

  return (
    <div className="bg-white rounded-2xl border-2 border-slate-200 shadow-xl flex flex-col overflow-hidden animate-fadeIn">
      {/* Slide Presentation Header Bar */}
      <div className="bg-slate-900 text-white px-4 py-3 sm:px-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0 border border-amber-500/30">
            <Presentation className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-white truncate" title={title}>
                {title}
              </h3>
              <span className="hidden sm:inline-flex px-2 py-0.5 rounded text-[10px] font-bold tracking-wide uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30">
                Slide Reference
              </span>
            </div>
            <p className="text-xs text-slate-400 font-mono-tabular">
              Lecture Slide · Showing Slide {currentPage}
              {totalPages ? ` of ${totalPages}` : ''}
            </p>
          </div>
        </div>

        {/* Toolbar Controls */}
        <div className="flex items-center gap-2 shrink-0">
          {cleanPdfUrl && (
            <>
              {/* Slide Navigator */}
              <div className="flex items-center bg-slate-800 rounded-lg p-0.5 border border-slate-700 text-xs">
                <button
                  type="button"
                  aria-label="Previous Slide"
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage <= 1}
                  className="px-2 py-1 rounded text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-40 transition-colors flex items-center gap-1 cursor-pointer"
                  title="Previous Slide"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span className="hidden md:inline text-[11px] font-medium">Prev</span>
                </button>
                <form onSubmit={handlePageInputSubmit} className="flex items-center px-1.5 gap-1">
                  <span className="text-[11px] text-slate-400 font-sans">Slide</span>
                  <input
                    type="number"
                    min="1"
                    max={totalPages || undefined}
                    aria-label="Slide number"
                    value={pageInput}
                    onChange={(e) => setPageInput(e.target.value)}
                    onBlur={() => {
                      const parsed = parseInt(pageInput, 10);
                      if (!Number.isNaN(parsed) && parsed > 0) {
                        handlePageChange(parsed);
                      } else {
                        setPageInput(String(currentPage));
                      }
                    }}
                    className="w-11 h-6 text-center text-xs font-mono-tabular font-bold bg-slate-900 border border-slate-700 text-white rounded focus:outline-hidden focus:border-amber-500"
                  />
                  {totalPages && (
                    <span className="text-[11px] text-slate-400 font-mono-tabular">
                      / {totalPages}
                    </span>
                  )}
                </form>
                <button
                  type="button"
                  aria-label="Next Slide"
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={Boolean(totalPages && currentPage >= totalPages)}
                  className="px-2 py-1 rounded text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-40 transition-colors flex items-center gap-1 cursor-pointer"
                  title="Next Slide"
                >
                  <span className="hidden md:inline text-[11px] font-medium">Next</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Zoom Controls */}
              <div className="hidden sm:flex items-center bg-slate-800 rounded-lg p-0.5 border border-slate-700 text-xs">
                <button
                  type="button"
                  onClick={() => handleZoom(-15)}
                  disabled={zoomPercent <= 40}
                  className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-40 cursor-pointer"
                  title="Zoom Out"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <span className="px-1.5 text-xs font-mono-tabular text-slate-300 min-w-[42px] text-center">
                  {zoomPercent}%
                </span>
                <button
                  type="button"
                  onClick={() => handleZoom(15)}
                  disabled={zoomPercent >= 250}
                  className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-40 cursor-pointer"
                  title="Zoom In"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setZoomPercent(100)}
                  className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-700 cursor-pointer"
                  title="Reset Zoom (100%)"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Fullscreen Expansion */}
              {onExpandToModal && (
                <button
                  type="button"
                  onClick={onExpandToModal}
                  className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
                  title="Expand to Fullscreen Dialog"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
              )}

              {/* Open in New Tab */}

            </>
          )}

          {/* Close Slide Preview */}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              title="Close Slide Preview"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Native Slide Canvas Viewport */}
      <div className={`w-full ${containerHeightClass || 'h-[540px] sm:h-[620px] lg:h-[700px]'} bg-slate-950 relative min-h-0 flex flex-col`}>
        {cleanPdfUrl ? (
          <PdfCanvasViewer
            pdfUrl={cleanPdfUrl}
            pageNumber={currentPage}
            zoomPercent={zoomPercent}
            onTotalPagesResolved={handleTotalPages}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-2 bg-white">
            <AlertCircle className="w-8 h-8 text-amber-600" />
            <p className="text-sm font-semibold text-slate-800">
              No lecture PDF attached for this lecture
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export const PdfSideViewer = PdfSlideViewer;
export type PdfSideViewerProps = PdfSlideViewerProps;
