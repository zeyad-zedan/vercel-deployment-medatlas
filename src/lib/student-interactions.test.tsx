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
 try{await act(async()=>root.render(<PracticalView catalog={{subjects:[{id:36,title:'Anatomy',lectures:[section]}],lectures:[section]}} dashboardData={{subjectProgress:[{subjectId:36,lectures:[{lectureId:82,uniqueQuestionsAttempted:3}]}]}} onStartSession={params=>{started=params;}}/>));assert.match(text(),/3 of 8 questions completed/);assert.ok(![...host().querySelectorAll('button')].some(b=>b.textContent==='Short Answers'));await click('Continue learning');assert.deepEqual(started.lectureIds,[82]);await change('input[type=search]','No match');assert.match(text(),/No matching subjects, lectures or sections/);}finally{await act(async()=>root.unmount());}
});

test('practical reset clears saved progress without launching a quiz',async()=>{
 reset();const starts:any[]=[],opened:any[]=[],resets:number[]=[];
 const section={id:82,title:'Bones',contentType:'practical',lectureNumber:1,questionCount:8};
 let fail=true;
 function Fixture(){
  const [progress,setProgress]=React.useState({lectureId:82,uniqueQuestionsAttempted:3,activeSessionId:102,reviewSessionId:101});
  return <PracticalView catalog={{subjects:[{id:36,title:'Anatomy',lectures:[section]}],lectures:[section]}}
   dashboardData={{subjectProgress:[{subjectId:36,lectures:[progress]}]}}
   onStartSession={params=>{starts.push(params);}} onOpenSession={(id,review)=>{opened.push([id,review]);}}
   onResetProgress={async id=>{resets.push(id);if(fail)throw Error('Reset temporarily unavailable');setProgress({lectureId:82,uniqueQuestionsAttempted:0,activeSessionId:0,reviewSessionId:0});}}/>;
 }
 const root=createRoot(host());
 try{
  await act(async()=>root.render(<Fixture/>));
  await click('Continue learning');await click('More actions for Bones');await click('Review answers');assert.deepEqual(opened,[[102,undefined],[101,true]]);
  await click('Restart session');assert.match(text(),/Your bookmarks stay saved/);
  await click('Cancel');assert.deepEqual(resets,[]);
  await click('More actions for Bones');await click('Restart session');await click('Reset progress');
  assert.match(text(),/Reset temporarily unavailable/);assert.match(text(),/3 of 8 questions completed/);
  fail=false;await click('Reset progress');
  assert.deepEqual(resets,[82,82]);assert.equal(starts.length,0);assert.match(text(),/0 of 8 questions completed/);
  await click('Start learning');assert.deepEqual(starts[0].lectureIds,[82]);
 }finally{await act(async()=>root.unmount());}
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


test('missing Gemini key opens the Arabic illustrated guide, saves the key and resumes grading without losing the answer',async()=>{
 reset();const {ShortAnswerQuestion}=await import('../components/ShortAnswerQuestion.tsx');
 const answer='Support and protection',secret='AQ.'+'K'.repeat(240);let gradedCalls=0,combinedCalls=0,savedKey=false,keyFails=true,keyWrites=0;
 const saved={id:701,answer,status:'saved',maxScore:1,result:null};
 api.saveQuizShortAnswer=async()=>{throw new Error('Save & grade must use one request.');};
 api.gradeQuizShortAnswer=async()=>{gradedCalls++;return {attempt:savedKey?{...saved,status:'graded',modelAnswer:'Support and protection',result:{score:1,maxScore:1,feedback:'Well done',points:[]}}:{...saved,status:'failed',errorCode:'KEY_MISSING',error:'Add your Gemini API key.'},session:{}};};
 api.saveAndGradeQuizShortAnswer=async(sessionId,questionId,value)=>{combinedCalls++;assert.deepEqual([sessionId,questionId,value],[99122,701,answer]);return api.gradeQuizShortAnswer(sessionId,questionId);};
 api.getGeminiKeyStatus=async()=>{throw Error('No per-grade key status polling.');};
 api.saveGeminiKey=async(value:string)=>{keyWrites++;assert.equal(value,secret);if(keyFails)throw Object.assign(Error('storage unavailable'),{status:503});savedKey=true;return {configured:true,maskedKey:'••••KKKK',available:true,updatedAt:null};};
 const root=createRoot(host());const question={id:701,questionType:'short_answer',maxMarks:1,questionText:'Name bone functions.',images:[]};
 const dialog=()=>dom.window.document.querySelector('[role="dialog"]') as HTMLElement;
 try{
  await act(async()=>root.render(<ShortAnswerQuestion question={question} sessionId={99122} onSaved={()=>{}}/>));
  await change('textarea',answer);await click('Save & grade');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,70));});
  assert.ok(dialog());assert.equal(dialog().getAttribute('lang'),null);assert.equal(dialog().parentElement?.getAttribute('lang'),'ar');assert.match(dialog().textContent||'',/أهلاً يا صديقي/);
  assert.equal(dialog().querySelector('a[href="https://t.me/MedAtlasMCQ?direct"]')?.textContent?.trim(),'ابعتلنا على تليجرام');assert.ok(dialog().querySelector('a[href="https://aistudio.google.com/apikey"]'));
  for(let index=1;index<=5;index++){
   assert.equal(dialog().querySelector('img')?.getAttribute('src'),`/tutorials/gemini/step-${index}.svg`);
   if(index<5)await act(async()=>{const next=[...dialog().querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.includes('الخطوة اللي بعدها'));assert.ok(next);next.click();});
  }
  await act(async()=>{const input=dialog().querySelector('input')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,secret);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  const save=()=>[...dialog().querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.includes('احفظ المفتاح'))!;
  await act(async()=>save().click());assert.match(dialog().textContent||'',/حفظ المفاتيح مش متاح مؤقتًا/);assert.equal(dialog().querySelector('input')?.value,secret);assert.equal(gradedCalls,1);
  keyFails=false;await act(async()=>save().click());assert.equal(keyWrites,2);assert.equal(dialog(),null);assert.equal(gradedCalls,2);assert.equal(combinedCalls,1);assert.equal((host().querySelector('textarea') as HTMLTextAreaElement).value,answer);assert.match(text(),/Well done/);assert.ok(!text().includes(secret));
 }finally{await act(async()=>root.unmount());}
});

