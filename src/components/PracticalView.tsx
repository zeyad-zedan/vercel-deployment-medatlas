import React,{useEffect,useState} from 'react';
import {useLectureLinkId,useScrollToLecture} from '../lib/use-lecture-link.ts';
import {catalogByContentType} from '../lib/lecture-kinds.ts';
import {PdfViewerModal} from './PdfViewerModal.tsx';
import {ChevronDown} from 'lucide-react';
export default function PracticalView({catalog,dashboardData,onStartSession,onShortAnswers,initialSelectedSubjectId,onOpenSession}:{catalog:any;dashboardData:any;onStartSession:(params:any)=>void;onShortAnswers?:(id:number)=>void;initialSelectedSubjectId?:number|'all';onOpenSession?:(id:number)=>void}) {
 const subjects=catalogByContentType(catalog,'practical').subjects;
 const [search,setSearch]=useState(''),[pdf,setPdf]=useState<any>(null);
 const [restartSectionId,setRestartSectionId]=useState<number|null>(null);
 const linkedLectureId=useLectureLinkId();
 const linkedSubjectId=subjects.find((subject:any)=>subject.lectures.some((lecture:any)=>lecture.id===linkedLectureId))?.id;
 useEffect(()=>{if(linkedLectureId||typeof initialSelectedSubjectId==='number')setSearch('');},[linkedLectureId,initialSelectedSubjectId]);
 useScrollToLecture(linkedLectureId,Boolean(linkedSubjectId&&!search.trim()));
 const query=search.trim().toLocaleLowerCase();
 const visible=subjects.map((subject:any)=>({...subject,lectures:subject.lectures.filter((section:any)=>`${subject.title} ${section.title}`.toLocaleLowerCase().includes(query))})).filter((subject:any)=>subject.lectures.length);
 const button='inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed';
 return <div className="ma-library space-y-5"><header><h1 className="text-2xl font-bold text-slate-900">Practical</h1><p className="text-sm text-slate-600 mt-2">Open a section quiz with MCQs, matching and short-answer questions together.</p></header>
  <label className="block text-sm font-semibold text-slate-700">Search sections<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by subject or section…" className="mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-3 font-normal"/></label>
  {!visible.length&&<div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-600">{subjects.length?'No sections match your search.':'No practical sections have been published yet.'}</div>}
  {visible.map((subject:any)=><details key={subject.id} className="ma-subject" open={query||subject.id===(linkedSubjectId??initialSelectedSubjectId)?true:undefined}><summary className="ma-subject-summary"><span className="ma-subject-heading"><span className="ma-subject-title">{subject.title}</span><span className="ma-subject-meta">{subject.lectures.length} section{subject.lectures.length===1?'':'s'}</span></span><ChevronDown className="ma-subject-chevron" size={19} aria-hidden="true"/></summary><div className="ma-subject-body space-y-4">{[...subject.lectures].sort((a:any,b:any)=>a.lectureNumber-b.lectureNumber||a.id-b.id).map((section:any)=>{
   const progress=dashboardData?.subjectProgress?.find((row:any)=>row.subjectId===subject.id)?.lectures?.find((row:any)=>row.lectureId===section.id),completed=progress?.uniqueQuestionsAttempted??section.attemptedQuestions??0,total=section.questionCount||0;
   return <article key={section.id} id={`lecture-${section.id}`} className="ma-lecture-card space-y-3 scroll-mt-24"><p className="text-xs font-semibold text-[var(--ma-brand)]">Section {section.lectureNumber}</p><h2 className="text-lg font-bold text-slate-900">{section.title}</h2>{section.description&&<p className="text-sm text-slate-600">{section.description}</p>}<p className="text-sm text-slate-600">{completed}/{total} questions answered · {section.shortAnswerCount||0} short-answer question{section.shortAnswerCount===1?'':'s'}</p>
    <div className="flex flex-wrap gap-3">
     <button className={button+' bg-[var(--ma-brand)] text-white border-transparent'} disabled={!total} onClick={()=>progress?.activeSessionId&&onOpenSession?onOpenSession(progress.activeSessionId):onStartSession({mode:'study',lectureIds:[section.id],title:`${section.title} — Section study`})}>{completed||progress?.activeSessionId?'Continue section':'Start section'}</button>
     <button type="button" className={button} disabled={!total} onClick={()=>setRestartSectionId(section.id)}>Restart session</button>
     <button type="button" className={button} disabled={!progress?.reviewSessionId||!onOpenSession} title={progress?.reviewSessionId?'Open your saved attempt':'Your saved answers will appear here after you answer a question.'} onClick={()=>onOpenSession?.(progress.reviewSessionId)}>Review answers</button>
     {section.pdfUrl&&<button className={button} onClick={()=>setPdf({url:section.pdfUrl,title:section.title})}>Open Section PDF</button>}
    </div>
    {restartSectionId===section.id&&<div role="group" aria-label="Confirm section restart" className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3"><p className="text-sm text-slate-700">Start a fresh attempt from question 1? Your previous answers, grades, progress and bookmarks will stay saved.</p><div className="flex flex-wrap gap-2"><button type="button" className={button+' bg-[var(--ma-brand)] text-white border-transparent'} onClick={()=>{setRestartSectionId(null);onStartSession({mode:'study',lectureIds:[section.id],requestedCount:total,title:`${section.title} — Fresh attempt`});}}>Start fresh attempt</button><button type="button" className={button} onClick={()=>setRestartSectionId(null)}>Cancel</button></div></div>}
    {!total&&!section.shortAnswerCount&&<p className="text-xs text-slate-500">Questions will appear here once they are published.</p>}</article>;
  })}</div></details>)}
  {pdf&&<PdfViewerModal pdfUrl={pdf.url} title={pdf.title} onClose={()=>setPdf(null)}/>}
 </div>;
}
