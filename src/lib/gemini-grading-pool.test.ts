import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createPoolGrader,readGradingPool,type PoolState,type PoolStore} from './gemini-grading-pool.ts';
import {GradingError,gradeWithGemini,shortAnswerModel} from './gemini-short-answer.ts';
import {parseShortAnswerBatch,shortAnswerTemplate} from './short-answer-model.ts';
import {inspectGeminiRateLimit} from './gemini-provider-errors.ts';

const [question]=parseShortAnswerBatch(shortAnswerTemplate);
const fakeKey=(n:number)=>`test-key-not-a-real-google-secret-${n}`;
const config=(n=20,project=(i:number)=>`test-project-${i}`)=>JSON.stringify(Array.from({length:n},(_,i)=>({key:fakeKey(i),project:project(i)})));
function fixture(){
 const state:PoolState={keys:{},projects:{}};let clock=100000,tail=Promise.resolve();
 const store:PoolStore=(model,change)=>{
  const result=tail.then(()=>change(state,clock));tail=result.then(()=>{},()=>{});return result;
 };
 return {state,store,advance:(ms:number)=>{clock+=ms;}};
}
const success=async()=>({model:'gemini-test',grade:{score:1,maxScore:3,feedback:'Saved',points:[]}});
const originalEnv=process.env.GEMINI_GRADING_POOL,originalModel=process.env.GEMINI_GRADING_MODEL,originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;if(originalEnv===undefined)delete process.env.GEMINI_GRADING_POOL;else process.env.GEMINI_GRADING_POOL=originalEnv;if(originalModel===undefined)delete process.env.GEMINI_GRADING_MODEL;else process.env.GEMINI_GRADING_MODEL=originalModel;});

test('accepts 20 credentials; rejects duplicate, oversized, inconsistent and malformed pools without disclosing secrets',()=>{
 assert.equal(readGradingPool(config()).length,20);
 assert.deepEqual(readGradingPool(''),[]);
 const key=fakeKey(0);
 for(const raw of [config(21),JSON.stringify([{key,project:'test-project'},{key,project:'other-project'}]),JSON.stringify([{key,project:'test-project',rpm:0}]),JSON.stringify([{key,project:'test-project',rpm:1},{key:fakeKey(1),project:'test-project',rpm:2}]),JSON.stringify([{key}]),JSON.stringify([{key,project:'test-project',extra:true}]),`{"${key}":`,'[]']){
  assert.throws(()=>readGradingPool(raw),(error:any)=>error.code==='POOL_CONFIG'&&!String(error.stack).includes(key));
 }
});

test('20 simultaneous submissions reserve different keys across instances and release leases without storing secrets',async()=>{
 const {store,state}=fixture(),entries=readGradingPool(config()),seen=new Set<string>();let release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});
 const grade=async(key:string)=>{assert.ok(!seen.has(key));seen.add(key);await gate;return success();};
 const serverA=createPoolGrader(store,grade),serverB=createPoolGrader(store,grade);
 const pending=entries.map((_,i)=>(i%2?serverA:serverB)(question,'Support',entries));
 // Store callback tail and provider microtasks must run before inspecting concurrent work.
 await new Promise(r=>setImmediate(r));
 assert.equal(seen.size,20);
 await assert.rejects(serverA(question,'Support',entries),(e:any)=>e.code==='POOL_BUSY');
 assert.ok(!JSON.stringify(state).includes('test-key'));
 release();await Promise.all(pending);
 assert.ok(Object.values(state.keys).every(k=>k.until===0&&!k.lease));
});

test('same-project keys share spacing and quota cooldown; no hidden second provider request follows a 429',async()=>{
 const {store,advance}=fixture(),entries=readGradingPool(config(2,()=> 'shared-project'));let calls=0;
 const grader=createPoolGrader(store,async()=>{calls++;throw new GradingError('QUOTA',125);});
 await assert.rejects(grader(question,'Support',entries),(e:any)=>e.code==='POOL_QUOTA'&&e.delaySeconds===125);
 advance(12000);
 await assert.rejects(grader(question,'Support',entries),(e:any)=>e.code==='POOL_BUSY'&&e.delaySeconds===113);
 assert.equal(calls,1);
 advance(113001);
 await assert.rejects(grader(question,'Support',entries),(e:any)=>e.code==='POOL_QUOTA');
 assert.equal(calls,2);
});

