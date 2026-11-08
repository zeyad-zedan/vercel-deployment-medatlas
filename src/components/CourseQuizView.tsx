import React,{useEffect,useRef,useState} from 'react';
import {McqSessionPlayer} from './McqSessionPlayer.tsx';
import {courseRequest,createCourseSession} from '../lib/course-session.ts';

const button='inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed';
type Controller=ReturnType<typeof createCourseSession>;
export default function CourseQuizView({slug,onSignIn}:{slug:string;onSignIn:()=>void}){
  const [controller,setController]=useState<Controller|null>(null),[phase,setPhase]=useState('loading');
  const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(true),signIn=useRef(onSignIn);signIn.current=onSignIn;
  const failure=(error:any)=>{
    if(!alive.current)return;
    if(error.status===401){
      if(/password/i.test(error.message)){setPhase('locked');setController(null);setError(/incorrect|changed/i.test(error.message)?error.message:'');}
      else signIn.current();
    }else setError(error.message||'Please try again. Your saved answers are safe.');
  };
  const open=async()=>{
    const data=await courseRequest(slug,'/session');
    if(alive.current){setController(createCourseSession(slug,data,failure));setPhase('ready');setError('');}
  };
  useEffect(()=>{alive.current=true;setPhase('loading');setController(null);setError('');open().catch(error=>{failure(error);if(error.status!==401&&alive.current)setPhase('error');});return()=>{alive.current=false;};},[slug]);
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await action();}catch(error){failure(error);}finally{if(alive.current)setBusy(false);}};
  if(phase==='loading')return <p role="status">Opening your private quiz…</p>;
  if(phase==='locked')return <section className="max-w-lg rounded-xl border border-slate-200 bg-white p-6"><h1 className="text-2xl font-bold">Open private quiz</h1><p className="mt-3 text-sm text-slate-600">You’re signed in to MedAtlas. Enter the quiz password provided by your course presenter.</p><form className="mt-6 space-y-4" onSubmit={event=>{event.preventDefault();void run(async()=>{await courseRequest(slug,'/unlock',{password});setPassword('');await open();});}}><label className="block text-sm font-semibold">Quiz password<input autoFocus type="password" autoComplete="off" maxLength={128} required value={password} disabled={busy} onChange={event=>setPassword(event.target.value)} className="mt-2 block w-full rounded-lg border border-slate-300 px-3 py-3"/></label>{error&&<p role="alert" className="text-sm text-red-700">{error}</p>}<button className={button+' !bg-[var(--ma-brand)] !text-white'} disabled={busy}>{busy?'Opening…':'Open quiz'}</button></form></section>;
  if(!controller)return <section><h1 className="text-xl font-bold">Private quiz</h1><p role="alert" className="mt-3 text-red-700">{error||'This quiz could not be opened.'}</p><button className={button+' mt-4'} disabled={busy} onClick={()=>void run(open)}>Try again</button></section>;
  const overview=controller.snapshot();
  return <div className="space-y-4">{error&&<p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}{phase==='overview'?<article className="ma-lecture-card space-y-4"><h1 className="text-xl font-bold">{overview.title}</h1><p className="text-sm text-slate-600">{overview.totalQuestions-overview.unansweredCount}/{overview.totalQuestions} questions answered</p><button className={button+' !bg-[var(--ma-brand)] !text-white'} disabled={busy} onClick={()=>void run(open)}>{overview.status==='completed'?'Review answers':'Continue learning'}</button></article>:<McqSessionPlayer key={controller.initialSession.id} initialSession={controller.initialSession} service={controller.service} onPositionChange={controller.onPositionChange} onExit={()=>setPhase('overview')} onSessionCompleted={()=>{}}/>}</div>;
}
