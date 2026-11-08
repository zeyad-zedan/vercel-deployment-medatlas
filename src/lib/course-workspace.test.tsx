import React,{act} from 'react';import {test,after} from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {courseQuizSlug} from './course-quiz-route.ts';
const {JSDOM}=createRequire(import.meta.url)('jsdom');const dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:'https://medatlas-exam.vercel.app/impulse/quiz/rGUlS5t9CR4TEoDbGu6mZL2P'});
const previous=new Map<string,PropertyDescriptor|undefined>();for(const [name,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});}
dom.window.HTMLElement.prototype.scrollTo=()=>{};dom.window.scrollTo=()=>{};
const {createRoot}=await import('react-dom/client'),{default:CourseQuizView}=await import('../components/CourseQuizView.tsx'),{PublicLanding}=await import('../components/PublicLanding.tsx'),{setAuthToken}=await import('./api.ts');
const realFetch=globalThis.fetch,slug='rGUlS5t9CR4TEoDbGu6mZL2P',host=()=>document.getElementById('root')!;
const click=async(name:string)=>{const button=[...host().querySelectorAll('button')].find(b=>b.textContent?.trim()===name);assert.ok(button,name);await act(async()=>button.click());};
after(()=>{globalThis.fetch=realFetch;dom.window.close();for(const [name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete(globalThis as any)[name];}});
test('course links are recognized without turning ordinary MedAtlas pages into course pages',()=>{assert.equal(courseQuizSlug('/impulse/quiz/'+slug),slug);assert.equal(courseQuizSlug('/impulse/quiz/'+slug+'/'),slug);for(const path of ['/','/lectures','/impulse/upload','/impulse/quiz/short','//evil.example/impulse/quiz/'+slug])assert.equal(courseQuizSlug(path),null);});
test('existing signed-in students see only the quiz password and resume saved answers after reopening',async()=>{
 setAuthToken('existing-medatlas-session');let unlocked=false,answer:any=null,position=0;const calls:string[]=[];
 const rows=[{id:'question-one',position:0,question:{type:'mcq',text:'Choose green.',options:['Green','Red']},answer:null,result:null,max_marks:1},{id:'question-two',position:1,question:{type:'short_answer',text:'Write green.'},answer:null,result:null,max_marks:1}];
 const feedback={score:1,maxScore:1,feedback:'Green is correct.',correctOption:0};
 globalThis.fetch=(async(url:any,options:any={})=>{const path=String(url);calls.push(path);assert.equal(options.headers.Authorization,'Bearer existing-medatlas-session');if(path.endsWith('/session'))return unlocked?Response.json({attemptId:'saved-attempt',title:'Private course',total:2,current:position,completed:false,studentUid:'student',states:rows.map((q,i)=>({id:q.id,position:i,type:q.question.type,answered:i===0&&answer!==null,choice:i===0?answer:null,score:i===0&&answer!==null?1:null,max_marks:1})),questions:rows.map((q,i)=>({...q,answer:i===0?answer:null,result:i===0&&answer!==null?feedback:null}))}):Response.json({error:'Enter the quiz password to continue.'},{status:401});if(path.endsWith('/unlock')){assert.equal(JSON.parse(options.body).password,'CoursePassword');unlocked=true;return Response.json({ok:true});}if(path.includes('/answer/')){answer=JSON.parse(options.body).answer;return Response.json({ok:true,result:feedback});}if(path.endsWith('/progress')){position=JSON.parse(options.body).position;return Response.json({ok:true});}throw Error('Unexpected '+path);}) as typeof fetch;
 let root=createRoot(host());try{
  await act(async()=>root.render(<CourseQuizView slug={slug} onSignIn={()=>{throw Error('Existing account must not be asked to sign in again.');}}/>));
  const password=host().querySelector('input[type=password]') as HTMLInputElement;assert.ok(password);assert.equal(host().querySelector('input[type=email]'),null);assert.doesNotMatch(host().textContent||'',/Publisher password|Impulse team/);
  await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(password,'CoursePassword');password.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  await act(async()=>{host().querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));});
  assert.ok(host().querySelector('.ma-study-player'),'Use the real lecture/practical player.');
  assert.match(host().textContent||'',/Choose green/);await act(async()=>(host().querySelector('[role=radiogroup] > div') as HTMLElement).click());assert.equal(answer,0);await click('Next');assert.equal(position,1);
  await act(async()=>root.unmount());root=createRoot(host());await act(async()=>root.render(<CourseQuizView slug={slug} onSignIn={()=>{throw Error('Unexpected sign-in');}}/>));assert.match(host().textContent||'',/Question 2/);await click('Previous');assert.match(host().textContent||'',/Correct Answer!/);assert.equal(calls.filter(p=>p.endsWith('/unlock')).length,1);
 }finally{await act(async()=>root.unmount());globalThis.fetch=realFetch;}
});
test('an expired MedAtlas session returns control to the main sign-in flow instead of showing team credentials',async()=>{
 let signIns=0;globalThis.fetch=(async()=>Response.json({error:'Unauthorized: Invalid or expired session token'},{status:401})) as typeof fetch;const root=createRoot(host());try{await act(async()=>root.render(<CourseQuizView slug={slug} onSignIn={()=>signIns++}/>));assert.equal(signIns,1);assert.equal(host().querySelector('input[type=email]'),null);}finally{await act(async()=>root.unmount());globalThis.fetch=realFetch;}
});
test('opening a private link while signed out opens the normal MedAtlas sign-in dialog first',async()=>{
 const root=createRoot(host());try{await act(async()=>root.render(<PublicLanding catalog={{subjects:[],lectures:[],totalPublishedQuestions:0}} loadingCatalog={false} onAuthenticated={()=>{}} requireSignIn/>));assert.ok(host().querySelector('[role=dialog]'));assert.ok(host().querySelector('input[type=email]'));assert.ok(host().querySelector('input[type=password]'));assert.doesNotMatch(host().textContent||'',/Publisher password/);}finally{await act(async()=>root.unmount());}
});

