import React,{createContext,useContext,useEffect,useRef} from 'react';
import {useSessionPlayerApi} from './session-player-api.tsx';
type TextSaves={remember:(id:number,text:string)=>void;acknowledge:(id:number,text:string)=>void;flush:()=>Promise<void>;subscribeSaved?:(listener:(id:number,result:any)=>void)=>()=>void};
const Context=createContext<TextSaves>({remember:()=>{},acknowledge:()=>{},flush:async()=>{}});
export const quizTextDraftKey=(sessionId:number,questionId:number)=>`medatlas_quiz_short_${sessionId}_${questionId}`;
export const useQuizTextSaves=()=>useContext(Context);
/** Text is local while typing. Submit saves each dirty response once before completing the quiz. */
export function QuizTextSaveProvider({session,children}:{session:any;children:React.ReactNode}){
 const api=useSessionPlayerApi();
 const savedListeners=useRef(new Set<(id:number,result:any)=>void>());
 const drafts=useRef<Map<number,string>|null>(null);
 if(!drafts.current){drafts.current=new Map();if(session.status!=='completed')for(const q of session.questions||[])if(q.questionType==='short_answer')try{const draft=localStorage.getItem(quizTextDraftKey(session.id,q.id));if(draft!==null&&draft!==q.shortAnswerAttempt?.answer)drafts.current.set(q.id,draft);}catch{}}
 const service=useRef<TextSaves|null>(null);
 if(!service.current){const acknowledge=(id:number,text:string)=>{if(drafts.current?.get(id)?.trim().normalize('NFC')===text.trim().normalize('NFC')){drafts.current.delete(id);try{localStorage.removeItem(quizTextDraftKey(session.id,id));}catch{}}};service.current={remember:(id,text)=>{drafts.current!.set(id,text);try{localStorage.setItem(quizTextDraftKey(session.id,id),text);}catch{}},acknowledge,subscribeSaved:listener=>{savedListeners.current.add(listener);return()=>{savedListeners.current.delete(listener);};},flush:async()=>{for(const [id,text] of [...drafts.current!]){const result=await api.saveQuizShortAnswer(session.id,id,text);acknowledge(id,text);for(const listener of savedListeners.current)listener(id,result);}}};}
 useEffect(()=>{
  if(!session.privateQuiz)return;
  const save=()=>{void service.current!.flush().catch(()=>{});};
  const warn=(event:BeforeUnloadEvent)=>{if(drafts.current?.size){event.preventDefault();event.returnValue='';save();}};
  window.addEventListener('beforeunload',warn);window.addEventListener('pagehide',save);
  return()=>{window.removeEventListener('beforeunload',warn);window.removeEventListener('pagehide',save);save();};
 },[]);
 return <Context.Provider value={service.current}>{children}</Context.Provider>;
}