test('a rejected key pauses and the same grading request uses an eligible credential',async()=>{
 const {store,advance}=fixture(),entries=readGradingPool(config(3)),seen:string[]=[];
 const grader=createPoolGrader(store,async key=>{seen.push(key);if(seen.length===1)throw new GradingError('KEY_OR_ACCESS');return success();});
 await grader(question,'Support',entries);
 advance(1);await grader(question,'Support',entries);
 assert.equal(new Set(seen).size,3);
 advance(13000);await grader(question,'Support',entries);
 assert.notEqual(seen[0],seen[3]);
});

test('quota failure switches projects without retrying a sibling key', async () => {
 const {store}=fixture(), entries=readGradingPool(config(4,i=>i<2?'first-project':'second-project'));
 const seen:string[]=[];
 const grader=createPoolGrader(store, async key => {
  seen.push(entries.find(entry=>entry.key===key)!.project);
  if(seen.length===1)throw new GradingError('QUOTA',60);
  return success();
 });
 await grader(question,'Support',entries);
 assert.equal(seen.length,2);
 assert.notEqual(seen[0],seen[1]);
});

test('a malformed Gemini request does not cool down an otherwise usable API key as invalid', async () => {
 const {store,state}=fixture(), entries=readGradingPool(config(2));
 let calls=0;
 globalThis.fetch=(async()=>{
  calls++;
  return Response.json({error:{status:'INVALID_ARGUMENT'}},{status:400});
 }) as typeof fetch;
 await assert.rejects(createPoolGrader(store)(question,'Support',entries),(e:any)=>e.code==='GEMINI_BAD_REQUEST');
 assert.equal(calls,1,'Changing keys does not fix a malformed payload');
 assert.ok(Object.values(state.keys).every(key=>key.blocked===0));
 globalThis.fetch=(async()=>Response.json({error:{details:[{reason:'API_KEY_INVALID'}]}},{status:400})) as typeof fetch;
 await assert.rejects(gradeWithGemini(fakeKey(0),question,'Support'),(e:any)=>e.code==='KEY_OR_ACCESS');
});

test('expired crashed leases recover; project concurrency prevents parallel work even after spacing',async()=>{
 const {store,state,advance}=fixture(),entries=readGradingPool(JSON.stringify([{key:fakeKey(1),project:'test-project',rpm:10000,concurrency:1},{key:fakeKey(2),project:'test-project',rpm:10000,concurrency:1}]));
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const grader=createPoolGrader(store,async()=>{await gate;return success();});
 const first=grader(question,'Support',entries);await new Promise(r=>setImmediate(r));advance(10);
 await assert.rejects(grader(question,'Support',entries),(e:any)=>e.code==='POOL_BUSY');
 advance(30000);await createPoolGrader(store,success)(question,'Support',entries);
 release();await first;assert.ok(Object.values(state.keys).every(k=>k.until===0));
});

test('provider errors honor Retry-After; requests send a header secret and text-only marking data',async()=>{
 const key=fakeKey(0);let calls=0;
 globalThis.fetch=(async(input:any,options:any)=>{
  calls++;assert.equal(options.headers['x-goog-api-key'],key);assert.ok(!String(input).includes(key));
  const body=JSON.parse(options.body),content=JSON.parse(body.contents[0].parts[0].text);
  assert.deepEqual(Object.keys(content).sort(),['model_answer','question','rubric','student_answer']);
  assert.ok(!JSON.stringify(body).includes('secret-image'));
  return Response.json({error:{message:key,details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaMetric:'generativelanguage.googleapis.com/generate_content_free_tier_requests',quotaId:'GenerateRequestsPerDayPerProjectPerModel-FreeTier',quotaValue:'20'}]}]}},{status:429,headers:{'Retry-After':'180'}});
 }) as typeof fetch;
 await assert.rejects(gradeWithGemini(key,{...question,images:[{id:'a'.repeat(64),source:'secret-image',alt:''}]},'Support'),(e:any)=>e.code==='QUOTA'&&e.delaySeconds===180&&!String(e).includes(key));
 assert.equal(calls,1);
});