test('quota failures do not open key setup, and closing setup preserves the saved response',async()=>{
 reset();const {ShortAnswerQuestion}=await import('../components/ShortAnswerQuestion.tsx');let code='QUOTA';
 const saved={id:702,answer:'My saved answer',status:'failed',maxScore:1,result:null};
 api.saveQuizShortAnswer=async()=>({attempt:saved,session:{}});api.gradeQuizShortAnswer=async()=>({attempt:{...saved,errorCode:code,error:code},session:{}});api.saveAndGradeQuizShortAnswer=async(id,questionId)=>api.gradeQuizShortAnswer(id,questionId);
 const root=createRoot(host());try{
  await act(async()=>root.render(<ShortAnswerQuestion question={{id:702,maxMarks:1,questionText:'Question',images:[]}} sessionId={99123} onSaved={()=>{}}/>));await change('textarea','My saved answer');await click('Save & grade');assert.equal(dom.window.document.querySelector('[role="dialog"]'),null);
  code='KEY_MISSING';await click('Retry grading');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});assert.ok(dom.window.document.querySelector('[role="dialog"]'));
  await act(async()=>dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(dom.window.document.querySelector('[role="dialog"]'),null);assert.equal((host().querySelector('textarea') as HTMLTextAreaElement).value,'My saved answer');assert.match(text(),/افتح شرح إضافة مفتاح/);
 }finally{await act(async()=>root.unmount());}
});


test('a delayed grade preserves a newer draft and waits out the retry cooldown',async()=>{
 reset();const {ShortAnswerQuestion}=await import('../components/ShortAnswerQuestion.tsx');
 const {quizTextDraftKey}=await import('./quiz-text-drafts.tsx');
 const key=quizTextDraftKey(99124,703),answer='First response';
 let finish!:(result:any)=>void;
 api.saveAndGradeQuizShortAnswer=()=>new Promise(resolve=>{finish=resolve;});
 const root=createRoot(host()),question={id:703,maxMarks:1,questionText:'Question',images:[]};
 const failure={id:703,answer,status:'failed',maxScore:1,result:null,errorCode:'GEMINI_UNAVAILABLE',error:'Your answer is saved.',retryAt:new Date(Date.now()+15000).toISOString()};
 try{
  await act(async()=>root.render(<ShortAnswerQuestion question={question} sessionId={99124} onSaved={()=>{}}/>));
  await change('textarea',answer);
  await click('Save & grade');
  dom.window.localStorage.setItem(key,'Newer response in another tab');
  await act(async()=>finish({attempt:failure,session:{}}));
  assert.equal(dom.window.localStorage.getItem(key),'Newer response in another tab');
  const retry=[...host().querySelectorAll('button')].find(button=>button.textContent?.startsWith('Retry in '));
  assert.ok(retry?.disabled,'A saved answer cannot be retried before the server deadline.');
  await act(async()=>root.render(<ShortAnswerQuestion question={{...question,shortAnswerAttempt:{...failure,retryAt:new Date(Date.now()-1).toISOString()}}} sessionId={99124} onSaved={()=>{}}/>));
  assert.equal(findButton('Retry grading').disabled,false);
 }finally{await act(async()=>root.unmount());}
});

