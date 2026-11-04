import React,{createContext,useContext,useRef} from 'react';
import {api} from './api.ts';
type TextSaves={remember:(id:number,text:string)=>void;acknowledge:(id:number,text:string)=>void;flush:()=>Promise<void>};
const Context=createContext<TextSaves>({remember:()=>{},acknowledge:()=>{},flush:async()=>{}});
export const quizTextDraftKey=(sessionId:number,questionId:number)=>`medatlas_quiz_short_${sessionId}_${questionId}`;
export const useQuizTextSaves=()=>useContext(Context);
/** Text is local while typing. Submit saves each dirty response once before completing the quiz. */
export function QuizTextSaveProvider({session,children}:{session:any;children:React.ReactNode}){
 const drafts=useRef<Map<number,string>|null>(null);
 if(!drafts.current){drafts.current=new Map();if(session.status!=='completed')for(const q of session.questions||[])if(q.questionType==='short_answer')try{const draft=localStorage.getItem(quizTextDraftKey(session.id,q.id));if(draft!==null&&draft!==q.shortAnswerAttempt?.answer)drafts.current.set(q.id,draft);}catch{}}
 const service=useRef<TextSaves|null>(null);
 if(!service.current){const acknowledge=(id:number,text:string)=>{if(drafts.current?.get(id)?.trim().normalize('NFC')===text.trim().normalize('NFC')){drafts.current.delete(id);try{localStorage.removeItem(quizTextDraftKey(session.id,id));}catch{}}};service.current={remember:(id,text)=>{drafts.current!.set(id,text);try{localStorage.setItem(quizTextDraftKey(session.id,id),text);}catch{}},acknowledge,flush:async()=>{for(const [id,text] of [...drafts.current!]){await api.saveQuizShortAnswer(session.id,id,text);acknowledge(id,text);}}};}
 return <Context.Provider value={service.current}>{children}</Context.Provider>;
}
