import React,{act} from 'react';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {lectureHref,lectureIdFromSearch} from './lecture-links.ts';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:'https://medatlas-exam.vercel.app/lectures?lecture=92#lecture-92'});
const previous=new Map<string,PropertyDescriptor|undefined>();
for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});}
let scrolled:string[]=[];dom.window.HTMLElement.prototype.scrollIntoView=function(){scrolled.push(this.id);};
const {createRoot}=await import('react-dom/client');
const {SubjectsAndLecturesView,DashboardView}=await import('../components/StudentViews.tsx');
const {default:PracticalView}=await import('../components/PracticalView.tsx');
after(()=>{dom.window.close();for(const [name,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete(globalThis as any)[name];}});
test('lecture links validate identifiers and preserve the correct library route',()=>{
 assert.equal(lectureHref({id:92}),'/lectures?lecture=92#lecture-92');
 assert.equal(lectureHref({id:76,contentType:'practical'}),'/practical?lecture=76#lecture-76');
 assert.equal(lectureIdFromSearch('?lecture=92'),92);
 for(const value of ['','0','-1','abc','1.2','1e3','9007199254740992'])assert.equal(lectureIdFromSearch('?lecture='+value),null);
 assert.throws(()=>lectureHref({id:-1}));
});
const subjects=[{id:8,title:'Biochemistry',questionCount:10,lectures:[{id:92,title:'RNA',lectureNumber:15,questionCount:5},{id:93,title:'TCA',lectureNumber:16,questionCount:5}]},{id:9,title:'Physiology',questionCount:5,lectures:[{id:94,title:'Membrane',lectureNumber:1,questionCount:5}]}];
test('a lecture deep link opens the correct subject and scrolls without creating a quiz; back navigation changes the target',async()=>{
 const host=dom.window.document.getElementById('root')!,root=createRoot(host);let starts=0;scrolled=[];
 try{
  await act(async()=>root.render(<SubjectsAndLecturesView catalog={{subjects,modules:[]}} onStartSession={()=>starts++}/>));
  assert.equal(host.querySelector('#lecture-92')?.closest('details')?.open,true);assert.ok(scrolled.includes('lecture-92'));assert.equal(starts,0);
  await act(async()=>{dom.window.history.pushState({},'', '/lectures?lecture=94#lecture-94');dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));});
  assert.equal(host.querySelector('#lecture-94')?.closest('details')?.open,true);assert.ok(scrolled.includes('lecture-94'));assert.equal(starts,0);
 }finally{await act(async()=>root.unmount());}
});
test('a practical-section link expands the right subject without starting study or opening a PDF',async()=>{
 dom.window.history.replaceState({},'', '/practical?lecture=76#lecture-76');
 const host=dom.window.document.getElementById('root')!,root=createRoot(host);let starts=0;scrolled=[];
 const section={id:76,title:'Scapula',lectureNumber:1,contentType:'practical',questionCount:30};
 try{
  await act(async()=>root.render(<PracticalView dashboardData={{}} catalog={{subjects:[{id:45,title:'Anatomy',lectures:[section]}],lectures:[section]}} onStartSession={()=>starts++}/>));
  assert.equal(host.querySelector('#lecture-76')?.closest('details')?.open,true);assert.ok(scrolled.includes('lecture-76'));assert.equal(starts,0);assert.equal(host.querySelector('[role=dialog]'),null);
 }finally{await act(async()=>root.unmount());}
});

test('home subject cards send Anatomy and Histology to practical while theory subjects keep lectures',async()=>{
 dom.window.history.replaceState({},'', '/');
 const host=dom.window.document.getElementById('root')!,root=createRoot(host),tabs:string[]=[];
 try{
  await act(async()=>root.render(<DashboardView loading={false} dashboardData={{subjectProgress:['Anatomy','Histology','Biochemistry'].map((title,i)=>({subjectId:i+1,title,lectures:[]}))}} onNavigateTab={tab=>tabs.push(tab)} onStartQuickSession={()=>{throw new Error('Browsing must not start a quiz');}} onOpenSession={()=>{throw new Error('Browsing must not resume a quiz');}}/>));
  for(const title of ['Anatomy','Histology','Biochemistry']){
   const button=(Array.from(host.querySelectorAll('button')) as HTMLButtonElement[]).find(node=>node.getAttribute('aria-label')?.startsWith(`Browse ${title} `));assert.ok(button);
   await act(async()=>button.click());
  }
  assert.deepEqual(tabs,['practical','practical','lectures']);
 }finally{await act(async()=>root.unmount());}
});

test('a home subject selection expands its practical sections without starting a quiz',async()=>{
 dom.window.history.replaceState({},'', '/practical');
 const host=dom.window.document.getElementById('root')!,root=createRoot(host);let starts=0;
 const section={id:76,title:'Scapula',lectureNumber:1,contentType:'practical',questionCount:30};
 try{
  await act(async()=>root.render(<PracticalView dashboardData={{}} initialSelectedSubjectId={45} catalog={{subjects:[{id:45,title:'Anatomy',lectures:[section]}],lectures:[section]}} onStartSession={()=>starts++}/>));
  assert.equal(host.querySelector('#lecture-76')?.closest('details')?.open,true);assert.equal(starts,0);
 }finally{await act(async()=>root.unmount());}
});
