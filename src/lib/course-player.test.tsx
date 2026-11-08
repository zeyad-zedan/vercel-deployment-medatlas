import React,{act} from 'react';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

test('private quizzes use the lecture player, preserve text across navigation and devices, and keep public session state safe',async()=>{
  assert.equal(new URL(process.env.DATABASE_URL!).port,'56350','Use the isolated Impulse test database only.');
  process.env.NODE_ENV='test';process.env.AUTH_SESSION_SECRET='isolated_course_player_secret_at_least_32_chars';
  const {hashPasswordAsync}=await import('../middleware/auth.ts');process.env.IMPULSE_PUBLISHER_PASSWORD_HASH=await hashPasswordAsync('Publisher-Test-Password');
  const {pool}=await import('../db/index.ts'),{impulseRouter}=await import('./impulse-routes.ts'),{default:express}=await import('express');
  let gradeCalls=0;
  const app=express();app.use(impulseRouter(null,async(question,answer)=>{
    gradeCalls++;assert.equal(answer,'Support');assert.equal('images' in question,false);
    return {model:'test',grade:{score:1,maxScore:1,feedback:'Correct',points:question.rubric.map(p=>({...p,awarded:1,feedback:'Correct'}))}};
  },(req,res,next)=>{if(req.get('Authorization')!=='Bearer course-test-student')return void res.status(401).json({error:'Sign in to MedAtlas.'});(req as any).user={uid:'course-student'};next();}));
  const http=app.listen(0,'127.0.0.1');await new Promise<void>(r=>http.once('listening',r));const origin=`http://127.0.0.1:${(http.address() as any).port}`;
  const nativeFetch=globalThis.fetch;
  const call=async(path:string,body?:any,cookie='')=>{const r=await nativeFetch(origin+'/api/impulse'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer course-test-student',Cookie:cookie,'Content-Type':'application/json','X-Impulse-Request':'1'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''};};
  const publisher=(await call('/publisher/login',{password:'Publisher-Test-Password'})).cookie;
  const quiz=(await call('/publisher/quizzes',{title:'Shared player test',password:'Student-Password',publish:true,questions:[
    {type:'mcq',text:'Choose the sixth option.',options:['One','Two','Three','Four','Five','Six'],correct:5,explanation:'Six is correct.'},
    {type:'short_answer',text:'Name a bone function.',rubric:[{description:'Support',marks:1}]},
    ...Array.from({length:6},(_,i)=>({type:'mcq',text:`Batch question ${i+3}`,options:['Yes','No'],correct:0})),
  ]},publisher)).data;
  const {JSDOM}=createRequire(import.meta.url)('jsdom'),dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:origin});
  const previous=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  dom.window.HTMLElement.prototype.scrollTo=()=>{};dom.window.scrollTo=()=>{};
  const {createRoot}=await import('react-dom/client'),{default:CourseQuizView}=await import('../components/CourseQuizView.tsx'),{setAuthToken}=await import('./api.ts');
  setAuthToken('course-test-student');localStorage.setItem('medatlas_active_session_id','12345');
  localStorage.setItem('medatlas_session_draft_answers_12345','{"answers":{"9":"A"}}');
  let cookie='',reads=0,active=0;const requests:string[]=[];
  globalThis.fetch=(async(input:any,init:any={})=>{
    const path=String(input);assert.ok(path.startsWith('/api/impulse/'),'Private controls must not call public session/bookmark APIs.');requests.push(path);
    if(path.includes('/session'))reads++;
    active++;const response=await nativeFetch(origin+path,{...init,headers:{...init.headers,Cookie:cookie}}).finally(()=>active--);
    const next=response.headers.get('set-cookie');if(next)cookie=next.split(';')[0];return response;
  }) as typeof fetch;
  const host=()=>document.getElementById('root')!;
  const waitFor=async(check:()=>boolean)=>{const end=Date.now()+4000;while(!check()&&Date.now()<end)await act(async()=>{await new Promise(r=>setTimeout(r,25));});assert.ok(check(),host().textContent||'Missing UI');};
  const click=async(label:string)=>{const b=[...host().querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent?.trim()===label);assert.ok(b,label);await act(async()=>{b.click();await new Promise(r=>setTimeout(r,40));});await act(async()=>{await new Promise(r=>setTimeout(r,20));});await waitFor(()=>active===0);};
  const enter=async(selector:string,value:string)=>{const input=host().querySelector(selector)!;assert.ok(input,selector);await act(async()=>{const prototype=input.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});};
  let root=createRoot(host());
  try{
    await act(async()=>{root.render(<CourseQuizView slug={quiz.slug} onSignIn={()=>assert.fail('Already signed in')}/>);await new Promise(r=>setTimeout(r,60));});
    await act(async()=>{await new Promise(r=>setTimeout(r,80));});
    await enter('input[type=password]','Student-Password');await act(async()=>{host().querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,80));});
    await waitFor(()=>Boolean(host().querySelector('.ma-study-player')));assert.equal(host().querySelectorAll('[role=radiogroup] > div').length,6);
    await act(async()=>{(host().querySelectorAll('[role=radiogroup] > div')[5] as HTMLElement).click();await new Promise(r=>setTimeout(r,60));});
    assert.match(host().textContent||'',/Correct Answer!/);assert.match(host().textContent||'',/Option F/);
    await click('Next Question');await enter('textarea',' Support ');await click('Next Question');
    const saved=(await call(`/quiz/${quiz.slug}/session`,undefined,cookie)).data;
    assert.equal(saved.questions[1].answer,'Support');assert.equal(saved.current,2);
    const readsBeforePrevious=reads;await click('Previous Question');assert.equal((host().querySelector('textarea') as HTMLTextAreaElement).value,'Support');assert.equal(reads,readsBeforePrevious,'Back navigation reuses loaded content.');
    await click('Save & grade');await waitFor(()=>Boolean(host().querySelector('[aria-label="Short-answer feedback"]')));assert.match(host().textContent||'',/1\/1 marks/);assert.equal(gradeCalls,1);
    assert.ok(host().querySelector('button[title="Question 2: Solved (Current)"]'));
    await click('Next Question');await click('Next Question');await click('Next Question');await click('Next Question');
    assert.equal(requests.filter(p=>p.includes('offset=6')).length,1,'Exactly one next batch is prefetched.');
    await click('Next Question');assert.match(host().textContent||'',/Batch question 7/);
    await click('Exit');assert.equal(localStorage.getItem('medatlas_active_session_id'),'12345');
    assert.equal(localStorage.getItem('medatlas_session_draft_answers_12345'),'{"answers":{"9":"A"}}');
    await act(async()=>root.unmount());cookie='';root=createRoot(host());
    await act(async()=>{root.render(<CourseQuizView slug={quiz.slug} onSignIn={()=>assert.fail('Already signed in')}/>);await new Promise(r=>setTimeout(r,50));});
    await act(async()=>{await new Promise(r=>setTimeout(r,80));});
    await enter('input[type=password]','Student-Password');await act(async()=>{host().querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,70));});
    await waitFor(()=>Boolean(host().querySelector('.ma-study-player')));
    assert.match(host().textContent||'',/Batch question 7/);
    await click('2');await waitFor(()=>Boolean(host().querySelector('textarea')));assert.equal((host().querySelector('textarea') as HTMLTextAreaElement).value,'Support');assert.match(host().textContent||'',/1\/1 marks/);assert.equal(gradeCalls,1);
    await click('8');await click('Finish Session');await click('Confirm & Submit');await waitFor(()=>Boolean(host().textContent?.includes('Session Completed')));
    const completed=(await call(`/quiz/${quiz.slug}/session?offset=0`,undefined,cookie)).data;assert.equal(completed.completed,true);assert.equal(completed.questions[0].answer,5);assert.equal(completed.questions[1].answer,'Support');
  }finally{
    await act(async()=>root.unmount());globalThis.fetch=nativeFetch;setAuthToken(null);dom.window.close();
    await new Promise<void>(r=>http.close(()=>r()));
    await pool.query('DELETE FROM impulse.answers WHERE attempt_id IN(SELECT id FROM impulse.attempts WHERE quiz_id=$1)',[quiz.id]);await pool.query('DELETE FROM impulse.attempts WHERE quiz_id=$1',[quiz.id]);await pool.query('UPDATE impulse.quizzes SET published_version=NULL WHERE id=$1',[quiz.id]);await pool.query('DELETE FROM impulse.questions WHERE version_id IN(SELECT id FROM impulse.versions WHERE quiz_id=$1)',[quiz.id]);await pool.query('DELETE FROM impulse.versions WHERE quiz_id=$1',[quiz.id]);await pool.query('DELETE FROM impulse.quizzes WHERE id=$1',[quiz.id]);await pool.end();
    for(const [key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete(globalThis as any)[key];}
  }
});
