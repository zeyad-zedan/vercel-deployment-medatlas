import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {validStudentGeminiKey} from './gemini-key-input.ts';
import {gradePracticalStationsWithGemini,gradeWithGemini,gradeWithTemporaryRetry,gradingRetrySeconds,GradingError,shortAnswerModel} from './gemini-short-answer.ts';
import type {ShortAnswerDefinition} from './short-answer-model.ts';

type Entry={key:string;id:string;project:string;rpm:number;concurrency:number};
type KeyState={lease?:string;project?:string;until:number;used:number;blocked:number};
type ProjectState={next:number;blocked:number};
export type PoolState={keys:Record<string,KeyState>;projects:Record<string,ProjectState>;cursor?:number};
export type PoolStore=<T>(model:string,change:(state:PoolState,now:number)=>T)=>Promise<T>;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const configurationError=()=>new GradingError('POOL_CONFIG',60);

let cachedPoolRaw:string|undefined,cachedPoolEntries:Entry[]|undefined;

// Read only on the server. Never return entries, hashes or configuration errors to clients.
export function readGradingPool(raw=process.env.GEMINI_GRADING_POOL):Entry[]{
 if(!raw?.trim())return [];
 if(raw===cachedPoolRaw&&cachedPoolEntries)return cachedPoolEntries;
 try{
  const values:unknown=JSON.parse(raw);
  if(!Array.isArray(values)||!values.length||values.length>20)throw configurationError();
  const seen=new Set<string>(),groups=new Map<string,string>();
  const entries=values.map(value=>{
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['key','project','rpm','concurrency'].includes(k)))throw configurationError();
   const {key,project,rpm=5,concurrency=2}=value;
   if(!validStudentGeminiKey(key)||typeof project!=='string'||!/^[a-z][a-z0-9-]{4,62}$/.test(project)||!Number.isInteger(rpm)||rpm<1||rpm>10000||!Number.isInteger(concurrency)||concurrency<1||concurrency>20)throw configurationError();
   const id=digest(key),group=digest(project),limits=JSON.stringify([rpm,concurrency]);
   if(seen.has(id)||(groups.has(group)&&groups.get(group)!==limits))throw configurationError();
   seen.add(id);groups.set(group,limits);
   return {key,id,project:group,rpm,concurrency};
  });
  cachedPoolRaw=raw;
  cachedPoolEntries=entries;
  return entries;
 }catch{throw configurationError();}
}

// One small private row per model coordinates all Vercel instances. No credential is stored here.
export const postgresPoolStore:PoolStore=async(model,change)=>{
 const {pool}=await import('../db/index.ts');
 const client=await pool.connect().catch((err)=>{
  console.warn('[grading-pool] db connect failed',{code:(err as any)?.code});
  throw new GradingError('POOL_STORAGE',gradingRetrySeconds);
 });
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='5s'");
  let [row]=(await client.query('SELECT state, extract(epoch FROM clock_timestamp())*1000 AS now FROM public.gemini_grading_pool_state WHERE model=$1 FOR UPDATE',[model])).rows;
  if(!row){
   await client.query(`INSERT INTO public.gemini_grading_pool_state(model,state) VALUES($1,'{"keys":{},"projects":{}}'::jsonb) ON CONFLICT(model) DO NOTHING`,[model]);
   [row]=(await client.query('SELECT state, extract(epoch FROM clock_timestamp())*1000 AS now FROM public.gemini_grading_pool_state WHERE model=$1 FOR UPDATE',[model])).rows;
  }
  const before=JSON.stringify(row.state);
  const result=change(row.state,Number(row.now));
  const after=JSON.stringify(row.state);
  if(after!==before)await client.query('UPDATE public.gemini_grading_pool_state SET state=$2::jsonb WHERE model=$1',[model,after]);
  await client.query('COMMIT');
  return result;
 }catch(err){
  await client.query('ROLLBACK').catch(()=>{});
  console.warn('[grading-pool] storage transaction failed',{code:(err as any)?.code});
  throw new GradingError('POOL_STORAGE',gradingRetrySeconds);
 }finally{client.release();}
};

