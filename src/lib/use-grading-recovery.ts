import {useEffect,useRef,useState} from 'react';

const temporaryFailures=new Set(['TIMEOUT','GEMINI_UNAVAILABLE','THROTTLED','POOL_RATE_LIMIT','POOL_BUSY','POOL_STORAGE','UNAVAILABLE','INVALID_RESPONSE']);
type Attempt={id:number;status:string;errorCode?:string|null;retryAt?:string|null};

// Arm only after the student requests grading. Browsing a saved answer never sends it to Google.
// Read-only status polling (`poll`) may run automatically when an attempt is already in `'grading'` status.
export function useGradingRecovery({contextKey,attempt,enabled,retry,poll}:{contextKey:string;attempt:Attempt|null;enabled:boolean;retry:()=>void;poll?:()=>void}){
  const [armed,setArmed]=useState(false),[retries,setRetries]=useState(0),[polls,setPolls]=useState(0);
  const retryRef=useRef(retry),pollRef=useRef(poll),lastFiredAtRef=useRef(0);
  useEffect(()=>{retryRef.current=retry;pollRef.current=poll;},[retry,poll]);
  useEffect(()=>{setArmed(false);setRetries(0);setPolls(0);lastFiredAtRef.current=0;},[contextKey]);
  const status=attempt?.status;
  const polling=status==='grading'&&Boolean(poll)&&enabled&&polls<12;
  const retrying=armed&&enabled&&status==='failed'&&temporaryFailures.has(attempt?.errorCode||'')&&retries<3;
  const waiting=polling||retrying;
  const id=attempt?.id,retryAt=attempt?.retryAt;
  useEffect(()=>{
    if(!waiting)return;
    const now=Date.now();
    let baseDelay:number;
    if(polling){
      baseDelay=5000;
    }else{
      const at=retryAt?Date.parse(retryAt):NaN;
      const rawDelta=Number.isFinite(at)?at-now:NaN;
      // Treat missing, past, un-advanced, or heavily negative-skewed (>60s) timestamps as stale and back off locally.
      const stale=!Number.isFinite(at)||at<=lastFiredAtRef.current||rawDelta>60000;
      baseDelay=stale?10000*Math.pow(2,retries):Math.max(0,rawDelta);
    }
    const jitter=baseDelay>=2000?Math.floor(Math.random()*1500):0;
    const timer=window.setTimeout(()=>{
      lastFiredAtRef.current=Date.now();
      if(polling){
        setPolls(count=>count+1);
        pollRef.current?.();
      }else{
        setRetries(count=>count+1);
        retryRef.current();
      }
    },baseDelay+jitter);
    return()=>window.clearTimeout(timer);
  },[waiting,polling,id,status,retryAt,retries,polls]);
  return {waiting,retries,start:()=>{lastFiredAtRef.current=Date.now();setRetries(0);setPolls(0);setArmed(true);},stop:()=>setArmed(false)};
}
