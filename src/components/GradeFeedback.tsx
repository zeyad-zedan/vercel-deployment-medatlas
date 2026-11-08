import React,{useEffect,useRef} from 'react';
import {CheckCircle2,MinusCircle,XCircle} from 'lucide-react';

export function GradeFeedback({grade,modelAnswer,scrollToken=0,label='Short-answer feedback'}:{grade:any;modelAnswer?:string;scrollToken?:number;label?:string}){
 const panel=useRef<HTMLElement>(null);
 useEffect(()=>{
  if(!scrollToken)return;
  const frame=window.setTimeout(()=>panel.current?.scrollIntoView?.({block:'start',behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}));
  return()=>window.clearTimeout(frame);
 },[scrollToken]);
 const percent=grade.maxScore?Math.round(100*grade.score/grade.maxScore):0;
 return <section ref={panel} aria-label={label} className="ma-grade-feedback" tabIndex={-1}>
  <header className="ma-grade-summary"><div><p className="text-sm font-semibold text-[var(--ma-brand)]">Your result</p><h3 className="text-2xl font-bold tabular-nums mt-1">{grade.score}/{grade.maxScore} marks</h3></div><span className="text-lg font-semibold tabular-nums">{percent}%</span></header>
  <div className="ma-grade-body"><p className="text-sm whitespace-pre-wrap leading-relaxed text-slate-700">{grade.feedback}</p>
   <h4 className="text-sm font-semibold mt-5 mb-3">Marking breakdown</h4>
   <div className="space-y-3">{(grade.points||[]).map((point:any)=>{
    const status=point.awarded>=point.marks?'correct':point.awarded>0?'partial':'missed';
    const Icon=status==='correct'?CheckCircle2:status==='partial'?MinusCircle:XCircle;
    return <div key={point.id} className={`ma-grade-point ma-grade-point-${status}`}><Icon size={19} aria-hidden="true"/><div className="min-w-0 flex-1"><div className="flex justify-between gap-4"><p className="font-semibold whitespace-pre-wrap text-sm">{point.description}</p><span className="text-sm font-bold tabular-nums whitespace-nowrap">{point.awarded}/{point.marks}</span></div><p className="text-sm whitespace-pre-wrap text-slate-600 mt-1 leading-relaxed">{point.feedback}</p><span className="text-xs font-medium mt-2 block">{status==='correct'?'Full marks':status==='partial'?'Partial credit':'Needs review'}</span></div></div>;
   })}</div>
   {modelAnswer&&<details className="ma-grade-model"><summary className="text-sm font-semibold cursor-pointer">Model answer</summary><p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{modelAnswer}</p></details>}
   <p className="mt-4 text-xs text-slate-500">AI practice feedback · Check uncertain feedback with your instructor.</p>
  </div>
 </section>;
}
