import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateCourseGrader,dedicatedCourseId} from './private-course-grading.ts';
import {GradingError} from './gemini-short-answer.ts';
test('only the dedicated exam uses its primary, with normal pool fallback',async()=>{
 const old=process.env.BFOM_EXAM_GRADING_KEY;
 try{
  process.env.BFOM_EXAM_GRADING_KEY='fixture-key-long-enough-for-validation';
  const question={} as any;let calls:string[]=[];const result={grade:{score:1}} as any;
  const fallback=async()=>{calls.push('pool');return result;};
  const success=createPrivateCourseGrader(async()=>{calls.push('primary');return result;},fallback);
  assert.equal(await success(question,'answer',dedicatedCourseId),result);assert.deepEqual(calls,['primary']);
  calls=[];await success(question,'answer','other-exam');assert.deepEqual(calls,['pool']);
  calls=[];await createPrivateCourseGrader(async()=>{calls.push('primary');throw Error('fixture');},fallback)(question,'answer',dedicatedCourseId);assert.deepEqual(calls,['primary','pool']);
  delete process.env.BFOM_EXAM_GRADING_KEY;calls=[];await success(question,'answer',dedicatedCourseId);assert.deepEqual(calls,['pool']);
 }finally{if(old===undefined)delete process.env.BFOM_EXAM_GRADING_KEY;else process.env.BFOM_EXAM_GRADING_KEY=old;}
});
test('dedicated primary caps concurrency at 2, uses a 12s deadline, and cools down on GradingError',async()=>{
 const old=process.env.BFOM_EXAM_GRADING_KEY;
 try{
  process.env.BFOM_EXAM_GRADING_KEY='fixture-key-long-enough-for-validation';
  const question={} as any;const result={grade:{score:1}} as any;
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const deadlines:number[]=[];let primaryCalls=0,fallbackCalls=0;
  const bounded=createPrivateCourseGrader(
   async(_key,_q,_a,deadline)=>{primaryCalls++;deadlines.push((deadline??0)-performance.now());await gate;return result;},
   async()=>{fallbackCalls++;return result;}
  );
  const p1=bounded(question,'a1',dedicatedCourseId);
  const p2=bounded(question,'a2',dedicatedCourseId);
  const p3=bounded(question,'a3',dedicatedCourseId);
  await p3;
  assert.equal(primaryCalls,2);assert.equal(fallbackCalls,1);
  assert.ok(deadlines.every(ms=>ms>0&&ms<=12500),'primary deadline must be capped around 12s');
  release();await Promise.all([p1,p2]);

  let coolPrimary=0,coolFallback=0;
  const cooled=createPrivateCourseGrader(
   async()=>{coolPrimary++;throw new GradingError('QUOTA',30);},
   async()=>{coolFallback++;return result;}
  );
  await cooled(question,'a1',dedicatedCourseId);
  await cooled(question,'a2',dedicatedCourseId);
  assert.equal(coolPrimary,1,'second call during cooldown must bypass primary');
  assert.equal(coolFallback,2);
 }finally{if(old===undefined)delete process.env.BFOM_EXAM_GRADING_KEY;else process.env.BFOM_EXAM_GRADING_KEY=old;}
});

test('dedicated primary trims whitespace in env key and coordinates concurrency & cooldown across instances via shared store',async()=>{
 const old=process.env.BFOM_EXAM_GRADING_KEY;
 try{
  process.env.BFOM_EXAM_GRADING_KEY='  fixture-key-long-enough-for-validation \n';
  const question={} as any;const result={grade:{score:1}} as any;
  const sharedState:Record<string,any>={};
  let now=1_000_000;
  const sharedStore=async<T,>(model:string,change:(state:any,now:number)=>T)=>{
   sharedState[model]??={keys:{},projects:{}};
   return change(sharedState[model],now);
  };
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  let primaryCalls=0,fallbackCalls=0;
  const primary=async()=>{primaryCalls++;await gate;return result;};
  const fallback=async()=>{fallbackCalls++;return result;};
  const instanceA=createPrivateCourseGrader(primary,fallback,sharedStore);
  const instanceB=createPrivateCourseGrader(primary,fallback,sharedStore);

  const p1=instanceA(question,'a1',dedicatedCourseId);
  const p2=instanceB(question,'a2',dedicatedCourseId);
  const p3=instanceB(question,'a3',dedicatedCourseId);
  await p3;
  assert.equal(primaryCalls,2,'Two independent instances must share the concurrency=2 primary cap');
  assert.equal(fallbackCalls,1,'Third request across instances must fail over to pool');
  release();await Promise.all([p1,p2]);

  // Cooldown recorded by instanceA must be respected immediately by instanceB
  let failPrimary=0,failFallback=0;
  const failingA=createPrivateCourseGrader(async()=>{failPrimary++;throw new GradingError('QUOTA',30);},async()=>{failFallback++;return result;},sharedStore);
  const peerB=createPrivateCourseGrader(async()=>{failPrimary++;return result;},async()=>{failFallback++;return result;},sharedStore);
  await failingA(question,'a4',dedicatedCourseId);
  await peerB(question,'a5',dedicatedCourseId);
  assert.equal(failPrimary,1,'Cooldown set by instanceA must suppress primary calls on instanceB');
  assert.equal(failFallback,2);
 }finally{if(old===undefined)delete process.env.BFOM_EXAM_GRADING_KEY;else process.env.BFOM_EXAM_GRADING_KEY=old;}
});