test('successful grade survives a failed lease release; no blind provider retry on uncertain failures',async()=>{
 const {store}=fixture();let updates=0,calls=0;
 const flaky:PoolStore=(model,change)=>{if(++updates===2)return Promise.reject(new Error('database down'));return store(model,change);};
 const result=await createPoolGrader(flaky,async()=>{calls++;return success();})(question,'Support',readGradingPool(config(1)));
 assert.equal(result.grade.score,1);assert.equal(calls,1);
 const other=fixture();
 await assert.rejects(createPoolGrader(other.store,async()=>{calls++;throw new Error('secret upstream error');})(question,'Support',readGradingPool(config(1))),(e:any)=>e.code==='UNAVAILABLE'&&!String(e).includes('secret'));
 assert.equal(calls,2);
});

test('an upstream outage keeps its diagnostic code after passing through the shared pool',async()=>{
 const {store}=fixture();
 let calls=0;
 globalThis.fetch=(async()=>{
  calls++;
  return Response.json({error:{message:'Provider unavailable'}},{status:503});
 }) as typeof fetch;
 await assert.rejects(createPoolGrader(store)(question,'Support',readGradingPool(config(1))),
  (error:any)=>error.code==='GEMINI_UNAVAILABLE'&&error.delaySeconds===10);
 assert.equal(calls,1);
});

test('a temporary Gemini outage retries once using another eligible key and returns the grade',async()=>{
 const {store,state}=fixture(),entries=readGradingPool(config(2)),seen:string[]=[];
 globalThis.fetch=(async(_url,init)=>{
  seen.push(new Headers(init?.headers).get('x-goog-api-key')!);
  if(seen.length===1)return new Response(null,{status:503});
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({
   feedback:'Correct',points:question.rubric.map(point=>({id:point.id,awarded:point.marks,feedback:'Correct'})),
  })}]}}]});
 }) as typeof fetch;
 const result=await createPoolGrader(store)(question,'Support',entries);
 assert.equal(result.grade.score,result.grade.maxScore);
 assert.equal(seen.length,2);
 assert.notEqual(seen[0],seen[1]);
 assert.ok(Object.values(state.keys).every(key=>key.until===0&&!key.lease));
});

test('a second outage stops after two calls; a longer Retry-After defers grading',async()=>{
 const entries=readGradingPool(config(3));
 let calls=0,retryAfter='0';
 globalThis.fetch=(async()=>{
  calls++;
  return new Response(null,{status:503,headers:{'Retry-After':retryAfter}});
 }) as typeof fetch;
 await assert.rejects(createPoolGrader(fixture().store)(question,'Support',entries),
  (error:any)=>error.code==='GEMINI_UNAVAILABLE'&&error.delaySeconds===10);
 assert.equal(calls,2);
 retryAfter='30';
 await assert.rejects(createPoolGrader(fixture().store)(question,'Support',entries),
  (error:any)=>error.code==='GEMINI_UNAVAILABLE'&&error.delaySeconds===30);
 assert.equal(calls,3);
});

test('replacing a key cannot bypass a running project lease',async()=>{
 const {store,advance}=fixture();
 const old=readGradingPool(JSON.stringify([{key:fakeKey(1),project:'same-project',rpm:10000,concurrency:1}]));
 const replacement=readGradingPool(JSON.stringify([{key:fakeKey(2),project:'same-project',rpm:10000,concurrency:1}]));
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const running=createPoolGrader(store,async()=>{await gate;return success();})(question,'Support',old);
 await new Promise(r=>setImmediate(r));advance(10);
 try{await assert.rejects(createPoolGrader(store,success)(question,'Support',replacement),(e:any)=>e.code==='POOL_BUSY');}
 finally{release();await running;}
 await createPoolGrader(store,success)(question,'Support',replacement);
});

test('a shared model-access failure never asks the student to change their Google project',async()=>{
 const {store}=fixture();
 await assert.rejects(createPoolGrader(store,async()=>{throw new GradingError('MODEL_UNAVAILABLE',15);})(question,'Support',readGradingPool(config(1))),(e:any)=>e.code==='POOL_MODEL_UNAVAILABLE');
});

