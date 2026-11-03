import QRCode from 'qrcode';
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
type Lecture={id:number;title:string;subjectTitle:string;lectureNumber:number;moduleCode?:string;pdfUrl?:string|null};
type Feedback={text:string;state:'busy'|'error'|'success';progress?:number};
let lectures:Lecture[]=[],compressionConfigured=false,tabletUrl:string|null=null;
const localAddress=['localhost','127.0.0.1','[::1]'].includes(window.location.hostname);
const sharingAddress=()=>localAddress?tabletUrl:window.location.origin;
const expanded=new Set<string>(),feedback=new Map<number,Feedback>(),active=new Set<number>();
let initialGroups=true;
function node<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string):HTMLElementTagNameMap[K]{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
function button(text:string,action:()=>void,className='button secondary'){const n=node('button',text,className);n.type='button';n.addEventListener('click',action);return n;}
function notify(text:string,kind='info'){const n=el('status');n.hidden=!text;n.textContent=text;n.className=kind;n.setAttribute('role',kind==='error'?'alert':'status');}
function updateTotals(){el('total-count').textContent=String(lectures.length);el('attached-count').textContent=String(lectures.filter(l=>l.pdfUrl).length);el('missing-count').textContent=String(lectures.filter(l=>!l.pdfUrl).length);}
function updateCompression(){
  const input=el<HTMLInputElement>('compression');input.disabled=!compressionConfigured;
  el<HTMLSelectElement>('compression-level').disabled=!compressionConfigured || !input.checked;
  el<HTMLButtonElement>('check-compression').disabled=!compressionConfigured;
  if(!compressionConfigured)el('compression-status').textContent='Compression is not configured. Original PDFs will be uploaded.';
}
async function loadLectures(){
  el<HTMLButtonElement>('refresh').disabled=true;
  try{
    const response=await fetch('/api/lectures',{cache:'no-store'});const data=await response.json();
    if(!response.ok || !Array.isArray(data.lectures))throw new Error(data.error || 'The lecture library could not load.');
    lectures=data.lectures;compressionConfigured=Boolean(data.compressionConfigured);tabletUrl=data.tabletUrl || null;
    if(compressionConfigured)el('compression-status').textContent='Compression connected · processed before Telegram upload';
    updateCompression();updateTotals();
    const select=el<HTMLSelectElement>('subject'),selected=select.value;select.replaceChildren();const all=node('option','All subjects');all.value='all';select.append(all);
    for(const subject of [...new Set(lectures.map(l=>l.subjectTitle))]){const option=node('option',subject);option.value=subject;select.append(option);}
    if([...select.options].some(o=>o.value===selected))select.value=selected;
    render();
  }catch(error){notify((error as Error).message,'error');el('results-count').textContent='The lecture library is unavailable. Use Refresh to retry.';}
  finally{el<HTMLButtonElement>('refresh').disabled=false;}
}
function renderFeedback(id:number){
  const container=document.getElementById('upload-'+id);if(!container)return;
  const info=feedback.get(id);container.replaceChildren();container.hidden=!info;
  if(!info)return;container.className='upload-feedback '+info.state;container.append(node('span',info.text));
  if(info.state==='busy'){const p=node('progress');p.max=100;if(info.progress!==undefined && info.progress<100)p.value=info.progress;container.append(p);}
}
function render(){
  const query=el<HTMLInputElement>('search').value.trim().toLowerCase(),subject=el<HTMLSelectElement>('subject').value,status=el<HTMLSelectElement>('pdf-status').value;
  const shown=lectures.filter(l=>(subject==='all' || l.subjectTitle===subject) && (status==='all' || (status==='attached'?!!l.pdfUrl:!l.pdfUrl)) && `${l.subjectTitle} ${l.title} ${l.lectureNumber} ${l.moduleCode || ''}`.toLowerCase().includes(query));
  el('results-count').textContent=`${shown.length} of ${lectures.length} lectures shown · Drop a PDF onto any lecture card`;
  const root=el('lectures');root.replaceChildren();
  if(!shown.length){const box=node('div',undefined,'empty-state');box.append(node('strong',lectures.length?'No lectures match your filters':'Your lecture library is empty'),node('p',lectures.length?'Try another search or show all PDF statuses.':'Create a lecture through the MCQ importer or the MedAtlas admin console.'));if(lectures.length)box.append(button('Clear filters',()=>{el<HTMLInputElement>('search').value='';el<HTMLSelectElement>('subject').value='all';el<HTMLSelectElement>('pdf-status').value='all';render();}));root.append(box);return;}
  const groups=new Map<string,Lecture[]>();for(const l of shown){if(!groups.has(l.subjectTitle))groups.set(l.subjectTitle,[]);groups.get(l.subjectTitle)!.push(l);}
  let index=0;
  for(const [title,items] of groups){
    const group=node('details',undefined,'subject-group');
    if(initialGroups && index<2)expanded.add(title);
    group.open=!!query || subject!=='all' || status!=='all' || expanded.has(title);
    group.addEventListener('toggle',()=>{if(group.open)expanded.add(title);else expanded.delete(title);});
    const summary=node('summary'),heading=node('div',undefined,'subject-heading');heading.append(node('strong',title),node('small',`${items.length} lecture${items.length===1?'':'s'} · ${items.filter(l=>l.pdfUrl).length} PDFs attached`));
    summary.append(node('span',String(++index).padStart(2,'0'),'subject-number'),heading,node('span','⌄','subject-chevron'));
    const cards=node('div',undefined,'lecture-cards');for(const lecture of items)cards.append(lectureCard(lecture));group.append(summary,cards);root.append(group);
  }
  initialGroups=false;
}
function lectureCard(lecture:Lecture){
  const card=node('article',undefined,'lecture-card');card.dataset.lectureId=String(lecture.id);
  const heading=node('div',undefined,'lecture-heading'),info=node('div');info.append(node('p',`${lecture.moduleCode?lecture.moduleCode+' · ':''}LECTURE ${lecture.lectureNumber}`,'lecture-meta'),node('h3',lecture.title,'lecture-title'));
  heading.append(node('span','PDF','document-icon'+(lecture.pdfUrl?' attached':'')),info);
  const bottom=node('div',undefined,'lecture-bottom'),input=node('input');input.type='file';input.accept='.pdf,application/pdf';input.hidden=true;input.setAttribute('aria-label',`Choose PDF for ${lecture.title}`);
  const choose=button(active.has(lecture.id)?'Uploading…':lecture.pdfUrl?'Replace PDF':'Upload PDF',()=>input.click(),lecture.pdfUrl?'button secondary':'button primary');choose.disabled=active.has(lecture.id);
  input.addEventListener('change',()=>{const file=input.files?.[0];input.value='';if(file)void upload(lecture,file);});
  bottom.append(node('span',lecture.pdfUrl?'PDF attached':'Awaiting a PDF','pdf-badge'+(lecture.pdfUrl?'':' missing')),choose,input);
  const status=node('div');status.id='upload-'+lecture.id;status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.hidden=true;
  card.append(heading,bottom,status);
  card.addEventListener('dragover',e=>{e.preventDefault();if(!active.has(lecture.id))card.classList.add('drag');});
  card.addEventListener('dragleave',()=>card.classList.remove('drag'));
  card.addEventListener('drop',e=>{e.preventDefault();card.classList.remove('drag');const files=[...e.dataTransfer?.files || []];if(files.length!==1){notify('Drop one PDF onto its matching lecture.','error');return;}void upload(lecture,files[0]);});
  // The card is attached on the next render pass.
  queueMicrotask(()=>renderFeedback(lecture.id));return card;
}
function sendPdf(form:FormData,onProgress:(percentage:number)=>void):Promise<any>{
  return new Promise((resolve,reject)=>{
    const request=new XMLHttpRequest();request.open('POST','/api/upload');request.timeout=300000;
    request.upload.addEventListener('progress',e=>{if(e.lengthComputable)onProgress(Math.round(e.loaded/e.total*100));});
    request.addEventListener('load',()=>{let data:any;try{data=JSON.parse(request.responseText);}catch{reject(new Error('The portal returned an unreadable response. Please retry.'));return;}if(request.status<200 || request.status>=300 || !data.success)reject(new Error(data.error || 'PDF upload failed.'));else resolve(data);});
    request.addEventListener('error',()=>reject(new Error('The connection was interrupted. Please retry.')));request.addEventListener('timeout',()=>reject(new Error('The PDF upload timed out. Please retry.')));request.send(form);
  });
}
async function upload(lecture:Lecture,file:File){
  if(active.has(lecture.id))return;
  if(!file.name.toLowerCase().endsWith('.pdf')){notify('Choose a PDF file for this lecture.','error');return;}
  const compress=compressionConfigured && el<HTMLInputElement>('compression').checked;
  if(file.size>100*1024*1024 || (!compress && file.size>50*1024*1024)){notify(compress?'Choose a PDF up to 100 MB. The compressed file must fit Telegram’s 50 MB limit.':'PDFs without compression must be no larger than 50 MB.','error');return;}
  if(new TextDecoder().decode(await file.slice(0,5).arrayBuffer())!=='%PDF-'){notify('This file does not contain a valid PDF document.','error');return;}
  if(active.has(lecture.id))return;
  active.add(lecture.id);feedback.set(lecture.id,{text:`Preparing ${file.name}…`,state:'busy',progress:0});notify('');render();
  const form=new FormData();form.append('lectureId',String(lecture.id));form.append('file',file);form.append('compress',String(compress));form.append('compressionLevel',el<HTMLSelectElement>('compression-level').value);
  try{
    const result=await sendPdf(form,percentage=>{feedback.set(lecture.id,{text:percentage<100?`Sending ${file.name} · ${percentage}%`:compress?'Compressing and storing on Telegram…':'Storing on Telegram…',state:'busy',progress:percentage});renderFeedback(lecture.id);});
    lecture.pdfUrl=result.url;
    const compressed=result.compression?.usedCompression;
    const text=compressed?`PDF attached · ${(result.compression.originalSize/1024/1024).toFixed(1)} MB → ${(result.fileSize/1024/1024).toFixed(1)} MB (${result.compression.savingsPercent}% smaller)`:`PDF attached · ${(result.fileSize/1024/1024).toFixed(1)} MB stored on Telegram`;
    feedback.set(lecture.id,{text,state:'success'});updateTotals();
    if(result.compression?.remainingCredits!=null)el('compression-status').textContent=`${result.compression.remainingCredits} compression credits available`;
  }catch(error){feedback.set(lecture.id,{text:(error as Error).message,state:'error'});}
  finally{active.delete(lecture.id);render();}
}
el('search').addEventListener('input',render);el('subject').addEventListener('change',render);el('pdf-status').addEventListener('change',render);el('refresh').addEventListener('click',()=>void loadLectures());
el('compression').addEventListener('change',()=>{try{localStorage.setItem('medatlas_portal_pdf_compress',String(el<HTMLInputElement>('compression').checked));}catch{}updateCompression();});
el('compression-level').addEventListener('change',()=>{try{localStorage.setItem('medatlas_portal_pdf_quality',el<HTMLSelectElement>('compression-level').value);}catch{}});
el('check-compression').addEventListener('click',async()=>{
  const check=el<HTMLButtonElement>('check-compression');check.disabled=true;el('compression-status').textContent='Checking compression balance…';
  try{const response=await fetch('/api/test-ilovepdf',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const data=await response.json();if(!response.ok || !data.success)throw new Error(data.error || 'Compression could not be checked.');el('compression-status').textContent=data.remainingCredits==null?'Compression connection verified.':`${data.remainingCredits} compression credits available`;}
  catch{el('compression-status').textContent='Balance unavailable. Original PDF uploads are still available.';}finally{check.disabled=false;}
});
el('share').addEventListener('click',async()=>{
  const dialog=el<HTMLDialogElement>('share-dialog'),address=sharingAddress(),canvas=el<HTMLCanvasElement>('qr-canvas');
  canvas.hidden=!address;el<HTMLButtonElement>('copy-link').disabled=!address;
  el('copy-link').textContent=address?'Copy portal link':'Local preview only';
  el('share-link').textContent=address || window.location.origin;
  el('share-instructions').textContent=address?(localAddress?'Scan this code from a device on the same Wi-Fi network.':'Scan this code or copy the current portal link.'):'This preview is available on this computer. Use the bot’s HTTPS portal link to open it on your phone or tablet.';
  dialog.showModal();
  if(address)try{await QRCode.toCanvas(canvas,address,{width:230,margin:2,color:{dark:'#173b56',light:'#ffffff'}});}catch{notify('The QR code could not load. Copy the portal link instead.','error');}
});
el('share-close').addEventListener('click',()=>el<HTMLDialogElement>('share-dialog').close());
el('copy-link').addEventListener('click',async()=>{const address=sharingAddress();if(!address)return;try{await navigator.clipboard.writeText(address);el('copy-link').textContent='Link copied';}catch{el('copy-link').textContent='Select and copy the link above';}});
try{const compress=localStorage.getItem('medatlas_portal_pdf_compress'),quality=localStorage.getItem('medatlas_portal_pdf_quality');if(compress!==null)el<HTMLInputElement>('compression').checked=compress==='true';if(quality && ['low','recommended','extreme'].includes(quality))el<HTMLSelectElement>('compression-level').value=quality;}catch{}
window.addEventListener('beforeunload',e=>{if(active.size){e.preventDefault();e.returnValue='';}});
void loadLectures();