test('grading feedback distinguishes marking outcomes and scrolls only for a requested new result',async()=>{
 const {GradeFeedback}=await import('../components/GradeFeedback.tsx');let scrolls=0;
 const previousScroll=dom.window.HTMLElement.prototype.scrollIntoView;
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{scrolls++;};
 const grade={score:3,maxScore:6,feedback:'Two points need attention.',points:[{id:'one',description:'Correct point',awarded:2,marks:2,feedback:'Correct.'},{id:'two',description:'Partial point',awarded:1,marks:2,feedback:'Add detail.'},{id:'three',description:'Missing point',awarded:0,marks:2,feedback:'Review this.'}]};
 const root=createRoot(host());try{
  await act(async()=>root.render(<GradeFeedback grade={grade} modelAnswer="Model text"/>));assert.equal(scrolls,0);
  for(const state of ['correct','partial','missed'])assert.ok(host().querySelector('.ma-grade-point-'+state));
  await act(async()=>{root.render(<GradeFeedback grade={grade} modelAnswer="Model text" scrollToken={1}/>);});
  await act(async()=>{await new Promise(r=>setTimeout(r,10));});assert.equal(scrolls,1);
  assert.match(text(),/50%/);assert.match(text(),/Partial credit/);assert.match(text(),/Needs review/);
 }finally{await act(async()=>root.unmount());dom.window.HTMLElement.prototype.scrollIntoView=previousScroll;}
});

test('study navigator collapses on downward scrolling, expands upwards, and does not fetch questions',async()=>{
 reset();let reads=0;api.syncSessionProgress=async()=>({success:true});api.getSessionQuestionBatch=async()=>{reads++;throw Error('Unnecessary fetch');};
 const question={id:991,index:0,questionText:'A test question',images:[],options:{A:'One',B:'Two',C:'Three',D:'Four'},correctDisplayedOption:'A'};
 const root=createRoot(host());const previousY=Object.getOwnPropertyDescriptor(dom.window,'scrollY');
 try{
  await act(async()=>root.render(<McqSessionPlayer initialSession={{id:889911,mode:'study',status:'in_progress',questions:[question],totalQuestions:1}} onExit={()=>{}} onSessionCompleted={()=>{}}/>));
  const toggle=()=>host().querySelector('button[aria-controls="study-question-navigator"]')!;
  assert.equal(toggle().getAttribute('aria-expanded'),'true');
  await act(async()=>{Object.defineProperty(dom.window,'scrollY',{configurable:true,value:180});window.dispatchEvent(new dom.window.Event('scroll'));});assert.equal(toggle().getAttribute('aria-expanded'),'false');
  // A header/image layout adjustment immediately after collapsing must not reopen it.
  await act(async()=>{Object.defineProperty(dom.window,'scrollY',{configurable:true,value:110});window.dispatchEvent(new dom.window.Event('scroll'));});assert.equal(toggle().getAttribute('aria-expanded'),'false');
  await act(async()=>{await new Promise(r=>setTimeout(r,370));});
  for(const y of [108,106,104,102])await act(async()=>{Object.defineProperty(dom.window,'scrollY',{configurable:true,value:y});window.dispatchEvent(new dom.window.Event('scroll'));});
  assert.equal(toggle().getAttribute('aria-expanded'),'false','Tiny upward movements must not reopen the bar.');
  await act(async()=>{Object.defineProperty(dom.window,'scrollY',{configurable:true,value:30});window.dispatchEvent(new dom.window.Event('scroll'));});assert.equal(toggle().getAttribute('aria-expanded'),'true');assert.equal(reads,0);
 }finally{await act(async()=>root.unmount());if(previousY)Object.defineProperty(dom.window,'scrollY',previousY);}
});