test('a slow provider receives the full budget and an uncertain timeout does not duplicate grading',async()=>{
 const {store,state}=fixture(),entries=readGradingPool(config(3)),seen:string[]=[],budgets:number[]=[];
 const grader=createPoolGrader(store,async(key,_question,_answer,deadline)=>{
  seen.push(key);budgets.push(deadline!-performance.now());
  if(seen.length===1)throw new GradingError('TIMEOUT',10);
  return success();
 });
 await assert.rejects(grader(question,'Support',entries),(e:any)=>e.code==='TIMEOUT');
 assert.equal(seen.length,1);
 assert.ok(budgets[0]>21000&&budgets[0]<=22000);
 assert.ok(Object.values(state.keys).every(key=>key.until===0));
 assert.equal(state.keys[entries.find(e=>e.key===seen[0])!.id].blocked,110000);
});

test('a timeout makes only one provider call; a single-key pool keeps its full request budget',async()=>{
 let calls=0;
 await assert.rejects(createPoolGrader(fixture().store,async()=>{
  calls++;throw new GradingError('TIMEOUT',10);
 })(question,'Support',readGradingPool(config(4))),(e:any)=>e.code==='TIMEOUT'&&e.delaySeconds===10);
 assert.equal(calls,1);
 await createPoolGrader(fixture().store,async(_key,_question,_answer,deadline)=>{
  assert.ok(deadline!-performance.now()>21000);return success();
 })(question,'Support',readGradingPool(config(1)));
});

test('several quota-exhausted projects cannot hide an available grading key',async()=>{
 const {store,state}=fixture(),entries=readGradingPool(config(4)),seen:string[]=[];
 await createPoolGrader(store,async key=>{
  seen.push(key);if(seen.length<4)throw new GradingError('QUOTA',180);return success();
 })(question,'Support',entries);
 assert.equal(new Set(seen).size,4);
 assert.equal(Object.values(state.projects).filter(p=>p.blocked===280000).length,3);
 assert.ok(Object.values(state.keys).every(key=>key.until===0));
});

test('an exhausted pool reports the quota failure once every project has been checked',async()=>{
 let calls=0;const {store}=fixture();
 await assert.rejects(createPoolGrader(store,async()=>{
  calls++;throw new GradingError('QUOTA',180);
 })(question,'Support',readGradingPool(config(4))),(e:any)=>e.code==='POOL_QUOTA'&&e.delaySeconds===180);
 assert.equal(calls,4);
});

test('an aborted provider response body returns a retryable timeout',async()=>{
 const keepAlive=setTimeout(()=>{},1000);
 globalThis.fetch=(async(_url,init)=>new Response(new ReadableStream({start(controller){
  init!.signal!.addEventListener('abort',()=>controller.error(new DOMException('Timed out','TimeoutError')),{once:true});
 }}),{status:200})) as typeof fetch;
 try{await assert.rejects(gradeWithGemini(fakeKey(1),question,'Support',performance.now()+30),
  (e:any)=>e.code==='TIMEOUT'&&e.delaySeconds===10);}finally{clearTimeout(keepAlive);}
});

test('sequential requests rotate through configured slots and wrap in order',async()=>{
 const {store,advance}=fixture(),entries=readGradingPool(config(3)),seen:string[]=[];
 const grader=createPoolGrader(store,async key=>{seen.push(key);return success();});
 for(let i=0;i<6;i++){await grader(question,'Support',entries);advance(12001);}
 assert.deepEqual(seen,[...entries,...entries].map(entry=>entry.key));
});

test('round-robin skips unavailable slots without resetting the cursor',async()=>{
 const {store,state,advance}=fixture(),entries=readGradingPool(config(3)),seen:string[]=[];
 state.keys[entries[1].id]={until:0,used:0,blocked:120000};
 const grader=createPoolGrader(store,async key=>{seen.push(key);return success();});
 await grader(question,'Support',entries);await grader(question,'Support',entries);
 assert.deepEqual(seen,[entries[0].key,entries[2].key]);
 advance(20001);await grader(question,'Support',entries);await grader(question,'Support',entries);
 assert.deepEqual(seen.slice(2),[entries[0].key,entries[1].key]);
});

test('429 without a quota violation is throttling, not proof of quota exhaustion',()=>{
 const failure=inspectGeminiRateLimit({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'Too many requests. Try again later.'}},null);
 assert.equal(failure.code,'THROTTLED');assert.equal(failure.delaySeconds,10);
 assert.deepEqual(failure.diagnostics.quotaViolations,[]);assert.equal(failure.diagnostics.explicitQuota,false);
 assert.equal(inspectGeminiRateLimit(null,null).code,'THROTTLED');
});