test('the whole private workspace recognizes a login made in another tab and does not loop on token refresh',async()=>{
 const {default:App}=await import('../App.tsx');
 const {setFirebaseClientAuthHandlersForTests,getAuthToken}=await import('./api.ts');
 setAuthToken(null);
 setFirebaseClientAuthHandlersForTests({getRedirectResult:async()=>null,onAuthStateChanged:(_auth,next)=>{queueMicrotask(()=>next(null));return()=>{};}});
 let authReads=0,quizReads=0;
 globalThis.fetch=(async(url:any,options:any={})=>{
  const path=String(url);
  if(path==='/api/catalog')return Response.json({subjects:[],lectures:[],totalPublishedQuestions:0});
  if(path==='/api/auth/me'){authReads++;assert.equal(options.headers.Authorization,'Bearer medatlas.login-in-other-tab');return Response.json({token:'medatlas.refreshed-session',user:{uid:'student',displayName:'Existing Student',role:'student',profileCompleted:true}});}
  if(path.endsWith('/session')){quizReads++;return Response.json({error:'Enter the quiz password to continue.'},{status:401});}
  throw Error('Unexpected request '+path);
 }) as typeof fetch;
 const root=createRoot(host());try{
  await act(async()=>{root.render(<App/>);await new Promise(r=>setTimeout(r,80));});
  assert.ok(host().querySelector('input[type=email]'));
  dom.window.localStorage.setItem('medatlas_session_token','medatlas.login-in-other-tab');
  await act(async()=>{window.dispatchEvent(new dom.window.StorageEvent('storage',{key:'medatlas_session_token',newValue:'medatlas.login-in-other-tab',storageArea:dom.window.localStorage}));await new Promise(r=>setTimeout(r,30));});
  assert.ok(host().querySelector('input[type=password]'));
  assert.equal(host().querySelector('input[type=email]'),null);
  assert.match(host().textContent||'',/Workspace.*Private quiz/);
  assert.match(host().textContent||'',/You’re signed in to MedAtlas/);
  assert.equal(authReads,1);assert.equal(quizReads,1);assert.equal(getAuthToken(),'medatlas.refreshed-session');
  await act(async()=>window.dispatchEvent(new dom.window.StorageEvent('storage',{key:'medatlas_session_token',newValue:'medatlas.rotated-in-other-tab',storageArea:dom.window.localStorage})));
  assert.equal(authReads,1,'Token rotation must not create cross-tab request loops.');
 }finally{await act(async()=>root.unmount());globalThis.fetch=realFetch;setFirebaseClientAuthHandlersForTests(null);setAuthToken(null);}
});