test('mobile touch direction ignores an image layout adjustment and permits a deliberate reverse gesture',async()=>{
 reset();api.syncSessionProgress=async()=>({success:true});
 const q={id:188,index:0,questionText:'Image question',images:[],options:{A:'One',B:'Two',C:'Three',D:'Four'},correctDisplayedOption:'A'};
 const root=createRoot(host()),prior=Object.getOwnPropertyDescriptor(dom.window,'scrollY');
 const scroll=(y:number)=>{Object.defineProperty(dom.window,'scrollY',{configurable:true,value:y});window.dispatchEvent(new dom.window.Event('scroll'));};
 const touch=(type:string,y:number)=>{const event=new dom.window.Event(type);Object.defineProperty(event,'touches',{value:[{clientY:y}]});window.dispatchEvent(event);};
 try{
  Object.defineProperty(dom.window,'scrollY',{configurable:true,value:0});
  await act(async()=>root.render(<McqSessionPlayer initialSession={{id:188001,mode:'study',status:'in_progress',questions:[q],totalQuestions:1}} onExit={()=>{}} onSessionCompleted={()=>{}}/>));
  const open=()=>host().querySelector('button[aria-controls="study-question-navigator"]')!.getAttribute('aria-expanded');
  await act(async()=>{touch('touchstart',600);touch('touchmove',500);scroll(180);});assert.equal(open(),'false');
  await act(async()=>{await new Promise(r=>setTimeout(r,370));});
  await act(async()=>scroll(90));assert.equal(open(),'false','Image loading must not override the downward touch direction.');
  await act(async()=>{touch('touchmove',590);scroll(10);});assert.equal(open(),'true');
 }finally{await act(async()=>root.unmount());if(prior)Object.defineProperty(dom.window,'scrollY',prior);}
});


test('question images retry one temporary failure, reuse the loaded image, and recover from browser display errors',async()=>{
 reset();const {QuestionImageProvider,QuestionImages}=await import('../components/QuestionImages.tsx');const originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=(async()=>{calls++;return calls===1?Response.json({error:'Temporary failure'},{status:503}):new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});}) as typeof fetch;
 const images=[{id:'image-retry-fixture',alt:'Test figure',source:'/api/question-images/test-fixture'}],root=createRoot(host());
 try{
  await act(async()=>root.render(<QuestionImageProvider questions={[{images}]}><QuestionImages images={images}/></QuestionImageProvider>));
  await act(async()=>{await new Promise(r=>setTimeout(r,650));});assert.equal(calls,2);assert.ok(host().querySelector('img'));
  await act(async()=>host().querySelector('img')!.dispatchEvent(new dom.window.Event('error')));assert.match(text(),/browser could not display/);
  await click('Retry image');assert.equal(calls,3);assert.ok(host().querySelector('img'));
  await act(async()=>root.render(<QuestionImageProvider questions={[{images}]}><QuestionImages images={images}/></QuestionImageProvider>));assert.equal(calls,3);
 }finally{await act(async()=>root.unmount());globalThis.fetch=originalFetch;}
});


test('review starts at Question 1, preserves local drafts and pages without writing progress',async()=>{
 reset();let saves=0,syncs=0;const batches:number[]=[];
 const questions=Array.from({length:8},(_,index)=>({id:9100+index,index,questionText:`Review item ${index+1}`,contentLoaded:index<6,options:{A:'One',B:'Two',C:'Three',D:'Four'},correctDisplayedOption:'A',explanation:'Saved explanation',submitted:index===0,selectedDisplayed:index===0?'A':null,isBookmarked:index===0,images:[]}));
 const session={id:91919,title:'Saved review',lectureId:82,mode:'study',status:'in_progress',reviewOnly:true,questions,totalQuestions:8,correctCount:1,incorrectCount:0,unansweredCount:7,elapsedSeconds:12,questionBatch:{size:6,offset:0}};
 const draft=JSON.stringify({version:1,answers:{9107:'B'}});
 localStorage.setItem('medatlas_session_draft_answers_91919',draft);localStorage.setItem('medatlas_session_question_91919','9107');
 api.submitQuestionAnswer=async()=>{saves++;throw Error('Review must not save');};api.syncSessionProgress=async()=>{syncs++;return {} as any;};
 api.getSessionQuestionBatch=async(_id,offset)=>{batches.push(offset);return {session:{...session,reviewOnly:undefined,questions:questions.slice(offset,offset+6).map(q=>({...q,contentLoaded:true}))}};};
 const root=createRoot(host());try{
  await act(async()=>root.render(<McqSessionPlayer initialSession={session} onExit={()=>{}} onSessionCompleted={()=>{}}/>));
  assert.match(text(),/Review item 1/);assert.match(text(),/Answer review/);assert.equal(batches.length,0);
  for(let index=0;index<6;index++)await click('Next Question');
  assert.match(text(),/Review item 7/);assert.deepEqual(batches,[6]);assert.equal([...host().querySelectorAll('button')].some(b=>b.textContent?.trim()==='Finish Session'),false);
  assert.equal(localStorage.getItem('medatlas_session_question_91919'),'9107');
  await click('Back to Workspace');assert.equal(saves,0);assert.equal(syncs,0);
 }finally{await act(async()=>root.unmount());}
 assert.equal(localStorage.getItem('medatlas_session_draft_answers_91919'),draft);
});