test('structured quota failures preserve the actual limit and provider retry interval without logging secrets',()=>{
 const body={error:{message:fakeKey(1)+' private student answer',status:'RESOURCE_EXHAUSTED',details:[
  {'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaMetric:'generativelanguage.googleapis.com/input_tokens',quotaId:'TokensPerMinute',quotaValue:'1000'}]},
  {'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'125.5s'},
 ]}};
 const failure=inspectGeminiRateLimit(body,null);
 assert.equal(failure.code,'QUOTA');assert.equal(failure.delaySeconds,126);
 assert.equal(failure.diagnostics.quotaViolations[0].limit,'TokensPerMinute');
 assert.doesNotMatch(JSON.stringify(failure),/test-key|private student answer/);
 assert.equal(inspectGeminiRateLimit({error:{code:'too_many_requests'}},'180').delaySeconds,180);
});

test('ambiguous throttling makes at most two calls and leaves independent healthy projects eligible',async()=>{
 const {store,state}=fixture(),entries=readGradingPool(config(14));let calls=0;
 globalThis.fetch=(async()=>{calls++;return Response.json({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'Too many requests'}},{status:429});}) as typeof fetch;
 const grader=createPoolGrader(store);
 await assert.rejects(grader(question,'Support',entries),(e:any)=>e.code==='POOL_RATE_LIMIT'&&e.delaySeconds===10);
 assert.equal(calls,2);assert.equal(Object.keys(state.keys).length,2);
 assert.ok(Object.values(state.projects).every(p=>p.blocked===0));
 globalThis.fetch=(async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({feedback:'Correct',points:question.rubric.map(p=>({id:p.id,awarded:p.marks,feedback:'Correct'}))})}]}}]});}) as typeof fetch;
 // Older deployments wrote a global cooldown; a stale value must not block healthy projects now.
 Object.assign(state,{throttle:{since:100000,count:2,blocked:999999}});
 await grader(question,'Support',entries);
 assert.equal(calls,3,'The next request immediately uses the next healthy project');
});

test('one transient throttle can recover on the next slot without a project quota penalty',async()=>{
 const {store,state}=fixture(),entries=readGradingPool(config(3));let calls=0;
 globalThis.fetch=(async()=>{
  calls++;if(calls===1)return Response.json({error:{message:'Too many requests'}},{status:429});
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({feedback:'Correct',points:question.rubric.map(p=>({id:p.id,awarded:p.marks,feedback:'Correct'}))})}]}}]});
 }) as typeof fetch;
 await createPoolGrader(store)(question,'Support',entries);
 assert.equal(calls,2);assert.ok(Object.values(state.projects).every(p=>p.blocked===0));
});

test('provider messages retain the rejection explanation while redacting credentials and grading content',()=>{
 const key=fakeKey(1),answer='private student answer';
 const error={code:429,status:'RESOURCE_EXHAUSTED',message:`Quota exceeded for GenerateRequestsPerDay. ${key} ${answer} contact a@example.invalid project 123456789012 https://example.invalid/?key=${key}`};
 const details=inspectGeminiRateLimit({error},null,Date.now(),[key,answer]).diagnostics;
 assert.match(details.providerMessage!,/Quota exceeded for GenerateRequestsPerDay/);
 assert.equal(details.providerCode,429);
 assert.doesNotMatch(JSON.stringify(details),/test-key|private student answer|a@example|123456789012|https:/);
});

