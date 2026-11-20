import React,{createContext,useContext,useEffect,useRef} from 'react';
import {useSessionPlayerApi} from './session-player-api.tsx';
type TextSaves={remember:(id:number,text:string)=>void;acknowledge:(id:number,text:string)=>void;flush:()=>Promise<void>;trackInFlight?:(id:number,promise:Promise<unknown>)=>void;subscribeSaved?:(listener:(id:number,result:any)=>void)=>()=>void};
const Context=createContext<TextSaves>({remember:()=>{},acknowledge:()=>{},flush:async()=>{}});
export const quizTextDraftKey=(sessionId:number,questionId:number)=>`medatlas_quiz_short_${sessionId}_${questionId}`;
export const useQuizTextSaves=()=>useContext(Context);
export function clearSavedQuizTextDraft(key:string,answer:string){
 try{
  const draft=localStorage.getItem(key);
  if(draft?.trim().normalize('NFC')===answer.trim().normalize('NFC'))localStorage.removeItem(key);
 }catch{}
}
/** Text is local while typing. Submit saves each dirty response once before completing the quiz. */
export function QuizTextSaveProvider({session,children}:{session:any;children:React.ReactNode}){
 const api=useSessionPlayerApi();
 const savedListeners=useRef(new Set<(id:number,result:any)=>void>());
 const drafts=useRef<Map<number,string>|null>(null);
 const inFlightFlush=useRef<Promise<void>|null>(null);
 const inFlightSaves=useRef(new Map<number,Promise<unknown>>());
 if(!drafts.current){drafts.current=new Map();if(session.status!=='completed'&&!session.reviewOnly)for(const q of session.questions||[])if(q.questionType==='short_answer')try{const draft=localStorage.getItem(quizTextDraftKey(session.id,q.id));if(draft!==null&&draft!==q.shortAnswerAttempt?.answer)drafts.current.set(q.id,draft);}catch{}}
 const service=useRef<TextSaves|null>(null);
 if(!service.current){
  const acknowledge=(id:number,text:string)=>{if(drafts.current?.get(id)?.trim().normalize('NFC')===text.trim().normalize('NFC')){drafts.current.delete(id);clearSavedQuizTextDraft(quizTextDraftKey(session.id,id),text);}};
  const runFlush=async()=>{
   let firstError:unknown=null;
   const failedIds=new Set<number>();
   for(let pass=0;pass<3;pass++){
    const ids=[...drafts.current!.keys()].filter(id=>!failedIds.has(id));
    if(!ids.length)break;
    for(const id of ids){
     const activeSave=inFlightSaves.current.get(id);
     if(activeSave){try{await activeSave;}catch{}}
     const text=drafts.current!.get(id);
     if(text===undefined)continue;
     try{
      const result=await api.saveQuizShortAnswer(session.id,id,text);
      acknowledge(id,text);
      for(const listener of savedListeners.current)listener(id,result);
     }catch(error){
      failedIds.add(id);
      if(firstError===null)firstError=error;
     }
    }
   }
   if(firstError!==null)throw firstError;
  };
  service.current={
   remember:(id,text)=>{drafts.current!.set(id,text);try{localStorage.setItem(quizTextDraftKey(session.id,id),text);}catch{}},
   acknowledge,
   trackInFlight:(id,promise)=>{
    const tracked=promise.then(()=>undefined,()=>undefined).finally(()=>{if(inFlightSaves.current.get(id)===tracked)inFlightSaves.current.delete(id);});
    inFlightSaves.current.set(id,tracked);
   },
   subscribeSaved:listener=>{savedListeners.current.add(listener);return()=>{savedListeners.current.delete(listener);};},
   flush:()=>{
    const prev=inFlightFlush.current;
    const next=(prev?prev.catch(()=>{}):Promise.resolve()).then(runFlush);
    const tracked=next.finally(()=>{if(inFlightFlush.current===tracked)inFlightFlush.current=null;});
    inFlightFlush.current=tracked;
    return tracked;
   },
  };
 }
 useEffect(()=>{
  if(!session.privateQuiz)return;
  const save=()=>{void service.current!.flush().catch(()=>{});};
  const warn=(event:BeforeUnloadEvent)=>{if(drafts.current?.size){event.preventDefault();event.returnValue='';save();}};
  window.addEventListener('beforeunload',warn);window.addEventListener('pagehide',save);
  return()=>{window.removeEventListener('beforeunload',warn);window.removeEventListener('pagehide',save);save();};
 },[]);
 return <Context.Provider value={service.current}>{children}</Context.Provider>;
}
