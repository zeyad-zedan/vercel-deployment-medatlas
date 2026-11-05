import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {X,ChevronLeft,ChevronRight,ExternalLink,MessageCircle} from 'lucide-react';
import {api} from '../lib/api.ts';
import {MAX_GEMINI_KEY_LENGTH,validStudentGeminiKey} from '../lib/gemini-key-input.ts';

const steps=[
 {title:'افتح Google AI Studio',text:'اضغط على الزر اللي تحت، وسجّل دخول بحساب Google بتاعك. لو ظهرت شروط الاستخدام، اقرأها وكمّل لو موافق.'},
 {title:'اعمل مفتاح جديد',text:'من صفحة API keys، اضغط Create API key. ده المفتاح الشخصي اللي هيخلّي MedAtlas يطلب تصحيح إجابتك باستخدام حسابك.'},
 {title:'اختار مشروعك',text:'سمّي المفتاح MedAtlas عشان تفتكره. اختار مشروع متاح، أو Create project لو الخيار ظاهر. لو Google جهّزلك مشروع تلقائي، تقدر تستخدمه، وبعدها اضغط Create key.'},
 {title:'انسخ المفتاح كامل',text:'اضغط Copy key. انسخ المفتاح نفسه، مش اسم المشروع أو رقمه. احتفظ بيه لنفسك، وما تبعتوش لأي حد، حتى في رسالة الدعم.'},
 {title:'حط المفتاح هنا… وكده خلصنا!',text:'ارجع للتبويب ده والصق المفتاح في الخانة اللي تحت. هنحفظه مشفّر مع حسابك، ومش هتحتاج تدخّله كل مرة. تقدر تغيّره أو تمسحه من Profile & Settings ← Gemini API key.'},
];

export default function GeminiSetupGuide({onClose,onReady}:{onClose:()=>void;onReady:()=>void}){
 const [step,setStep]=useState(0),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const panel=useRef<HTMLDivElement>(null),heading=useRef<HTMLHeadingElement>(null),alive=useRef(true),closeRef=useRef(onClose);
 closeRef.current=onClose;
 useEffect(()=>{
  alive.current=true;const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;
  document.body.style.overflow='hidden';panel.current?.focus();
  const handle=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeRef.current();return;}
   if(event.key!=='Tab')return;
   const nodes=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled)')||[]),first=nodes[0],last=nodes.at(-1);
   if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel.current)){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===panel.current)){event.preventDefault();first?.focus();}
  };
  document.addEventListener('keydown',handle,true);
  return()=>{alive.current=false;document.body.style.overflow=overflow;document.removeEventListener('keydown',handle,true);previous?.focus();};
 },[]);
 useEffect(()=>{heading.current?.focus();},[step]);
 const save=async(event:React.FormEvent)=>{
  event.preventDefault();setError('');const value=key.trim();
  if(!validStudentGeminiKey(value)){setError('المفتاح مش كامل أو فيه مسافات. جرّب تنسخه تاني من زر Copy key، والصقه من غير أي كلام إضافي.');return;}
  setBusy(true);
  try{await api.saveGeminiKey(value);setKey('');if(alive.current)onReady();}
  catch(failure:any){if(alive.current)setError(failure?.status===401?'جلسة الدخول انتهت. سجّل دخول تاني؛ إجابتك محفوظة.':failure?.status===503?'حفظ المفاتيح مش متاح مؤقتًا. جرّب كمان شوية، أو ابعتلنا رسالة.':failure?.status===400?'المفتاح مش مقبول. انسخ المفتاح كامل من Google AI Studio وجرّب تاني.':'الحفظ ما كملش. اتأكد من الإنترنت وجرّب تاني؛ المفتاح لسه في الخانة.');}
  finally{if(alive.current)setBusy(false);}
 };
 return createPortal(<div className="ma-gemini-guide" dir="rtl" lang="ar"><div ref={panel} role="dialog" aria-modal="true" aria-labelledby="gemini-guide-title" tabIndex={-1} className="ma-gemini-guide-panel">
  <header><div><h2 id="gemini-guide-title">أهلاً يا صديقي 👋</h2><p>ولا يهمك، إجابتك محفوظة. خلّينا نجهّز التصحيح مع بعض، خطوة بخطوة.</p></div><button type="button" onClick={onClose} aria-label="إغلاق الشرح"><X size={21}/></button></header>
  <div className="ma-gemini-guide-body">
   <ol aria-label="خطوات تجهيز التصحيح" className="ma-gemini-guide-steps">{steps.map((s,i)=><li key={s.title}><button type="button" aria-current={i===step?'step':undefined} aria-label={`الخطوة ${i+1}: ${s.title}`} onClick={()=>setStep(i)}>{i+1}</button></li>)}</ol>
   <p className="ma-gemini-guide-counter">الخطوة {step+1} من {steps.length}</p>
   <h3 ref={heading} tabIndex={-1}>{steps[step].title}</h3><p>{steps[step].text}</p>
   <figure><img src={`/tutorials/gemini/step-${step+1}.svg`} alt={`رسم توضيحي للخطوة ${step+1}: ${steps[step].title}`} width="760" height="360"/><figcaption>رسم توضيحي للتسهيل؛ شكل Google وأسماء الأزرار ممكن يختلفوا بسيط حسب اللغة والحساب.</figcaption></figure>
   {step===0&&<a className="ma-gemini-guide-primary" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">افتح Google AI Studio <ExternalLink size={16}/></a>}
   {step===2&&<p className="ma-gemini-guide-note">هنستخدم الحصة المجانية المتاحة لمشروعك. مش مطلوب تفعّل Billing أو تضيف وسيلة دفع للشرح ده. لو ظهرت خطوة لتأكيد المشروع، اتبع إرشادات Google.</p>}
   {step===4&&<form onSubmit={save} className="ma-gemini-guide-form"><label htmlFor="gemini-guide-key">مفتاح Gemini API الخاص بيك</label><input id="gemini-guide-key" dir="ltr" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={MAX_GEMINI_KEY_LENGTH} value={key} disabled={busy} onChange={event=>setKey(event.target.value)} placeholder="الصق المفتاح الكامل هنا" required/>
    <p>وقت التصحيح، إجابتك والسؤال ودليل التصحيح بيتبعتوا لـGoogle باستخدام حصتك. صور الأسئلة مش بتتبعت. حفظ المفتاح لوحده مش بيستهلك طلب تصحيح.</p>
    {error&&<p role="alert" className="ma-gemini-guide-error">{error}</p>}<button className="ma-gemini-guide-primary" disabled={busy||!key.trim()} type="submit">{busy?'بنحفظ المفتاح…':'احفظ المفتاح وكمّل التصحيح'}</button></form>}
   <div className="ma-gemini-guide-nav"><button type="button" disabled={step===0} onClick={()=>setStep(i=>i-1)}><ChevronRight size={16}/> السابق</button>{step<4&&<button type="button" className="ma-gemini-guide-primary" onClick={()=>setStep(i=>i+1)}>تمام، الخطوة اللي بعدها <ChevronLeft size={16}/></button>}</div>
  </div>
  <footer><p>ولو احتجت أي مساعدة، ابعتلنا رسالة وإحنا نساعدك خطوة بخطوة 💚</p><a href="https://t.me/MedAtlasMCQ?direct" target="_blank" rel="noopener noreferrer"><MessageCircle size={16}/> ابعتلنا على تليجرام</a><button type="button" onClick={onClose}>هكمّل بعدين وأرجع لإجابتي</button></footer>
 </div></div>,document.body);
}