test('plain-text quota messages classify as QUOTA and per-minute RetryInfo avoids 60s clamp while keeping 60s fallback',()=>{
 const plain=inspectGeminiRateLimit({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'You exceeded your current quota, please check your plan.'}},null);
 assert.equal(plain.code,'QUOTA');assert.equal(plain.delaySeconds,60);assert.equal(plain.diagnostics.explicitQuota,true);
 const rpmWithDelay=inspectGeminiRateLimit({error:{code:429,status:'RESOURCE_EXHAUSTED',details:[
  {'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaMetric:'generativelanguage.googleapis.com/input_tokens',quotaId:'TokensPerMinute',quotaValue:'1000'}]},
  {'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'12s'},
 ]}},null);
 assert.equal(rpmWithDelay.code,'QUOTA');assert.equal(rpmWithDelay.delaySeconds,12);
 const rpmWithoutDelay=inspectGeminiRateLimit({error:{code:429,status:'RESOURCE_EXHAUSTED',details:[
  {'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaMetric:'generativelanguage.googleapis.com/input_tokens',quotaId:'TokensPerMinute',quotaValue:'1000'}]},
 ]}},null);
 assert.equal(rpmWithoutDelay.code,'QUOTA');assert.equal(rpmWithoutDelay.delaySeconds,60);
 const dailyWithShortDelay=inspectGeminiRateLimit({error:{code:429,status:'RESOURCE_EXHAUSTED',details:[
  {'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaMetric:'generativelanguage.googleapis.com/requests',quotaId:'GenerateRequestsPerDay',quotaValue:'20'}]},
  {'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'12s'},
 ]}},null);
 assert.equal(dailyWithShortDelay.code,'QUOTA');assert.equal(dailyWithShortDelay.delaySeconds,60);
});

test('shortAnswerModel normalizes whitespace and models/ prefix; gradeWithGemini strips JSON fences and honors 5xx RetryInfo',async()=>{
 process.env.GEMINI_GRADING_MODEL='  models/gemini-2.5-flash  \n';
 assert.equal(shortAnswerModel(),'gemini-2.5-flash');
 globalThis.fetch=(async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'```json\n'+JSON.stringify({
  feedback:'Correct',points:question.rubric.map(point=>({id:point.id,awarded:point.marks,feedback:'Correct'})),
 })+'\n```'}]}}]})) as typeof fetch;
 const graded=await gradeWithGemini(fakeKey(0),question,'Support');
 assert.equal(graded.model,'gemini-2.5-flash');assert.equal(graded.grade.score,graded.grade.maxScore);
 globalThis.fetch=(async()=>Response.json({error:{status:'UNAVAILABLE',details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'25s'}]}},{status:503})) as typeof fetch;
 await assert.rejects(gradeWithGemini(fakeKey(0),question,'Support'),(e:any)=>e.code==='GEMINI_UNAVAILABLE'&&e.delaySeconds===25&&e.retryAfterMs===25000);
});

test('readGradingPool memoizes by raw config string and invalidates when changed',()=>{
 const rawA=config(2),rawB=config(3);
 assert.equal(readGradingPool(rawA),readGradingPool(rawA));
 assert.notEqual(readGradingPool(rawA),readGradingPool(rawB));
});

test('ambiguous 429 with long Retry-After still retries on a second healthy key in a multi-key pool',async()=>{
 const {store,state}=fixture(),entries=readGradingPool(config(3)),seen:string[]=[];
 globalThis.fetch=(async(_url,init)=>{
  seen.push(new Headers(init?.headers).get('x-goog-api-key')!);
  if(seen.length===1)return Response.json({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'Too many requests'}},{status:429,headers:{'Retry-After':'15'}});
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({feedback:'Correct',points:question.rubric.map(p=>({id:p.id,awarded:p.marks,feedback:'Correct'}))})}]}}]});
 }) as typeof fetch;
 const result=await createPoolGrader(store)(question,'Support',entries);
 assert.equal(result.grade.score,result.grade.maxScore);
 assert.equal(seen.length,2);assert.notEqual(seen[0],seen[1]);
 assert.equal(state.keys[entries[0].id].blocked,115000);
 assert.equal(state.projects[entries[0].project].blocked,0);
});

test('failover preserves retryAfterMs after a quota rejection so temporary retry can reach a third key',async()=>{
 const {store}=fixture(),entries=readGradingPool(config(3)),seen:string[]=[];
 const grader=createPoolGrader(store,async key=>{
  seen.push(key);
  if(seen.length===1)throw new GradingError('QUOTA',60);
  if(seen.length===2)throw new GradingError('THROTTLED',15,15000);
  return success();
 });
 const result=await grader(question,'Support',entries);
 assert.equal(result.grade.score,1);
 assert.equal(seen.length,3);assert.equal(new Set(seen).size,3);
});