test('lecture and practical cards keep the same compact controls and disclose secondary actions locally',async()=>{
 const {SubjectsAndLecturesView}=await import('../components/StudentViews.tsx');
 for(const practical of [false,true]){
  reset();let requests=0;const starts:any[]=[],opened:any[]=[];
  const lecture={id:82,title:'Bones',subjectId:36,contentType:practical?'practical':'lecture',lectureNumber:1,questionCount:8,pdfUrl:'/api/documents/preview',educationalNotes:'Useful notes',difficultyBreakdown:{Easy:0,Medium:5,Hard:3}};
  const props={catalog:{subjects:[{id:36,title:'Anatomy',lectures:[lecture]}],lectures:[lecture]},dashboardData:{subjectProgress:[{subjectId:36,lectures:[{lectureId:82,uniqueQuestionsAttempted:3,activeSessionId:102,reviewSessionId:101,incorrectAnswers:1}]}]},onStartSession:(params:any)=>starts.push(params),onOpenSession:(...args:any[])=>opened.push(args),onResetProgress:async()=>{}};
  globalThis.fetch=async()=>{requests++;throw Error('Opening controls must stay local');};
  const root=createRoot(host());try{
   await act(async()=>root.render(practical?<PracticalView {...props}/>:<SubjectsAndLecturesView {...props}/>));
   assert.equal(host().querySelector('select[aria-label^="Difficulty for"]'),null);
   assert.equal(host().querySelectorAll('.ma-lecture-actions > button').length,4);
   assert.equal(host().querySelector('[aria-label="More actions for Bones"]')!.getAttribute('aria-expanded'),'false');
   assert.equal([...host().querySelectorAll('button')].some(b=>b.textContent==='Restart session'),false);
   assert.ok(findButton('Review Mistakes (1)').closest('.ma-lecture-actions'));
   await click('More actions for Bones');assert.equal(findButton('Review answers').disabled,false);assert.ok(findButton('Restart session'));assert.equal(requests,0);
   await click('Read Notes');assert.match(text(),/Useful notes/);
   await click('Review answers');assert.deepEqual(opened,[[101,true]]);
   await click('Review Mistakes (1)');assert.equal(starts[0].onlyMistakes,true);assert.deepEqual(starts[0].lectureIds,[82]);
   await act(async()=>host().querySelector('.ma-lecture-extra')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
   assert.equal(host().querySelector('.ma-lecture-extra'),null);assert.equal(dom.window.document.activeElement?.id,'lecture-more-82');
   await click('Continue learning');assert.deepEqual(opened[1],[102]);assert.equal(requests,0);
  }finally{await act(async()=>root.unmount());globalThis.fetch=realFetch;}
 }
});

test('simple practice filters stay local, preserve advanced tags and reset incompatible selections',async()=>{
 reset();const {PracticeBuilder}=await import('../components/PracticeBuilder.tsx');let launched:any=null,requests=0;
 const lectures=[{id:1,subjectId:10,title:'Bones',contentType:'practical',questionCount:8,difficultyBreakdown:{Medium:5,Hard:3},specialTagBreakdown:{Important:4}},{id:2,subjectId:20,title:'Sugars',questionCount:6,difficultyBreakdown:{Medium:6}}];
 const root=createRoot(host());globalThis.fetch=async()=>{requests++;throw Error('Filters must not fetch');};
 try{
  await act(async()=>root.render(<PracticeBuilder catalog={{subjects:[{id:10,title:'Anatomy'},{id:20,title:'Biochemistry'}],lectures}} onStartSession={params=>{launched=params;}}/>));
  assert.match(text(),/14 questions in your selection/);assert.equal(findButton('Start practice').disabled,false);
  await click('Anatomy');await change('select','practical');assert.equal(findButton('Start practice').disabled,false);
  const lectureCheckbox=host().querySelector('details input[type="checkbox"]') as HTMLInputElement;await act(async()=>lectureCheckbox.click());
  const important=[...host().querySelectorAll('label')].find(label=>label.textContent==='Important')!.querySelector('input')!;await act(async()=>important.click());
  await change('input[type="number"]','3');await change('fieldset.grid select','Hard');
  await act(async()=>host().querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
  assert.deepEqual(launched.lectureIds,[1]);assert.deepEqual(launched.difficulties,['Hard']);assert.deepEqual(launched.specialTags,['Important']);assert.equal(launched.requestedCount,3);assert.equal(requests,0);
  await change('select','lecture');assert.doesNotMatch(text(),/Important/);assert.match(text(),/0 questions in your selection/);
  await change('fieldset.grid select','all');assert.match(text(),/6 questions in your selection/);
 }finally{await act(async()=>root.unmount());globalThis.fetch=realFetch;}
});

test('exiting and unmounting a study attempt sync elapsed time once without resending answers',async()=>{
 reset();let syncs=0,answers=0;const questions=[{id:9201,index:0,contentLoaded:true,questionText:'Local elapsed-time check',options:{A:'One',B:'Two',C:'Three',D:'Four'},correctDisplayedOption:'A',submitted:false,selectedDisplayed:null,images:[]}];
 const session={id:92929,title:'Progress sync',mode:'study',status:'in_progress',questions,totalQuestions:1,correctCount:0,incorrectCount:0,unansweredCount:1,elapsedSeconds:0};
 api.syncSessionProgress=async()=>{syncs++;return {} as any;};api.submitQuestionAnswer=async()=>{answers++;throw Error('Navigation must not save an answer');};
 const root=createRoot(host());try{
  await act(async()=>root.render(<McqSessionPlayer initialSession={session} onExit={()=>{}} onSessionCompleted={()=>{}}/>));await click('Exit');
  await act(async()=>{dom.window.dispatchEvent(new dom.window.Event('beforeunload'));dom.window.dispatchEvent(new dom.window.Event('pagehide'));});
 }finally{await act(async()=>root.unmount());}
 assert.equal(syncs,1);assert.equal(answers,0);
});

test('practical mock skip asks for confirmation, warns you cannot go back, and skips to next station',async()=>{
 reset();const {PracticalMockView}=await import('../components/PracticalMockView.tsx');
 let skipCalls=0,savedCalls=0;const mockId='11111111-1111-4111-8111-111111111111';
 api.getPracticalMocks=async()=>[{id:mockId,title:'Mock Exam 1',stationCount:2,status:'active'}];
 api.getPracticalMock=async()=>({id:mockId,title:'Mock Exam 1',stationCount:2,status:'active',stationIndex:0,station:{question:'Identify specimen 1',images:[],maxMarks:2},answer:'',revision:0,remainingMs:118_000});
 api.savePracticalMockAnswer=async(_id,_idx,_ans,rev)=>{savedCalls++;return {revision:rev+1};};
 api.skipPracticalMock=async(id,stationIndex)=>{skipCalls++;assert.equal(id,mockId);assert.equal(stationIndex,0);return {id:mockId,title:'Mock Exam 1',stationCount:2,status:'active',stationIndex:1,station:{question:'Identify specimen 2',images:[],maxMarks:2},answer:'',revision:0,remainingMs:120_000};};
 const root=createRoot(host());
 try{
  await act(async()=>root.render(<PracticalMockView isAdmin={false}/>));
  await click('Resume exam');
  assert.match(text(),/Station 1 of 2/);
  await click('Skip image');
  assert.equal(skipCalls,0);
  assert.match(text(),/You cannot go back once you skip/i);
  await click('Cancel');
  assert.doesNotMatch(text(),/You cannot go back once you skip/i);
  assert.equal(skipCalls,0);
  await click('Skip image');
  await click('Confirm skip');
  assert.equal(skipCalls,1);assert.equal(savedCalls,0);
  assert.match(text(),/Station 2 of 2/);assert.match(text(),/Identify specimen 2/);
 }finally{await act(async()=>root.unmount());}
});
