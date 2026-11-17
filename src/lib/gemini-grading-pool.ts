import {createHash,randomUUID} from 'node:crypto';
import {validStudentGeminiKey} from './gemini-key-input.ts';
import {gradeWithGemini,gradeWithTemporaryRetry,GradingError,shortAnswerModel} from './gemini-short-answer.ts';
import type {ShortAnswerDefinition} from './short-answer-model.ts';

type Entry={key:string;id:string;project:string;rpm:number;concurrency:number};
type KeyState={lease?:string;project?:string;until:number;used:number;blocked:number};
type ProjectState={next:number;blocked:number};
export type PoolState={keys:Record<string,KeyState>;projects:Record<string,ProjectState>};
export type PoolStore=<T>(model:string,change:(state:PoolState,now:number)=>T)=>Promise<T>;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const configurationError=()=>new GradingError('POOL_CONFIG',60);

// Read only on the server. Never return entries, hashes or configuration errors to clients.
export function readGradingPool(raw=process.env.GEMINI_GRADING_POOL):Entry[]{
 if(!raw?.trim())return [];
 try{
  const values:unknown=JSON.parse(raw);
  if(!Array.isArray(values)||!values.length||values.length>20)throw configurationError();
  const seen=new Set<string>(),groups=new Map<string,string>();
  return values.map(value=>{
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['key','project','rpm','concurrency'].includes(k)))throw configurationError();
   const {key,project,rpm=5,concurrency=2}=value;
   if(!validStudentGeminiKey(key)||typeof project!=='string'||!/^[a-z][a-z0-9-]{4,62}$/.test(project)||!Number.isInteger(rpm)||rpm<1||rpm>10000||!Number.isInteger(concurrency)||concurrency<1||concurrency>20)throw configurationError();
   const id=digest(key),group=digest(project),limits=JSON.stringify([rpm,concurrency]);
   if(seen.has(id)||(groups.has(group)&&groups.get(group)!==limits))throw configurationError();
   seen.add(id);groups.set(group,limits);
   return {key,id,project:group,rpm,concurrency};
  });
 }catch{throw configurationError();}
}

// One small private row per model coordinates all Vercel instances. No credential is stored here.
export const postgresPoolStore:PoolStore=async(model,change)=>{
 const {pool}=await import('../db/index.ts');
 const client=await pool.connect().catch(()=>{throw new GradingError('POOL_STORAGE',15);});
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='3s'");
  await client.query(`INSERT INTO public.gemini_grading_pool_state(model,state) VALUES($1,'{"keys":{},"projects":{}}'::jsonb) ON CONFLICT(model) DO NOTHING`,[model]);
  const [row]=(await client.query('SELECT state FROM public.gemini_grading_pool_state WHERE model=$1 FOR UPDATE',[model])).rows;
  const [clock]=(await client.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS now')).rows;
  const before=JSON.stringify(row.state);
  const result=change(row.state,Number(clock.now));
  const after=JSON.stringify(row.state);
  if(after!==before)await client.query('UPDATE public.gemini_grading_pool_state SET state=$2::jsonb WHERE model=$1',[model,after]);
  await client.query('COMMIT');
  return result;
 }catch{await client.query('ROLLBACK').catch(()=>{});throw new GradingError('POOL_STORAGE',15);}finally{client.release();}
};