test('INVALID_RESPONSE does not block keys; KEY_OR_ACCESS cools down for 60s and resets project spacing',async()=>{
 const {store,state}=fixture(),entries=readGradingPool(config(2));
 await assert.rejects(createPoolGrader(store,async()=>{throw new GradingError('INVALID_RESPONSE',10);})(question,'Support',entries),(e:any)=>e.code==='INVALID_RESPONSE');
 assert.equal(state.keys[entries[0].id].blocked,0);
 const {store:store2,state:state2}=fixture();
 let calls=0;
 await createPoolGrader(store2,async()=>{
  calls++;if(calls===1)throw new GradingError('KEY_OR_ACCESS',10);
  return success();
 })(question,'Support',entries);
 assert.equal(state2.keys[entries[0].id].blocked,160000);
 assert.equal(state2.projects[entries[0].project].next,0);
 const {store:store3,state:state3}=fixture();
 await assert.rejects(createPoolGrader(store3,async()=>{throw new GradingError('GEMINI_BAD_REQUEST',60);})(question,'Support',entries),(e:any)=>e.code==='GEMINI_BAD_REQUEST');
 assert.equal(state3.keys[entries[0].id].blocked,0);
 assert.equal(state3.projects[entries[0].project].next,0);
});

test('per-minute QUOTA honors short RetryInfo project cooldown instead of clamping to 60s while preserving 60s fallback',async()=>{
 const {store,state}=fixture(),entries=readGradingPool(config(1));
 await assert.rejects(createPoolGrader(store,async()=>{throw new GradingError('QUOTA',12);})(question,'Support',entries),(e:any)=>e.code==='POOL_QUOTA'&&e.delaySeconds===12);
 assert.equal(state.projects[entries[0].project].blocked,112000);
 assert.equal(state.keys[entries[0].id].blocked,112000);
 const {store:store2,state:state2}=fixture();
 await assert.rejects(createPoolGrader(store2,async()=>{throw new GradingError('QUOTA',0);})(question,'Support',entries),(e:any)=>e.code==='POOL_QUOTA');
 assert.equal(state2.projects[entries[0].project].blocked,160000);
});

test('brief RPM spacing-only waits smooth in-request without failing concurrent students',async()=>{
 const state:PoolState={keys:{},projects:{}};
 let storeCalls=0;
 const liveStore:PoolStore=async(_model,change)=>{storeCalls++;return change(state,Date.now());};
 // rpm=300 => 200ms spacing between requests; fast provider releases lease quickly so 2nd request hits spacingOnly<=200ms
 const entries=readGradingPool(JSON.stringify([{key:fakeKey(1),project:'burst-project',rpm:300,concurrency:1}]));
 const grader=createPoolGrader(liveStore,async()=>{
  await new Promise(r=>setTimeout(r,15));
  return success();
 });
 await grader(question,'Student 1',entries);
 const second=await grader(question,'Student 2',entries);
 assert.equal(second.grade.score,1);
 assert.ok(storeCalls<=6,'spacing-only wait should complete with minimal DB transactions');
});

test('active-lease saturation fails fast with POOL_BUSY in 1 DB claim instead of spin-polling',async()=>{
 const state:PoolState={keys:{},projects:{}};
 let claimAttempts=0;
 const liveStore:PoolStore=async(_model,change)=>{claimAttempts++;return change(state,Date.now());};
 const entries=readGradingPool(JSON.stringify([{key:fakeKey(1),project:'sat-project',rpm:600,concurrency:1}]));
 let release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});
 const grader=createPoolGrader(liveStore,async()=>{await gate;return success();});
 const inFlight=grader(question,'Holder',entries);
 await new Promise(r=>setTimeout(r,15));
 const beforeBurst=claimAttempts;
 const burstResults=await Promise.allSettled(
  Array.from({length:5},(_,i)=>grader(question,`Waiter ${i}`,entries))
 );
 const burstClaims=claimAttempts-beforeBurst;
 assert.ok(burstResults.every(r=>r.status==='rejected'&&(r.reason as any)?.code==='POOL_BUSY'),
  'All burst requests during active lease saturation must fail fast with POOL_BUSY');
 assert.equal(burstClaims,5,'Each saturated request must perform exactly 1 DB claim transaction (no 9x lock spin-polling)');
 release();
 assert.equal((await inFlight).grade.score,1);
});
