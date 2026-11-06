import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createPoolGrader,readGradingPool,type PoolState,type PoolStore} from './gemini-grading-pool.ts';
import {GradingError,gradeWithGemini} from './gemini-short-answer.ts';
import {parseShortAnswerBatch,shortAnswerTemplate} from './short-answer-model.ts';

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
const originalEnv=process.env.GEMINI_GRADING_POOL,originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;if(originalEnv===undefined)delete process.env.GEMINI_GRADING_POOL;else process.env.GEMINI_GRADING_POOL=originalEnv;});

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
 await assert.rejects(grader(question,'Support',entries),(e:any)=>e.code==='POOL_BUSY');
 assert.equal(calls,1);
 advance(113001);
 await assert.rejects(grader(question,'Support',entries),(e:any)=>e.code==='POOL_QUOTA');
 assert.equal(calls,2);
});

test('least recently used selection rotates keys; rejected key pauses while another project remains usable',async()=>{
 const {store,advance}=fixture(),entries=readGradingPool(config(3)),seen:string[]=[];
 const grader=createPoolGrader(store,async key=>{seen.push(key);if(seen.length===1)throw new GradingError('KEY_OR_ACCESS');return success();});
 await assert.rejects(grader(question,'Support',entries),(e:any)=>e.code==='POOL_ACCESS');
 for(let i=0;i<2;i++){advance(1);await grader(question,'Support',entries);}
 assert.equal(new Set(seen).size,3);
 advance(13000);await grader(question,'Support',entries);
 assert.notEqual(seen[0],seen[3]);
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
  return Response.json({error:{message:key}},{status:429,headers:{'Retry-After':'180'}});
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