function createPoolRequest(store:PoolStore){
 return async<T>(request:(key:string,deadline:number)=>Promise<T>,entries:Entry[],deadline:number)=>{
  if(!entries.length)throw configurationError();
  const model=shortAnswerModel(),lease=randomUUID();
  const claim=await store(model,(state,now)=>{
   // Keep recent old entries so overlapping deployments share cooldowns; discard expired history.
   for(const [id,key] of Object.entries(state.keys))if(Math.max(key.used,key.until,key.blocked)<now-86400000)delete state.keys[id];
   for(const [id,project] of Object.entries(state.projects))if(Math.max(project.next,project.blocked)<now-86400000)delete state.projects[id];
   const activeByProject=new Map<string,number>();
   for(const [id,key] of Object.entries(state.keys)){
    const project=key.project??entries.find(entry=>entry.id===id)?.project;
    if(project&&key.until>now)activeByProject.set(project,(activeByProject.get(project)??0)+1);
   }
   const eligible=entries.map(entry=>{
    const key=state.keys[entry.id],project=state.projects[entry.project];
    // Leases may be released early. Poll briefly while active, but respect known cooldowns and spacing.
    const leased=(key?.until??0)>now||(activeByProject.get(entry.project)??0)>=entry.concurrency;
    const wait=Math.max(leased?1000:0,(key?.blocked??0)-now,(project?.next??0)-now,(project?.blocked??0)-now);
    return {entry,wait};
   });
   const ready=eligible.filter(candidate=>candidate.wait===0).map(candidate=>candidate.entry)
    .sort((a,b)=>(state.keys[a.id]?.used||0)-(state.keys[b.id]?.used||0)||a.id.localeCompare(b.id));
   const entry=ready[0];
   if(!entry)return {entry:null,delaySeconds:Math.max(1,Math.ceil(Math.min(...eligible.map(candidate=>candidate.wait))/1000))};
   state.keys[entry.id]={lease,project:entry.project,until:now+30000,used:now,blocked:0};
   state.projects[entry.project]={next:now+Math.ceil(60000/entry.rpm),blocked:state.projects[entry.project]?.blocked||0};
   return {entry,delaySeconds:0};
  });
  if(!claim.entry)throw new GradingError('POOL_BUSY',claim.delaySeconds);
  const entry=claim.entry;
  let failure:GradingError|undefined;
  try{return await request(entry.key,deadline);}
  catch(error){
   failure=error instanceof GradingError?error:new GradingError('UNAVAILABLE',15);
   const code=failure.code==='QUOTA'?'POOL_QUOTA':failure.code==='KEY_OR_ACCESS'?'POOL_ACCESS':failure.code==='MODEL_UNAVAILABLE'?'POOL_MODEL_UNAVAILABLE':failure.code;
   if(code===failure.code&&failure.delaySeconds)throw failure;
   throw new GradingError(code,failure.delaySeconds||15);
  }finally{
   // Preserve a valid grade even if releasing the lease fails. The 30s lease expires on its own.
   await store(model,(state,now)=>{
    const key=state.keys[entry.id];
    if(key?.lease===lease){
     key.until=0;delete key.lease;
     if(failure&&failure.code!=='GEMINI_BAD_REQUEST'){
      key.blocked=now+(['KEY_OR_ACCESS','MODEL_UNAVAILABLE'].includes(failure.code)?600000:Math.max(15,failure.delaySeconds)*1000);
     }
    }
    if(failure?.code==='QUOTA'){
     const project=state.projects[entry.project]??{next:0,blocked:0};
     project.blocked=Math.max(project.blocked,now+Math.max(60,failure.delaySeconds)*1000);
     state.projects[entry.project]=project;
    }
   }).catch(()=>{});
  }
 };
}

async function gradeWithPoolFailover<T>(request: (deadline: number) => Promise<T>) {
 let attempts = 0;
 const run = (deadline: number) => { attempts++; return request(deadline); };
 return gradeWithTemporaryRetry(async deadline => {
  try {
   return await run(deadline);
  } catch (error) {
   if (!(error instanceof GradingError) ||
       !['POOL_QUOTA', 'POOL_ACCESS', 'POOL_MODEL_UNAVAILABLE'].includes(error.code) ||
       attempts > 1 ||
       deadline - performance.now() < 2000) throw error;
   try {
    return await run(deadline);
   } catch (fallback) {
    if (fallback instanceof GradingError && fallback.code === 'POOL_BUSY') throw error;
    // The second provider attempt is final, even if it returns a transient error.
    if (fallback instanceof GradingError) throw new GradingError(fallback.code, fallback.delaySeconds);
    throw fallback;
   }
  }
 });
}

export function createPoolGrader(store:PoolStore=postgresPoolStore,grade=gradeWithGemini){
 const requestInPool=createPoolRequest(store);
 return (question:ShortAnswerDefinition,answer:string,entries=readGradingPool())=>
  gradeWithPoolFailover(deadline=>requestInPool((key,limit)=>grade(key,question,answer,limit),entries,deadline));
}
export const gradeWithPool=createPoolGrader();
const requestInPool=createPoolRequest(postgresPoolStore);

export async function gradeWithAvailableCredentials<T>(uid:string,request:(key:string,deadline:number)=>Promise<T>){
 const entries=readGradingPool();
 if(entries.length)return gradeWithPoolFailover(deadline=>requestInPool(request,entries,deadline));
 const {readStudentGeminiKeyForGrading}=await import('./student-gemini-keys.ts');
 const key=await readStudentGeminiKeyForGrading(uid);
 if(!key)throw new GradingError('KEY_MISSING');
 return gradeWithTemporaryRetry(deadline=>request(key,deadline));
}

export function gradeWithConfiguredCredentials(uid:string,question:ShortAnswerDefinition,answer:string){
 return gradeWithAvailableCredentials(uid,(key,deadline)=>gradeWithGemini(key,question,answer,deadline));
}