function createPoolRequest(store:PoolStore){
 return async<T>(request:(key:string,deadline:number)=>Promise<T>,entries:Entry[],deadline:number)=>{
  if(!entries.length)throw configurationError();
  const model=shortAnswerModel(),lease=randomUUID();
  const claimSlot=()=>store(model,(state,now)=>{
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
    const spacingWait=(project?.next??0)-now;
    const cooldownWait=Math.max((key?.blocked??0)-now,(project?.blocked??0)-now);
    const wait=Math.max(leased?1000:0,cooldownWait,spacingWait);
    return {entry,wait,spacingOnly:!leased&&cooldownWait<=0&&spacingWait>0};
   });
   // The cursor and leases share the same row lock, so concurrent servers rotate atomically.
   const cursor=Number.isSafeInteger(state.cursor)?((state.cursor!%entries.length)+entries.length)%entries.length:0;
   let selected=-1;
   for(let offset=0;offset<entries.length;offset++){
    const index=(cursor+offset)%entries.length;
    if(eligible[index].wait===0){selected=index;break;}
   }
   const entry=selected<0?undefined:entries[selected];
   if(!entry){
    const minWait=Math.min(...eligible.map(candidate=>candidate.wait));
    const spacingOnly=eligible.some(candidate=>candidate.spacingOnly&&candidate.wait<=1000);
    return {entry:null,delaySeconds:Math.max(1,Math.ceil(minWait/1000)),waitMs:minWait,spacingOnly,now};
   }
   state.keys[entry.id]={lease,project:entry.project,until:now+30000,used:now,blocked:0};
   state.cursor=(selected+1)%entries.length;
   state.projects[entry.project]={next:now+Math.ceil(60000/entry.rpm),blocked:state.projects[entry.project]?.blocked||0};
   return {entry,delaySeconds:0,waitMs:0,spacingOnly:false,now};
  });
  // Bound total claim+spacing time BEFORE initial claimSlot() so DB latency cannot extend the budget.
  const waitBudgetEnd=Math.min(deadline-10000,performance.now()+2500);
  let claim=await claimSlot();
  let waitAttempts=0;
  // Never spin-poll Postgres when all keys are actively leased or on cooldown; only smooth brief RPM spacing (<=1s, max 2 retries).
  while(!claim.entry&&claim.spacingOnly&&claim.waitMs<=1000&&waitAttempts<2&&performance.now()<waitBudgetEnd){
   const prevNow=claim.now;
   const pauseMs=Math.min(Math.max(60,claim.waitMs)+Math.floor(Math.random()*120),Math.max(0,waitBudgetEnd-performance.now()));
   if(pauseMs<20)break;
   await sleep(pauseMs);
   waitAttempts++;
   claim=await claimSlot();
   if(!claim.entry&&claim.now===prevNow)break;
  }
  if(!claim.entry)throw new GradingError('POOL_BUSY',claim.delaySeconds);
  const entry=claim.entry;
  console.info('[grading-pool] dispatched',{slot:entries.findIndex(candidate=>candidate.id===entry.id)+1,poolSize:entries.length});
  let failure:GradingError|undefined;
  try{return await request(entry.key,deadline);}
  catch(error){
   failure=error instanceof GradingError?error:new GradingError('UNAVAILABLE',gradingRetrySeconds);
   const code=failure.code==='QUOTA'?'POOL_QUOTA':failure.code==='THROTTLED'?'POOL_RATE_LIMIT':failure.code==='KEY_OR_ACCESS'?'POOL_ACCESS':failure.code==='MODEL_UNAVAILABLE'?'POOL_MODEL_UNAVAILABLE':failure.code;
   const retryAfterMs=code==='POOL_RATE_LIMIT'&&entries.length>1&&failure.retryAfterMs!==undefined
    ?Math.min(failure.retryAfterMs,1000)
    :failure.retryAfterMs;
   if(code===failure.code&&failure.delaySeconds&&retryAfterMs===failure.retryAfterMs)throw failure;
   throw new GradingError(code,failure.delaySeconds||gradingRetrySeconds,retryAfterMs);
  }finally{
   // Preserve a valid grade even if releasing the lease fails. The 30s lease expires on its own.
   await store(model,(state,now)=>{
    const key=state.keys[entry.id];
    if(key?.lease===lease){
     key.until=0;delete key.lease;
     if(failure&&!['GEMINI_BAD_REQUEST','INVALID_RESPONSE'].includes(failure.code)){
      key.blocked=now+(['KEY_OR_ACCESS','MODEL_UNAVAILABLE'].includes(failure.code)?60000:Math.max(gradingRetrySeconds,failure.delaySeconds)*1000);
     }
     if(failure&&['GEMINI_BAD_REQUEST','KEY_OR_ACCESS','MODEL_UNAVAILABLE'].includes(failure.code)&&state.projects[entry.project]){
      state.projects[entry.project].next=0;
     }
    }
    if(failure?.code==='QUOTA'){
     const project=state.projects[entry.project]??{next:0,blocked:0};
     project.blocked=Math.max(project.blocked,now+Math.max(gradingRetrySeconds,failure.delaySeconds||60)*1000);
     state.projects[entry.project]=project;
    }
    // An ambiguous 429 affects this key only. Independent projects must remain eligible.
   }).catch(()=>{});
  }
 };
}

