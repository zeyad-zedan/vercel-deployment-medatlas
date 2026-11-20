import React,{lazy,Suspense,useEffect,useRef,useState} from 'react';
import {GradeFeedback} from './GradeFeedback.tsx';
import {api} from '../lib/api.ts';
import {QuestionImageProvider,QuestionImages} from './QuestionImages.tsx';
import {destinationLabel} from '../lib/lecture-kinds.ts';
import {useGradingRecovery} from '../lib/use-grading-recovery.ts';
import {clearSavedQuizTextDraft} from '../lib/quiz-text-drafts.tsx';
const GeminiSetupGuide=lazy(()=>import('./GeminiSetupGuide.tsx'));

export default function ShortAnswersView({userUid,initialLectureId}:{userUid:string;initialLectureId?:number}) {
 const [catalog,setCatalog]=useState<any[]>([]),[lecture,setLecture]=useState(0),[questions,setQuestions]=useState<any[]>([]),[cursor,setCursor]=useState<number|null>(null);
 const [selected,setSelected]=useState<any>(null),[answer,setAnswer]=useState(''),[attempt,setAttempt]=useState<any>(null);
 const [history,setHistory]=useState<any[]>([]),[historyCursor,setHistoryCursor]=useState<number|null>(null),[historyOpen,setHistoryOpen]=useState(false);
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [showGuide,setShowGuide]=useState(false),[now,setNow]=useState(Date.now);
 const [scrollToken,setScrollToken]=useState(0);
 const requestRef=useRef(0),busyRef=useRef(false),selectedIdRef=useRef<number|null>(null);
 selectedIdRef.current=selected?.id??null;
 const sameAnswer=attempt?.answer===answer.trim().normalize('NFC'),result=sameAnswer?attempt?.result:null;
 const retryAt=sameAnswer&&attempt?.retryAt?Date.parse(attempt.retryAt):0;
 const rawRetrySeconds=retryAt>now?Math.ceil((retryAt-now)/1000):0;
 const retrySeconds=rawRetrySeconds>60?0:rawRetrySeconds;
 useEffect(()=>{
  if(!retryAt)return;
  const current=Date.now();
  setNow(current);
  if(retryAt<=current)return;
  const timer=window.setInterval(()=>{
   const current=Date.now();
   setNow(current);
   if(current>=retryAt)window.clearInterval(timer);
  },1000);
  return ()=>window.clearInterval(timer);
 },[retryAt]);
 useEffect(()=>{let active=true;api.shortAnswerCatalog().then(data=>{if(active){setCatalog(data.lectures);if(initialLectureId&&data.lectures.some((row:any)=>row.id===initialLectureId)){setLecture(initialLectureId);void load(initialLectureId);}}}).catch(()=>{if(active)setError('Could not load short-answer lectures or sections. Refresh to retry.');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;requestRef.current++;};},[]);
 const load=async(id:number,after?:number)=>{const request=++requestRef.current;setBusy(true);setError('');try{const data=await api.shortAnswerQuestions(id,after);if(request!==requestRef.current)return;setQuestions(old=>after?[...old,...data.questions]:data.questions);setCursor(data.nextCursor);}catch{if(request===requestRef.current)setError('Could not load questions. Try selecting the lecture again.');}finally{if(request===requestRef.current)setBusy(false);}};
 const draftKey=(id:number)=>`medatlas_sa_draft_${userUid}_${id}`;
 const updateAnswer=(text:string)=>{setAnswer(text);try{localStorage.setItem(draftKey(selected.id),text);}catch{}};
 const open=async(q:any)=>{if(busyRef.current)return;setError('');setNotice('');setShowGuide(false);selectedIdRef.current=q.id;setSelected(q);setAttempt(null);setScrollToken(0);let draft:string|null=null;try{draft=localStorage.getItem(draftKey(q.id));}catch{}setAnswer(draft||'');if(q.attempt_id){busyRef.current=true;setBusy(true);try{const data=await api.getShortAnswer(q.attempt_id);if(selectedIdRef.current!==q.id)return;setAttempt(data.attempt);setAnswer(draft??data.attempt.answer);}catch{if(selectedIdRef.current===q.id)setError('Could not load your saved answer.');}finally{setBusy(false);busyRef.current=false;}}};
 const refreshAttempt=async()=>{
  if(!attempt||!selected||busyRef.current)return;
  const targetId=selected.id;
  busyRef.current=true;setBusy(true);setError('');
  try{
   const data=await api.getShortAnswer(attempt.id);
   if(selectedIdRef.current!==targetId)return;
   if(data.attempt?.questionId&&data.attempt.questionId!==targetId)return;
   setAttempt(data.attempt);
   if(data.attempt?.status==='graded')setScrollToken(n=>n+1);
   setQuestions(old=>old.map(q=>q.id===targetId?{...q,status:data.attempt.status,score:data.attempt.result?.score}:q));
  }catch{if(selectedIdRef.current===targetId)setError('Could not refresh your grade.');}finally{setBusy(false);busyRef.current=false;}
 };
 const submit=async(grade:boolean,automatic=false)=>{
  if(!selected||busyRef.current||!answer.trim()||(grade&&!automatic&&retryAt>Date.now()))return;
  const targetId=selected.id,submittedText=answer;
  busyRef.current=true;setBusy(true);setError('');setNotice('');
  if(grade&&!automatic)recovery.start();
  if(!grade)recovery.stop();
  try{
   let currentAttempt=attempt;
   const skipSave=grade&&sameAnswer&&Boolean(attempt?.id)&&(automatic||attempt.status==='failed');
   if(!skipSave){
    const saved=await api.saveShortAnswer(targetId,submittedText);
    if(selectedIdRef.current!==targetId)return;
    currentAttempt=saved.attempt;
    setAttempt(saved.attempt);
    setQuestions(old=>old.map(q=>q.id===targetId?{...q,attempt_id:saved.attempt.id,status:saved.attempt.status,score:saved.attempt.result?.score}:q));
    clearSavedQuizTextDraft(draftKey(targetId),submittedText);
    setNotice('Answer saved to your account.');
   }
   if(grade&&currentAttempt?.id&&currentAttempt.status!=='graded'){
    setNotice(skipSave?'Grading your saved answer…':'Answer saved. Gemini is grading it…');
    const graded=await api.gradeShortAnswer(currentAttempt.id);
    if(selectedIdRef.current!==targetId)return;
    setAttempt(graded.attempt);
    if(graded.attempt.errorCode==='KEY_MISSING'){setShowGuide(true);setNotice('');}
    else{if(graded.attempt.status==='graded')setScrollToken(n=>n+1);setNotice('');}
    setQuestions(old=>old.map(q=>q.id===targetId?{...q,status:graded.attempt.status,score:graded.attempt.result?.score}:q));
   }
  }catch(e:any){if(selectedIdRef.current===targetId){setNotice('');setError(e.message||'Could not complete this request. Your typed answer is kept on this device.');}}finally{setBusy(false);busyRef.current=false;}
 };
 const showHistory=async(before?:number)=>{setBusy(true);setError('');try{const data=await api.shortAnswerHistory(before);setHistory(old=>before?[...old,...data.attempts]:data.attempts);setHistoryCursor(data.nextCursor);setHistoryOpen(true);}catch{setError('Could not load your answer history.');}finally{setBusy(false);}};
 const openHistory=async(row:any)=>{if(busyRef.current)return;setBusy(true);busyRef.current=true;setError('');setShowGuide(false);try{const data=await api.getShortAnswer(row.id);selectedIdRef.current=row.question_id;setSelected({id:row.question_id,question:data.attempt.question});setAnswer(data.attempt.answer);setAttempt(data.attempt);setHistoryOpen(false);}catch{setError('Could not open your answer.');}finally{setBusy(false);busyRef.current=false;}};
 const recovery=useGradingRecovery({contextKey:`${userUid}:${selected?.id||0}`,attempt,
  enabled:sameAnswer&&!busy&&!historyOpen,retry:()=>{void submit(true,true);},poll:()=>{void refreshAttempt();}});
 const button='px-4 py-2 rounded-lg border border-slate-300 text-sm disabled:opacity-50';
 return <QuestionImageProvider questions={[]}><div className="max-w-4xl space-y-5">
  <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-bold text-slate-900">Short Answers</h1><p className="text-sm text-slate-600 mt-1">Write your answer and get feedback against the lecture's marking guide.</p></div><button className={button} disabled={busy} onClick={()=>showHistory()}>My answer history</button></div>
  <p className="text-xs text-slate-500">AI feedback is for practice and may need review. Marks are tracked here separately from MCQ progress. <a className="underline" href="/profile">Manage your Gemini key</a></p>
  {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}{(notice||recovery.waiting)&&<p role="status" className="text-sm text-emerald-800">{recovery.waiting?'Your answer is saved. Grading is busy; retrying automatically shortly.':notice}</p>}
  {loading?<p role="status">Loading lectures…</p>:historyOpen?<section className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><div className="flex justify-between gap-2"><h2 className="font-semibold">Your saved answers</h2><button className={button} disabled={busy} onClick={()=>setHistoryOpen(false)}>Back to practice</button></div>{!history.length&&<p>No answers saved yet.</p>}{history.map(row=><button key={row.id} disabled={busy} onClick={()=>openHistory(row)} className="w-full text-left border-b border-slate-200 py-3"><span className="block font-medium text-sm">{row.question}</span><span className="text-xs text-slate-500">{row.status==='graded'?`${row.score}/${row.max_score} marks`:row.status==='failed'?'Saved · grading needs retry':row.status==='grading'?'Grading':'Saved'} · {new Date(row.created_at).toLocaleDateString()}</span></button>)}{historyCursor&&<button className={button} disabled={busy} onClick={()=>showHistory(historyCursor)}>Load more answers</button>}</section>:<>
   <div><label htmlFor="sa-lecture" className="block text-sm font-semibold mb-2">Lecture or section</label><select id="sa-lecture" className="w-full border border-slate-300 rounded-lg p-3 bg-white text-sm" value={lecture} disabled={busy} onChange={e=>{const id=Number(e.target.value);setLecture(id);setSelected(null);setAttempt(null);setShowGuide(false);setQuestions([]);setCursor(null);if(id)load(id);}}><option value={0}>Choose a lecture or section…</option>{catalog.map(l=><option key={l.id} value={l.id}>{destinationLabel({...l,subjectTitle:l.subject})} ({l.count})</option>)}</select></div>
   {!catalog.length&&<p className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-600">No short-answer questions have been published yet.</p>}
   {selected?<section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"><QuestionImages images={selected.images||attempt?.images||[]}/><div className="flex justify-between gap-3"><h2 className="font-semibold text-lg whitespace-pre-wrap">{selected.question}</h2><button disabled={busy} className={button} onClick={()=>{setSelected(null);setNotice('');setError('');setShowGuide(false);}}>Question list</button></div>
    <label htmlFor="sa-answer" className="block text-sm font-semibold">Your answer</label><textarea id="sa-answer" maxLength={4000} rows={6} disabled={busy} value={answer} onChange={e=>updateAnswer(e.target.value)} className="w-full border border-slate-300 rounded-lg p-3 text-sm" placeholder="Write your answer in your own words…"/>
    <p className="text-xs text-slate-500">{answer.length}/4,000 characters · Unsubmitted typing stays on this device; Save answer stores it in your account.</p>
    {!result&&<p className="text-xs text-slate-500">Grading sends your answer and marking guide to Google. Images are not sent.</p>}
    <div className="flex flex-wrap gap-3"><button className={button} disabled={busy||!answer.trim()} onClick={()=>submit(false)}>Save answer</button><button className={button+' bg-[var(--ma-brand)] text-white border-transparent'} disabled={busy||retrySeconds>0||!answer.trim()||Boolean(result)} onClick={()=>submit(true)}>{busy?'Working…':retrySeconds>0?`Retry in ${retrySeconds}s`:sameAnswer&&attempt?.status==='failed'?'Retry grading':'Save & grade'}</button>{sameAnswer&&attempt?.status==='grading'&&<button className={button} disabled={busy} onClick={refreshAttempt}>Check grading status</button>}</div>
    {sameAnswer&&attempt?.errorCode==='KEY_MISSING'&&!showGuide&&<button type="button" className="text-sm underline text-[var(--ma-brand)]" onClick={()=>setShowGuide(true)}>افتح شرح إضافة مفتاح Gemini</button>}
    {sameAnswer&&attempt?.error&&<p role="alert" className="text-sm text-amber-800">{attempt.error}</p>}
    {result&&<GradeFeedback grade={result} modelAnswer={attempt.modelAnswer} scrollToken={scrollToken} label="Grading feedback"/>}
    {showGuide&&<Suspense fallback={<p role="status">بنجهّزلك الشرح…</p>}><GeminiSetupGuide onClose={()=>setShowGuide(false)} onReady={()=>{setShowGuide(false);void submit(true);}}/></Suspense>}
   </section>:<section className="space-y-3">{questions.map(q=><button disabled={busy} onClick={()=>open(q)} key={q.id} className="w-full text-left bg-white border border-slate-200 rounded-xl p-5"><span className="block font-semibold text-slate-900">{q.question}</span><span className="block text-sm text-slate-500 mt-2">{q.max_score} marks{q.attempt_id?` · ${q.status==='graded'?q.score+'/'+q.max_score+' last score':'Answer saved'}`:''}</span></button>)}{cursor&&<button disabled={busy} className={button} onClick={()=>load(lecture,cursor)}>Load next 6 questions</button>}</section>}
  </>}
 </div></QuestionImageProvider>;
}
