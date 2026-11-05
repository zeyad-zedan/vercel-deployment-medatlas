import React,{useEffect,useState} from 'react';
import {api} from '../lib/api.ts';
import {QuestionImages} from './QuestionImages.tsx';
import {useQuizTextSaves} from '../lib/quiz-text-drafts.tsx';

export function ShortAnswerQuestion({question,sessionId,exam=false,completed=false,disabled=false,onSaved}:{question:any;sessionId:number;exam?:boolean;completed?:boolean;disabled?:boolean;onSaved:(result:any)=>void}){
 const textSaves=useQuizTextSaves();
 const key=`medatlas_quiz_short_${sessionId}_${question.id}`;
 const [attempt,setAttempt]=useState(question.shortAnswerAttempt||null),[answer,setAnswer]=useState(()=>{try{return !completed?(localStorage.getItem(key)??question.shortAnswerAttempt?.answer??''):question.shortAnswerAttempt?.answer??'';}catch{return question.shortAnswerAttempt?.answer||'';}});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{setAttempt(question.shortAnswerAttempt||null);},[question.shortAnswerAttempt]);
 const same=attempt?.answer===answer.trim().normalize('NFC'),grade=same&&(!exam||completed)?attempt?.result:null;
 const button='px-4 py-2 rounded-lg border border-slate-300 text-sm disabled:opacity-50 disabled:cursor-not-allowed';
 const submit=async(grading:boolean)=>{
  if(busy||!answer.trim())return;setBusy(true);setError('');setNotice('');
  try{
   let saved:any;
   if(!completed){saved=await api.saveQuizShortAnswer(sessionId,question.id,answer);setAttempt(saved.attempt);onSaved(saved);textSaves.acknowledge(question.id,answer);try{localStorage.removeItem(key);}catch{}setNotice('Answer saved in this quiz.');}
   if(grading){const result=await api.gradeQuizShortAnswer(sessionId,question.id);setAttempt(result.attempt);onSaved(result);setNotice(result.attempt.status==='graded'?'Grade saved.':result.attempt.error||'Your answer is saved. Grading has not finished; retry shortly.');}
  }catch(e:any){setError(e.message||'Could not save. Your typed answer remains on this device.');}finally{setBusy(false);}
 };
 return <section aria-label="Short-answer question" className="space-y-4">
  <div><p className="text-xs font-semibold text-[var(--ma-brand)]">Short answer · {question.maxMarks||1} marks</p><h2 className="ma-question-stem font-serif-academic mt-2">{question.questionText}</h2></div>
  <QuestionImages images={question.images||[]}/>
  <label className="block text-sm font-semibold" htmlFor={`short-answer-${question.id}`}>Your answer</label>
  <textarea id={`short-answer-${question.id}`} value={answer} disabled={busy||completed||disabled} maxLength={4000} rows={5} className="w-full rounded-lg border border-slate-300 bg-white p-3 text-sm disabled:bg-slate-50" placeholder="Write your answer…" onChange={event=>{setAnswer(event.target.value);textSaves.remember(question.id,event.target.value);try{localStorage.setItem(key,event.target.value);}catch{}}}/>
  {!completed&&<p className="text-xs text-slate-500">Typing stays on this device. Save answer stores it in your quiz, even without a Gemini key.</p>}
  {exam&&!completed?<p className="text-xs text-slate-500">Grading and the model answer become available after you submit the exam.</p>:!grade&&<p className="text-xs text-slate-500">Grading uses your saved Gemini key and sends your answer and marking guide to Google. Images are not sent.</p>}
  <div className="flex flex-wrap gap-3">{!completed&&<button className={button} disabled={busy||!answer.trim()} onClick={()=>submit(false)}>{busy?'Working…':'Save answer'}</button>}{(!exam||completed)&&!grade&&<button className={button+' bg-[var(--ma-brand)] text-white border-transparent'} disabled={busy||!answer.trim()||completed&&!attempt} onClick={()=>submit(true)}>{attempt?.status==='failed'?'Retry grading':completed?'Grade saved answer':'Save & grade'}</button>}</div>
  {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}{notice&&<p role="status" className="text-sm text-emerald-800">{notice}</p>}
  {grade&&<section aria-label="Short-answer feedback" className="border-t border-slate-200 pt-4 space-y-3"><h3 className="font-bold">{grade.score}/{grade.maxScore} marks</h3><p className="text-sm text-slate-600">{grade.feedback}</p>{grade.points.map((point:any)=><div key={point.id} className="text-sm border-b border-slate-100 pb-2"><p className="font-medium">{point.description} · {point.awarded}/{point.marks}</p><p className="text-slate-600">{point.feedback}</p></div>)}<details><summary className="text-sm font-semibold cursor-pointer">Model answer</summary><p className="mt-2 whitespace-pre-wrap text-sm">{attempt.modelAnswer}</p></details><p className="text-xs text-slate-500">AI practice feedback · Check uncertain feedback with your instructor.</p></section>}
 </section>;
}

export function QuizMarks({score}:{score:any}){return score?.shortAnswerCount?<p role="status" className="text-sm text-slate-600">Quiz marks: <strong>{score.earnedMarks}/{score.maxMarks}</strong>{score.pendingGradingCount?` · Provisional: ${score.pendingGradingCount} saved answer(s) awaiting grading`:''}{score.partiallyCorrectCount?` · ${score.partiallyCorrectCount} partially correct`:''}</p>:null;}
