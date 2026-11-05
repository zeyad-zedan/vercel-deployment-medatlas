import React,{act} from 'react';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
// Initialize the existing API/Firebase module in its supported server-test environment.
import {api} from './api.ts';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/'});
const replaced=new Map<string,PropertyDescriptor|undefined>();
for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){replaced.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});}
dom.window.HTMLElement.prototype.scrollIntoView=()=>{};dom.window.HTMLElement.prototype.scrollTo=()=>{};dom.window.scrollTo=()=>{};
const {createRoot}=await import('react-dom/client');
const {default:ShortAnswersView}=await import('../components/ShortAnswersView.tsx');
const {default:PracticalView}=await import('../components/PracticalView.tsx');
const {McqSessionPlayer}=await import('../components/McqSessionPlayer.tsx');
const realApi={...api},realFetch=globalThis.fetch;
after(()=>{globalThis.fetch=realFetch;Object.assign(api,realApi);dom.window.close();for(const [name,descriptor] of replaced){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete(globalThis as any)[name];}});
const host=()=>dom.window.document.getElementById('root')! as HTMLElement;
const text=()=>host().textContent||'';
const findButton=(name:string)=>{const button=[...host().querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===name||b.getAttribute('aria-label')===name);assert.ok(button,`Missing button: ${name}`);return button;};
async function click(name:string){await act(async()=>{findButton(name).click();});}
async function change(selector:string,value:string){const input=host().querySelector(selector) as HTMLInputElement;assert.ok(input,`Missing input ${selector}`);await act(async()=>{const proto=input.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:input.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(input,value);input.dispatchEvent(new dom.window.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
function reset(){Object.assign(api,realApi);dom.window.localStorage.clear();host().replaceChildren();}

test('short-answer student interaction restores drafts, saves independently, grades directly and reopens saved feedback',async()=>{
 reset();let saveFails=true,gradeCalls=0,saveCalls=0,imageCalls=0;const q={id:11,question:'Name two bone functions.',max_score:2,images:[{id:'figure',alt:'Bone figure',source:'/api/question-images/fixture'}]};let saved:any=null;
 api.shortAnswerCatalog=async()=>({lectures:[{id:82,title:'Bones',subject:'Anatomy',contentType:'practical',lectureNumber:1,count:1}]});
 api.shortAnswerQuestions=async()=>({questions:[q],nextCursor:null});
 api.saveShortAnswer=async(id,answer)=>{saveCalls++;if(saveFails)throw new Error('Network unavailable');saved={id:21,questionId:id,question:q.question,images:q.images,answer,status:'saved'};return {attempt:saved};};
 api.gradeShortAnswer=async()=>{gradeCalls++;saved={...saved,status:'graded',model:'test-model',modelAnswer:'Support and protection.',result:{score:2,maxScore:2,feedback:'Both correct.',points:[{id:'p1',description:'Bone functions',marks:2,awarded:2,feedback:'Correct.'}]}};return {attempt:saved};};
 api.shortAnswerHistory=async()=>({attempts:[{id:21,question_id:11,question:q.question,status:'graded',score:2,max_score:2,created_at:new Date().toISOString()}],nextCursor:null});api.getShortAnswer=async()=>({attempt:saved});
 globalThis.fetch=(async(input:any)=>{assert.equal(input,'/api/question-images/fixture');imageCalls++;return new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});}) as typeof fetch;
 dom.window.localStorage.setItem('medatlas_sa_draft_student_11','Support and protection');const root=createRoot(host());
 try{
  await act(async()=>{root.render(<ShortAnswersView userUid="student" initialLectureId={82}/>);});assert.match(text(),/Name two bone functions/);assert.equal((host().querySelector('select') as HTMLSelectElement).value,'82');
  await click('Name two bone functions.2 marks');assert.equal((host().querySelector('textarea') as HTMLTextAreaElement).value,'Support and protection');assert.equal(findButton('Save & grade').disabled,false);assert.equal(host().querySelector('input[type=checkbox]'),null);assert.equal(gradeCalls,0);assert.equal(imageCalls,1);
  await click('Save answer');assert.match(text(),/Network unavailable/);assert.equal(dom.window.localStorage.getItem('medatlas_sa_draft_student_11'),'Support and protection');
  saveFails=false;await click('Save answer');assert.match(text(),/Answer saved to your account/);assert.equal(gradeCalls,0);assert.equal(dom.window.localStorage.getItem('medatlas_sa_draft_student_11'),null);
  await click('Save & grade');assert.equal(gradeCalls,1);assert.match(text(),/2\/2 marks/);assert.match(text(),/Both correct/);assert.equal(findButton('Save & grade').disabled,true);
  await change('#sa-answer','A revised answer');assert.doesNotMatch(text(),/Both correct/);assert.equal(dom.window.localStorage.getItem('medatlas_sa_draft_student_11'),'A revised answer');
  await click('My answer history');await click('Name two bone functions.2/2 marks · '+new Date().toLocaleDateString());assert.match(text(),/Both correct/);assert.equal(gradeCalls,1,'Opening saved feedback must not call Gemini.');assert.equal(saveCalls,3);
 }finally{await act(async()=>root.unmount());globalThis.fetch=realFetch;}
});

test('practical student controls select the section and start the existing study session',async()=>{
 reset();let started:any=null;const section={id:82,title:'Bones',contentType:'practical',lectureNumber:1,questionCount:8,shortAnswerCount:1};const root=createRoot(host());
 try{await act(async()=>root.render(<PracticalView catalog={{subjects:[{id:36,title:'Anatomy',lectures:[section]}],lectures:[section]}} dashboardData={{subjectProgress:[{subjectId:36,lectures:[{lectureId:82,uniqueQuestionsAttempted:3}]}]}} onStartSession={params=>{started=params;}}/>));assert.match(text(),/3\/8 questions/);assert.ok(![...host().querySelectorAll('button')].some(b=>b.textContent==='Short Answers'));await click('Continue section');assert.deepEqual(started.lectureIds,[82]);await change('input[type=search]','No match');assert.match(text(),/No sections match/);}finally{await act(async()=>root.unmount());}
});

test('matching student choices and bookmarks save immediately and six-question navigation fetches only the next batch',async()=>{
 reset();const choices=[{id:'c1',text:'Head'},{id:'c2',text:'Shaft'}];const questions=Array.from({length:8},(_,i)=>({id:i+1,index:i,questionText:`Label ${i+1}`,contentLoaded:i<6,questionType:'matching',matching:i<6?{groupId:'bone',number:String(i+1),prompt:'Match numbered bones',choices,correctChoiceId:'c1'}:undefined,selectedDisplayed:null,submitted:false,isBookmarked:false,images:[],options:{A:'Correct',B:'Incorrect',C:'None',D:'None'},correctDisplayedOption:'A',explanation:'Bone explanation'}));
 const session={id:99001,title:'Bones section',mode:'study',status:'in_progress',questions,totalQuestions:8,correctCount:0,incorrectCount:0,unansweredCount:8,elapsedSeconds:0,remainingSeconds:null,questionBatch:{size:6,offset:0}};const answers:any[]=[],bookmarks:any[]=[],batches:number[]=[];
 api.submitQuestionAnswer=async(...args:any[])=>{answers.push(args);return {session:{correctCount:1,incorrectCount:0,unansweredCount:7,selectedDisplayed:'A',matchingChoiceId:args[6]}};};
 api.toggleBookmark=async(...args:any[])=>{bookmarks.push(args);return {bookmarked:true,questionId:args[0]};};
 api.getSessionQuestionBatch=async(_id,offset)=>{batches.push(offset);return {session:{...session,questions:questions.slice(offset,offset+6).map(q=>({...q,contentLoaded:true,matching:{groupId:'bone',number:String(q.index+1),prompt:'Match numbered bones',choices,correctChoiceId:'c1'}}))}};};
 const root=createRoot(host());
 try{await act(async()=>root.render(<McqSessionPlayer initialSession={session} onExit={()=>{}} onSessionCompleted={()=>{}}/>));assert.equal(batches.length,0);await change('select','c1');assert.equal(answers.length,1);assert.equal(answers[0][6],'c1');assert.match(text(),/Correct match/);assert.equal((host().querySelector('select') as HTMLSelectElement).disabled,true);
  await act(async()=>{const save=host().querySelector('button[aria-label="Save bookmark"]') as HTMLButtonElement;assert.ok(save);save.click();});assert.equal(bookmarks.length,1);assert.ok(host().querySelector('button[aria-label="Remove bookmark"]'));
  // Answer the last loaded label: the player requests precisely the next six-sized batch.
  const selects=host().querySelectorAll<HTMLSelectElement>('select');if(selects.length>=6){await act(async()=>{const select=selects[5];select.value='c1';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});}
  assert.deepEqual(batches,[6]);assert.equal(answers.length,2);assert.equal(bookmarks.length,1);
 }finally{await act(async()=>root.unmount());}
});

test('mock exam matching hides grading until submit and shows the actual selected names in results',async()=>{
 reset();const choices=[{id:'c1',text:'Head'},{id:'c2',text:'Shaft'}],answers:any[]=[];let completed:any=null;
 const questions=[0,1].map(index=>({id:101+index,index,contentLoaded:true,questionType:'matching',questionText:`Label ${index+1}`,matching:{groupId:'exam-bone',number:String(index+1),prompt:'Match bone labels',choices},selectedDisplayed:null,submitted:false,images:[],options:{}}));
 const session={id:99002,title:'Matching mock exam',mode:'exam',status:'in_progress',questions,totalQuestions:2,timeLimitSeconds:600,remainingSeconds:600,elapsedSeconds:0};
 api.submitQuestionAnswer=async(...args:any[])=>{answers.push(args);return {session:{id:session.id,status:'in_progress'}};};
 api.completeSession=async()=>({session:{...session,status:'completed',correctCount:1,incorrectCount:1,unansweredCount:0,scorePercentage:50,questions:questions.map((q,index)=>({...q,matching:{...q.matching,correctChoiceId:'c1'},matchingChoiceId:index?'c2':'c1',selectedDisplayed:index?'B':'A',correctDisplayedOption:'A',submitted:true,explanation:'Bone model answer'}))}});
 const root=createRoot(host());try{
  await act(async()=>root.render(<McqSessionPlayer initialSession={session} onExit={()=>{}} onSessionCompleted={result=>{completed=result;}}/>));
  await change('select','c1');await act(async()=>{const select=host().querySelectorAll('select')[1];select.value='c2';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  assert.equal(answers.length,2);assert.equal(answers[1][6],'c2');assert.doesNotMatch(text(),/Correct match|Correct answer:/);assert.ok([...host().querySelectorAll('select')].every(s=>!s.disabled));
  await click('Review & submit');await act(async()=>{const confirm=[...host().querySelectorAll<HTMLButtonElement>('button')].filter(b=>b.textContent?.trim()==='End Test').at(-1);assert.ok(confirm);confirm.click();});assert.ok(completed,text());assert.equal(completed.status,'completed');await click('Show Results');assert.match(text(),/Shaft/);assert.match(text(),/50/);
  const review=[...host().querySelectorAll<HTMLButtonElement>('button')].find(b=>/review/i.test(b.textContent||'')&&b.textContent!.trim()!=='For Review');assert.ok(review);await act(async()=>review.click());assert.match(text(),/Your answer:/);assert.match(text(),/Correct answer:/);
 }finally{await act(async()=>root.unmount());}
});

test('short answers live inside the quiz and Submit saves typed text before completing it',async()=>{
 reset();const events:string[]=[];let written='',finished:any=null;
 const short={id:301,index:0,questionType:'short_answer',shortAnswerId:9,maxMarks:3,questionText:'Describe bone functions.',contentLoaded:true,submitted:false,images:[],selectedDisplayed:null};
 const mcq={id:302,index:1,questionText:'A regular MCQ',contentLoaded:true,options:{A:'One',B:'Two',C:'Three',D:'Four'},correctDisplayedOption:'A',explanation:'Explanation',submitted:false,selectedDisplayed:null,images:[]};
 const session={id:99003,title:'One mixed quiz',mode:'study',status:'in_progress',questions:[short,mcq],totalQuestions:2,correctCount:0,incorrectCount:0,unansweredCount:2,remainingSeconds:null,elapsedSeconds:0,questionBatch:{size:6,offset:0}};
 api.saveQuizShortAnswer=async(_session,_question,answer)=>{events.push('save text');written=answer;return {attempt:{id:77,answer,status:'saved'},session:{id:session.id,quizScore:{earnedMarks:0,maxMarks:4,shortAnswerCount:1,pendingGradingCount:1}}};};
 api.completeSession=async()=>{events.push('submit quiz');assert.equal(written,'My written response');return {session:{...session,status:'completed',quizScore:{earnedMarks:0,maxMarks:4,shortAnswerCount:1,pendingGradingCount:1},questions:[{...short,hasSavedAnswer:true,submitted:true,selectedDisplayed:'C',shortAnswerStatus:'saved',shortAnswerAttempt:{id:77,answer:written,status:'saved'}},mcq]}};};
 const root=createRoot(host());try{
  await act(async()=>root.render(<McqSessionPlayer initialSession={session} onExit={()=>{}} onSessionCompleted={result=>{finished=result;}}/>));assert.ok(host().querySelector('textarea'));assert.match(text(),/Short answer · 3 marks/);await change('textarea','My written response');assert.equal(events.length,0,'Typing must not create per-keystroke database traffic.');
  await click('Next Question');await click('Finish Quiz');await click('Confirm & Submit');await click('Previous Question');assert.deepEqual(events,['save text','submit quiz']);assert.equal(finished.status,'completed');assert.match(text(),/awaiting grading/);assert.equal((host().querySelector('textarea') as HTMLTextAreaElement).value,'My written response');assert.equal(findButton('Grade saved answer').disabled,false,'Grading needs no checkbox.');
 }finally{await act(async()=>root.unmount());}
});

test('one upload page offers all types and its guided short-answer builder appends to a mixed batch',async()=>{
 reset();const html=fs.readFileSync(new URL('../../tools/quiz-portal.html',import.meta.url),'utf8'),page=new JSDOM(html);
 host().innerHTML=page.window.document.querySelector('main').innerHTML;page.window.close();
 const source=host().querySelector('#source') as HTMLTextAreaElement;source.value=JSON.stringify({questions:[{question_type:'mcq',question_text:'An existing MCQ'}]});
 const {installShortAnswerBuilder}=await import('../../tools/short-answer-builder.ts');let changed=0;
 const builder=installShortAnswerBuilder({source,selectImages:async()=>{},image:()=>undefined,changed:()=>{changed++;},notice:()=>{}});builder.open();
 assert.deepEqual([...host().querySelectorAll<HTMLOptionElement>('#question-type option')].map(option=>option.value),['mcq','matching','short_answer']);
 (host().querySelector('#sa-question') as HTMLTextAreaElement).value='Name a bone function.';(host().querySelector('#sa-model-answer') as HTMLTextAreaElement).value='Support.';(host().querySelector('#sa-guide-next') as HTMLButtonElement).click();
 (host().querySelector('#sa-rubric textarea') as HTMLTextAreaElement).value='Support of the body';(host().querySelector('#sa-guide-next') as HTMLButtonElement).click();(host().querySelector('#sa-guide-finish') as HTMLButtonElement).click();
 const batch=JSON.parse(source.value);assert.equal(batch.questions.length,2);assert.equal(batch.questions[0].question_type,'mcq');assert.equal(batch.questions[1].question_type,'short_answer');assert.equal(batch.questions[1].model_answer,'Support.');assert.equal(changed,1);
});


test('study navigation stays outside long question content without saving or refetching answers',async()=>{
 reset();let saves=0;
 const questions=[1,2].map((id,index)=>({id:8800+id,index,contentLoaded:true,questionText:`Long question ${id}: `+'Clinical detail. '.repeat(100),options:{A:'One',B:'Two',C:'Three',D:'Four'},correctDisplayedOption:'A',explanation:'Explanation. '.repeat(150),submitted:false,selectedDisplayed:null,images:[]}));
 const session={id:99101,title:'Persistent navigation',mode:'study',status:'in_progress',questions,totalQuestions:2,correctCount:0,incorrectCount:0,unansweredCount:2,elapsedSeconds:0};
 api.submitQuestionAnswer=async()=>{saves++;return {session:{id:session.id,correctCount:1,unansweredCount:1}};};
 const root=createRoot(host());try{
  await act(async()=>root.render(<McqSessionPlayer initialSession={session} onExit={()=>{}} onSessionCompleted={()=>{}}/>));
  const dock=host().querySelector('nav[aria-label="Question navigation"]');assert.ok(dock);assert.equal(dock.closest('.ma-question-card'),null);assert.equal(findButton('Previous Question').disabled,true);
  await act(async()=>{dom.window.dispatchEvent(new dom.window.Event('scroll'));});await click('Next Question');
  assert.ok(host().querySelector('nav[aria-label="Question navigation"]'));assert.match(text(),/Long question 2/);assert.equal(findButton('Previous Question').disabled,false);
  await click('Previous Question');assert.match(text(),/Long question 1/);assert.equal(saves,0,'Navigation does not save or refetch question content.');
  await click('Next Question');await click('Finish Session');assert.ok(host().querySelector('[role="dialog"]'));assert.equal(host().querySelector('nav[aria-label="Question navigation"]'),null,'The dock must not overlap submission dialogs.');
 }finally{await act(async()=>root.unmount());}
});

test('Gemini settings preserve long pasted keys and show actionable save failures without losing the input',async()=>{
 reset();const {GeminiKeySettings}=await import('../components/GeminiKeySettings.tsx');
 const longKey='AQ.'+'T'.repeat(320);let received='',fail=true;
 api.getGeminiKeyStatus=async()=>({configured:false,maskedKey:null,updatedAt:null,available:true});
 api.saveGeminiKey=async(value:string)=>{received=value;if(fail)throw Error('Secure key storage is temporarily unavailable. Please try again later.');return {configured:true,maskedKey:'••••TTTT',updatedAt:null,available:true};};
 const root=createRoot(host());try{
  await act(async()=>root.render(<GeminiKeySettings/>));
  assert.ok((host().querySelector('#student-gemini-key') as HTMLInputElement).maxLength>=longKey.length);
  await change('#student-gemini-key',' '+longKey+' ');await click('Save key');assert.equal(received,longKey);
  assert.match(text(),/Secure key storage is temporarily unavailable/);assert.equal((host().querySelector('#student-gemini-key') as HTMLInputElement).value.trim(),longKey);
  fail=false;await click('Save key');assert.match(text(),/API key saved securely/);assert.match(text(),/••••TTTT/);assert.equal(host().querySelector('#student-gemini-key'),null);
 }finally{await act(async()=>root.unmount());}
});

test('PDF canvas displays a page from one request and retries the page without a metadata waterfall',async()=>{
 reset();
 const {PdfCanvasViewer}=await import('../components/PdfViewerModal.tsx'),{setAuthToken}=await import('./api.ts');
 const oldImage=Object.getOwnPropertyDescriptor(globalThis,'Image'),oldObserver=Object.getOwnPropertyDescriptor(globalThis,'ResizeObserver');
 const oldContext=dom.window.HTMLCanvasElement.prototype.getContext;
 const requests:string[]=[];let fail=true,draws=0;
 class PreviewImage{naturalWidth=1600;naturalHeight=2200;onload:any;onerror:any;set src(_value:string){queueMicrotask(()=>this.onload?.());}}
 Object.defineProperty(globalThis,'Image',{configurable:true,value:PreviewImage});
 Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:class{observe(){}disconnect(){}}});
 dom.window.HTMLCanvasElement.prototype.getContext=(()=>({setTransform(){},drawImage(){draws++;}})) as any;
 globalThis.fetch=(async(url:any)=>{requests.push(String(url));return fail?Response.json({error:'Temporary failure.'},{status:503}):new Response('preview',{headers:{'Content-Type':'image/webp','X-Document-Total-Pages':'12'}});}) as typeof fetch;
 setAuthToken('pdf-test-token');const root=createRoot(host());
 try{
  await act(async()=>root.render(<PdfCanvasViewer pdfUrl="/api/documents/canvas-test" pageNumber={3} zoomPercent={100}/>));
  assert.match(text(),/Temporary failure/);assert.deepEqual(requests,['/api/documents/canvas-test/pages/3']);
  fail=false;await click('Retry page');assert.equal(requests.length,2);assert.ok(host().querySelector('canvas[aria-label*="page 3 of 12"]'));assert.ok(draws>0);
  await act(async()=>root.render(<PdfCanvasViewer pdfUrl="/api/documents/canvas-test" pageNumber={4} zoomPercent={100}/>));
  assert.equal(requests.length,3);assert.equal(requests[2],'/api/documents/canvas-test/pages/4');
  await act(async()=>root.render(<PdfCanvasViewer pdfUrl="/api/documents/canvas-test" pageNumber={4} zoomPercent={150}/>));assert.equal(requests.length,3,'Zoom redraws locally.');
 }finally{
  await act(async()=>root.unmount());setAuthToken(null);globalThis.fetch=realFetch;dom.window.HTMLCanvasElement.prototype.getContext=oldContext;
  for(const [name,descriptor] of [['Image',oldImage],['ResizeObserver',oldObserver]] as const){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete(globalThis as any)[name];}
 }
});
