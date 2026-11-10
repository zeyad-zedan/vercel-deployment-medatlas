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
  const result=change(row.state,Number(clock.now));
  await client.query('UPDATE public.gemini_grading_pool_state SET state=$2::jsonb WHERE model=$1',[model,JSON.stringify(row.state)]);
  await client.query('COMMIT');
  return result;
 }catch{await client.query('ROLLBACK').catch(()=>{});throw new GradingError('POOL_STORAGE',15);}finally{client.release();}
};

export function createPoolGrader(store:PoolStore=postgresPoolStore,grade=gradeWithGemini){
 const gradeOnce=async(question:ShortAnswerDefinition,answer:string,entries:Entry[],deadline:number)=>{
  if(!entries.length)throw configurationError();
  const model=shortAnswerModel(),lease=randomUUID();
  const claim=await store(model,(state,now)=>{
   // Keep recent old entries so overlapping deployments share cooldowns; discard expired history.
   for(const [id,key] of Object.entries(state.keys))if(Math.max(key.used,key.until,key.blocked)<now-86400000)delete state.keys[id];
   for(const [id,project] of Object.entries(state.projects))if(Math.max(project.next,project.blocked)<now-86400000)delete state.projects[id];
   const ready=entries.filter(entry=>{
    const key=state.keys[entry.id],project=state.projects[entry.project];
    const active=Object.entries(state.keys).filter(([id,key])=>(key.project??entries.find(other=>other.id===id)?.project)===entry.project&&key.until>now).length;
    return (!key||Math.max(key.until,key.blocked)<=now)&&(!project||Math.max(project.next,project.blocked)<=now)&&active<entry.concurrency;
   }).sort((a,b)=>(state.keys[a.id]?.used||0)-(state.keys[b.id]?.used||0)||a.id.localeCompare(b.id));
   const entry=ready[0];
   if(!entry)return null;
   state.keys[entry.id]={lease,project:entry.project,until:now+30000,used:now,blocked:0};
   state.projects[entry.project]={next:now+Math.ceil(60000/entry.rpm),blocked:state.projects[entry.project]?.blocked||0};
   return entry;
  });
  if(!claim)throw new GradingError('POOL_BUSY',15);
  let failure:GradingError|undefined;
  try{return await grade(claim.key,question,answer,deadline);}
  catch(error){
   failure=error instanceof GradingError?error:new GradingError('UNAVAILABLE',15);
   const code=failure.code==='QUOTA'?'POOL_QUOTA':failure.code==='KEY_OR_ACCESS'?'POOL_ACCESS':failure.code==='MODEL_UNAVAILABLE'?'POOL_MODEL_UNAVAILABLE':failure.code;
   if(code===failure.code&&failure.delaySeconds)throw failure;
   throw new GradingError(code,failure.delaySeconds||15);
  }finally{
   // Preserve a valid grade even if releasing the lease fails. The 30s lease expires on its own.
   await store(model,(state,now)=>{
    const key=state.keys[claim.id];
    if(key?.lease===lease){
     key.until=0;delete key.lease;
     if(failure)key.blocked=now+(failure.code==='KEY_OR_ACCESS'?600000:Math.max(15,failure.delaySeconds)*1000);
    }
    if(failure?.code==='QUOTA'){
     const project=state.projects[claim.project]??{next:0,blocked:0};
     project.blocked=Math.max(project.blocked,now+Math.max(60,failure.delaySeconds)*1000);
     state.projects[claim.project]=project;
    }
   }).catch(()=>{});
  }
 };
 return (question:ShortAnswerDefinition,answer:string,entries=readGradingPool())=>
  gradeWithTemporaryRetry(deadline=>gradeOnce(question,answer,entries,deadline));
}
export const gradeWithPool=createPoolGrader();

export async function gradeWithConfiguredCredentials(uid:string,question:ShortAnswerDefinition,answer:string){
 const entries=readGradingPool();
 if(entries.length)return gradeWithPool(question,answer,entries);
 const {readStudentGeminiKeyForGrading}=await import('./student-gemini-keys.ts');
 const key=await readStudentGeminiKeyForGrading(uid);
 if(!key)throw new GradingError('KEY_MISSING');
 return gradeWithTemporaryRetry(deadline=>gradeWithGemini(key,question,answer,deadline));
}
