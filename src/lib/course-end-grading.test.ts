import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
test('end-only courses save freely but withhold every key and grade until final submission',async()=>{
 assert.ok(/@127\.0\.0\.1:/.test(process.env.DATABASE_URL||'')||process.env.COURSE_END_GRADING_LIVE_FIXTURE==='1');
 process.env.NODE_ENV='test';process.env.AUTH_SESSION_SECRET='private-course-end-grading-isolated-secret';
 const {hashPasswordAsync}=await import('../middleware/auth.ts');process.env.IMPULSE_PUBLISHER_PASSWORD_HASH=await hashPasswordAsync('Publisher-Test-Password');
 const {pool}=await import('../db/index.ts'),{impulseRouter}=await import('./impulse-routes.ts'),{default:express}=await import('express');let grades=0;
 const app=express();app.use(impulseRouter(null,async(q,a)=>{grades++;return {model:'fixture',grade:{score:1,maxScore:1,feedback:'Correct',points:q.rubric.map(p=>({...p,awarded:1,feedback:'Correct'}))}};},(req,res,next)=>{(req as any).user={uid:'end-course-test'};next();}));
 const http=app.listen(0,'127.0.0.1');await new Promise<void>(r=>http.once('listening',r));const origin='http://127.0.0.1:'+(http.address() as any).port;
 const call=async(p:string,b?:any,cookie='')=>{const r=await fetch(origin+'/api/impulse'+p,{method:b===undefined?'GET':'POST',headers:{'X-Impulse-Request':'1','Content-Type':'application/json',Cookie:cookie},body:b===undefined?undefined:JSON.stringify(b)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''};};let id:string|undefined;
 try{
  const pub=(await call('/publisher/login',{password:'Publisher-Test-Password'})).cookie;
  const quiz=(await call('/publisher/quizzes',{title:'End grading fixture '+randomUUID(),password:'Student-Password',publish:true,questions:[{type:'mcq',text:'Choose yes',options:['Yes','No'],correct:0,explanation:'Secret explanation'},{type:'short_answer',text:'Name a function',rubric:[{description:'Support',marks:1}]}]},pub)).data;id=quiz.id;
  await pool.query('UPDATE impulse.quizzes SET grade_on_submit=true WHERE id=$1',[id]);
  const cookie=(await call('/quiz/'+quiz.slug+'/unlock',{password:'Student-Password'})).cookie;
  const read=async()=> (await call('/quiz/'+quiz.slug+'/session',undefined,cookie)).data;
  let s=await read();assert.equal(s.gradeOnSubmit,true);const [m,w]=s.questions;
  assert.equal(s.questions[0].study_feedback,null);assert.equal(JSON.stringify(s).includes('Secret explanation'),false);
  const save=await call(`/quiz/${quiz.slug}/answer/${m.id}`,{answer:0},cookie);assert.equal(save.data.result,undefined);
  await call(`/quiz/${quiz.slug}/answer/${w.id}`,{answer:'Support'},cookie);
  assert.equal((await call(`/quiz/${quiz.slug}/grade/${w.id}`,{},cookie)).status,409);assert.equal(grades,0);
  s=await read();assert.ok(s.states.every((x:any)=>x.score===null));assert.equal(s.questions[0].answer,0);assert.equal(s.questions[1].answer,'Support');
  await call('/quiz/'+quiz.slug+'/submit',{},cookie);s=await read();assert.equal(s.completed,true);assert.equal(s.questions[0].result.score,1);assert.equal(s.questions[0].study_feedback.correctOption,0);
  assert.equal((await call(`/quiz/${quiz.slug}/answer/${m.id}`,{answer:1},cookie)).status,409);
  assert.equal((await call(`/quiz/${quiz.slug}/grade/${w.id}`,{},cookie)).data.result.score,1);assert.equal(grades,1);
  await call(`/quiz/${quiz.slug}/grade/${w.id}`,{},cookie);assert.equal(grades,1);
 }finally{
  if(id){await pool.query('DELETE FROM impulse.answers WHERE attempt_id IN(SELECT id FROM impulse.attempts WHERE quiz_id=$1)',[id]);await pool.query('DELETE FROM impulse.attempts WHERE quiz_id=$1',[id]);await pool.query('UPDATE impulse.quizzes SET published_version=NULL WHERE id=$1',[id]);await pool.query('DELETE FROM impulse.questions WHERE version_id IN(SELECT id FROM impulse.versions WHERE quiz_id=$1)',[id]);await pool.query('DELETE FROM impulse.versions WHERE quiz_id=$1',[id]);await pool.query('DELETE FROM impulse.quizzes WHERE id=$1',[id]);}
  http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()));await pool.end();
 }
});


