import {randomUUID} from 'node:crypto';
import {gradeBatchWithPool,gradeWithPool,postgresPoolStore,type PoolStore} from './gemini-grading-pool.ts';
import {GradingError,gradePracticalStationsWithGemini,gradeWithGemini,shortAnswerModel} from './gemini-short-answer.ts';
import {validStudentGeminiKey} from './gemini-key-input.ts';
import type {ShortAnswerDefinition} from './short-answer-model.ts';

export const dedicatedCourseId='43bdeccc-176e-46a4-9d3f-c07d391e65c6';
const primaryConcurrencyLimit=2;
const primaryDeadlineMs=12000;
const primaryBatchDeadlineMs=22000;
const primaryLeaseMs=15000;
const primaryBatchLeaseMs=25000;

export function createPrivateCourseGrader(primary=gradeWithGemini,fallback=gradeWithPool,store?:PoolStore|null){
 let active=0;
 let blockedUntil=0;
 return async(question:ShortAnswerDefinition,answer:string,quizId?:string)=>{
  const key=process.env.BFOM_EXAM_GRADING_KEY?.trim();
  if(quizId===dedicatedCourseId&&validStudentGeminiKey(key)){
   if(store){
    const modelKey=`bfom-primary:${shortAnswerModel()}`;
    const lease=randomUUID();
    let claimedSlot:string|null|undefined=undefined;
    try{
     claimedSlot=await store(modelKey,(state,now)=>{
      if((state.projects.primary?.blocked??0)>now)return null;
      for(let i=0;i<primaryConcurrencyLimit;i++){
       const slot=String(i);
       if((state.keys[slot]?.until??0)<=now){
        state.keys[slot]={lease,until:now+primaryLeaseMs,used:now,blocked:0};
        return slot;
       }
      }
      return null;
     });
    }catch{
     claimedSlot=undefined;
    }
    if(claimedSlot!==undefined){
     if(claimedSlot!==null){
      let cooldownMs=0;
      try{return await primary(key,question,answer,performance.now()+primaryDeadlineMs);}
      catch(err){
       if(err instanceof GradingError&&err.delaySeconds>0)cooldownMs=err.delaySeconds*1000;
       const code=err instanceof GradingError?err.code:(err as any)?.code;
       console.info('[private-course-grading] primary failed; using normal pool',{code});
      }finally{
       const slot=claimedSlot;
       await store(modelKey,(state,now)=>{
        if(state.keys[slot]?.lease===lease){
         state.keys[slot].until=0;
         delete state.keys[slot].lease;
        }
        if(cooldownMs>0){
         const project=state.projects.primary??{next:0,blocked:0};
         project.blocked=Math.max(project.blocked,now+cooldownMs);
         state.projects.primary=project;
        }
       }).catch(()=>{});
      }
     }
     return fallback(question,answer);
    }
   }
   if(active<primaryConcurrencyLimit&&Date.now()>=blockedUntil){
    active++;
    try{return await primary(key,question,answer,performance.now()+primaryDeadlineMs);}
    catch(err){
     if(err instanceof GradingError&&err.delaySeconds>0){
      blockedUntil=Math.max(blockedUntil,Date.now()+err.delaySeconds*1000);
     }
     const code=err instanceof GradingError?err.code:(err as any)?.code;
     console.info('[private-course-grading] primary failed; using normal pool',{code});
    }finally{active--;}
   }
  }
  return fallback(question,answer);
 };
}
export const gradePrivateCourse=createPrivateCourseGrader(gradeWithGemini,gradeWithPool,postgresPoolStore);

export function createPrivateCourseBatchGrader(
 primary=gradePracticalStationsWithGemini,
 fallback=gradeBatchWithPool,
 store?:PoolStore|null,
){
 let active=0;
 let blockedUntil=0;
 return async(items:{index:number;question:ShortAnswerDefinition;answer:string}[],quizId?:string)=>{
  const key=process.env.BFOM_EXAM_GRADING_KEY?.trim();
  if(quizId===dedicatedCourseId&&validStudentGeminiKey(key)){
   if(store){
    const modelKey=`bfom-primary:${shortAnswerModel()}`;
    const lease=randomUUID();
    let claimedSlot:string|null|undefined=undefined;
    try{
     claimedSlot=await store(modelKey,(state,now)=>{
      if((state.projects.primary?.blocked??0)>now)return null;
      for(let i=0;i<primaryConcurrencyLimit;i++){
       const slot=String(i);
       if((state.keys[slot]?.until??0)<=now){
        state.keys[slot]={lease,until:now+primaryBatchLeaseMs,used:now,blocked:0};
        return slot;
       }
      }
      return null;
     });
    }catch{
     claimedSlot=undefined;
    }
    if(claimedSlot!==undefined){
     if(claimedSlot!==null){
      let cooldownMs=0;
      try{return await primary(key,items,performance.now()+primaryBatchDeadlineMs);}
      catch(err){
       if(err instanceof GradingError&&err.delaySeconds>0)cooldownMs=err.delaySeconds*1000;
       const code=err instanceof GradingError?err.code:(err as any)?.code;
       console.info('[private-course-grading] primary batch failed; using normal pool',{code});
      }finally{
       const slot=claimedSlot;
       await store(modelKey,(state,now)=>{
        if(state.keys[slot]?.lease===lease){
         state.keys[slot].until=0;
         delete state.keys[slot].lease;
        }
        if(cooldownMs>0){
         const project=state.projects.primary??{next:0,blocked:0};
         project.blocked=Math.max(project.blocked,now+cooldownMs);
         state.projects.primary=project;
        }
       }).catch(()=>{});
      }
     }
     return fallback(items);
    }
   }
   if(active<primaryConcurrencyLimit&&Date.now()>=blockedUntil){
    active++;
    try{return await primary(key,items,performance.now()+primaryBatchDeadlineMs);}
    catch(err){
     if(err instanceof GradingError&&err.delaySeconds>0){
      blockedUntil=Math.max(blockedUntil,Date.now()+err.delaySeconds*1000);
     }
     const code=err instanceof GradingError?err.code:(err as any)?.code;
     console.info('[private-course-grading] primary batch failed; using normal pool',{code});
    }finally{active--;}
   }
  }
  return fallback(items);
 };
}
export const gradePrivateCourseBatch=createPrivateCourseBatchGrader(gradePracticalStationsWithGemini,gradeBatchWithPool,postgresPoolStore);