async function gradeWithPoolFailover<T>(request: (deadline: number) => Promise<T>, entryCount: number) {
 // Let slow requests finish. Aborting early and resubmitting can amplify upstream overload.
 return gradeWithTemporaryRetry(async deadline => {
  let attempts = 0;
  let previous:GradingError|undefined;
  while(true) {
   try {
    attempts++;
    return await request(deadline);
   } catch (error) {
    if(!(error instanceof GradingError))throw error;
    if(error.code==='POOL_BUSY'&&previous)throw previous;
    // Explicit quota/access rejections can skip several unavailable projects without generating grades.
    // An uncertain timeout waits for a student retry; do not duplicate a possibly running grade.
    const rejected=['POOL_QUOTA','POOL_ACCESS','POOL_MODEL_UNAVAILABLE'].includes(error.code);
    if(rejected&&attempts<entryCount&&deadline-performance.now()>=2000){
     previous=error;
     console.info('[grading-pool] failover',{code:error.code,attempt:attempts+1,remainingMs:Math.round(deadline-performance.now())});
     continue;
    }
    if(previous)throw new GradingError(error.code,error.delaySeconds,error.retryAfterMs);
    throw error;
   }
  }
 });
}

export function createPoolGrader(store:PoolStore=postgresPoolStore,grade=gradeWithGemini){
 const requestInPool=createPoolRequest(store);
 return (question:ShortAnswerDefinition,answer:string,entries=readGradingPool())=>
  gradeWithPoolFailover(deadline=>requestInPool((key,limit)=>grade(key,question,answer,limit),entries,deadline),entries.length);
}
export const gradeWithPool=createPoolGrader();
const requestInPool=createPoolRequest(postgresPoolStore);

export function gradeBatchWithPool(items:{index:number;question:ShortAnswerDefinition;answer:string}[],entries=readGradingPool()){
 return gradeWithPoolFailover(deadline=>requestInPool((key,limit)=>gradePracticalStationsWithGemini(key,items,limit),entries,deadline),entries.length);
}

export async function gradeWithAvailableCredentials<T>(uid:string,request:(key:string,deadline:number)=>Promise<T>){
 const entries=readGradingPool();
 if(entries.length)return gradeWithPoolFailover(deadline=>requestInPool(request,entries,deadline),entries.length);
 const {readStudentGeminiKeyForGrading}=await import('./student-gemini-keys.ts');
 let key:string|null;
 try{
  key=await readStudentGeminiKeyForGrading(uid);
 }catch(err){
  console.warn('[grading-pool] student key read failed',{code:(err as any)?.code});
  throw new GradingError('KEY_OR_ACCESS',60);
 }
 if(!key)throw new GradingError('KEY_MISSING');
 return gradeWithTemporaryRetry(deadline=>request(key,deadline));
}

export function gradeWithConfiguredCredentials(uid:string,question:ShortAnswerDefinition,answer:string){
 return gradeWithAvailableCredentials(uid,(key,deadline)=>gradeWithGemini(key,question,answer,deadline));
}
