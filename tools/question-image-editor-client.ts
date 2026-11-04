import {MAX_QUESTION_IMAGE_BYTES,validImageFileName,type QuestionImage} from '../src/lib/question-images.ts';

type EditableImage={reference?:QuestionImage;file?:File;url?:string;alt:string};
type Detail={id:number;type:string;question:string;status:string;images:QuestionImage[];explanationImages:QuestionImage[];matching:boolean;groupSize:number;revision:string};
const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
const button=(text:string,action:()=>void,style='secondary')=>{const el=node('button',text,'button '+style);el.type='button';el.onclick=action;return el;};
async function request(body:unknown){const response=await fetch('/api/portal/questions',{method:'POST',headers:{'Content-Type':'application/json','X-MedAtlas-Portal':'1'},body:JSON.stringify(body)});const data=await response.json().catch(()=>({error:'Could not reach the portal. Retry after checking your connection.'}));if(!response.ok)throw new Error(data.error||'Request failed.');return data;}

/** Loaded only on upload pages. Nothing is fetched until the uploader requests saved questions. */
export function installQuestionImageEditor(lecture:HTMLSelectElement,type:'mcq'|'short_answer'){
 const host=document.getElementById('image-manager')!;
 const controls=node('div',undefined,'saved-filters'),search=node('input');search.type='search';search.id='saved-search';search.placeholder='Search question text…';search.maxLength=200;
 const label=node('label','Search saved questions');label.htmlFor=search.id;const field=node('div');field.append(label,search);
 const load=button('Load questions',()=>void list(false),'primary');controls.append(field,load);
 const notice=node('p','Choose a lecture or section above, then load its questions.','hint');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
 const rows=node('div',undefined,'saved-question-list'),more=button('Load more questions',()=>void list(true));more.hidden=true;host.append(controls,notice,rows,more);
 let next:number|null=null,loadedLecture='',loadedSearch='',listGeneration=0;
 async function list(append:boolean){
  const target=lecture.value,query=search.value.trim();if(!target){notice.textContent='Choose a target lecture or section first.';lecture.focus();return;}
  const generation=++listGeneration;load.disabled=true;more.disabled=true;notice.textContent='Loading saved questions…';
  try{const data=await request({action:'list',type,lectureId:Number(target),search:query,after:append&&loadedLecture===target&&loadedSearch===query?next:0});if(generation!==listGeneration||lecture.value!==target)return;
   if(!append||loadedLecture!==target||loadedSearch!==query)rows.replaceChildren();loadedLecture=target;loadedSearch=query;
   for(const q of data.questions){const row=node('article',undefined,'saved-question'),content=node('div'),meta=node('p',`${q.type} · #${q.id} · ${q.status}`,'saved-meta'),title=node('h3',q.question),count=node('p',`${q.imageCount} question image${q.imageCount===1?'':'s'}${q.explanationImageCount?` · ${q.explanationImageCount} explanation images`:''}`,'hint');content.append(meta,title,count);const actions=node('div',undefined,'actions');actions.append(button(q.imageCount?'Edit images':'Add images',()=>void open(q.id)));if(type==='short_answer'||q.shortAnswerId)actions.append(button(q.status==='published'?'Return to draft':'Publish',async()=>{load.disabled=true;try{const response=await fetch('/api/sa-portal/manage',{method:'POST',headers:{'Content-Type':'application/json','X-MedAtlas-Portal':'1'},body:JSON.stringify({lectureId:Number(target),ids:[q.shortAnswerId||q.id],status:q.status==='published'?'draft':'published'})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not update status.');await list(false);}catch(error){notice.textContent=(error as Error).message;}finally{load.disabled=false;}}));row.append(content,actions);rows.append(row);}
   next=data.nextCursor;more.hidden=next===null;notice.textContent=rows.children.length?`${rows.children.length} questions shown${next?' · More available':''}. Published questions can be edited directly.`:'No questions found. Try another search or destination.';
  }catch(error){notice.textContent=(error as Error).message;}finally{if(generation===listGeneration){load.disabled=false;more.disabled=false;}}
 }
 search.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void list(false);}});
 lecture.addEventListener('change',()=>{listGeneration++;load.disabled=false;more.disabled=false;rows.replaceChildren();more.hidden=true;loadedLecture='';notice.textContent='Destination changed. Load questions for the selected lecture or section.';});

 const dialog=node('dialog',undefined,'image-edit-dialog');dialog.setAttribute('aria-labelledby','image-edit-title');
 const heading=node('div',undefined,'section-heading'),title=node('h2','Edit question images');title.id='image-edit-title';
 let detail:Detail|null=null,questionImages:EditableImage[]=[],explanationImages:EditableImage[]=[],saving=false,dirty=false,editLecture='';
 const revoke=()=>{for(const image of [...questionImages,...explanationImages])if(image.url)URL.revokeObjectURL(image.url);};
 function close(){if(saving)return;if(dirty&&!window.confirm('Discard the unsaved image changes?'))return;revoke();dialog.close();}
 const closeButton=button('Close',close,'subtle');heading.append(title,closeButton);const text=node('p',undefined,'editor-question'),hint=node('p',undefined,'hint');
 const fields=node('fieldset'),error=node('p',undefined,'notice error');error.hidden=true;error.setAttribute('role','alert');
 const questionArea=node('div'),explanationArea=node('div');fields.append(questionArea,explanationArea);
 const actions=node('div',undefined,'actions end'),save=button('Save images',()=>void persist(),'primary');actions.append(button('Cancel',close),save);
 const progress=node('p',undefined,'hint');progress.setAttribute('role','status');progress.setAttribute('aria-live','polite');
 dialog.append(heading,text,hint,error,fields,progress,actions);document.body.append(dialog);
 dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 window.addEventListener('beforeunload',event=>{if(dirty||saving){event.preventDefault();event.returnValue='';}});
 function renderArea(area:HTMLElement,images:EditableImage[],explanation:boolean){
  area.replaceChildren();area.append(node('h3',explanation?'Explanation images':'Question images'));
  const max=detail?.matching&&!explanation?1:4;
  const grid=node('div',undefined,'edit-image-grid');area.append(grid);
  for(const [i,image] of images.entries()){
   const figure=node('figure',undefined,'edit-image'),img=node('img');img.src=image.url||'/api/portal/question-image?source='+encodeURIComponent(image.reference!.source!);img.alt=image.alt||`Attached image ${i+1}`;
   const caption=node('figcaption',image.file?.name||`Saved image ${i+1}`),alt=node('input');alt.type='text';alt.value=image.alt;alt.maxLength=500;alt.id=`edit-${explanation?'explanation':'question'}-alt-${i}`;const altLabel=node('label','Image description (optional)');altLabel.htmlFor=alt.id;alt.oninput=()=>{image.alt=alt.value;dirty=true;};
   img.onerror=()=>{caption.textContent='Image preview unavailable. The reference is still saved; retry loading it later.';};
   figure.append(img,caption,altLabel,alt,button('Remove image',()=>{if(image.url)URL.revokeObjectURL(image.url);images.splice(i,1);dirty=true;render();},'subtle'));grid.append(figure);
  }
  if(!images.length)area.append(node('p','No images attached.','hint'));
  const input=node('input');input.type='file';input.multiple=max>1;input.accept='.png,.jpg,.jpeg,.webp';input.id=explanation?'edit-explanation-files':'edit-question-files';input.disabled=images.length>=max;const label=node('label',images.length>=max?'Remove an image to replace it':'Add image'+(max>1?'s':''));label.htmlFor=input.id;
  input.onchange=()=>{
   const files=[...input.files||[]];error.hidden=true;
   if(images.length+files.length>max){fail(`Use ${max===1?'exactly one numbered image':`up to ${max} images`}. Remove an existing image first to replace it.`);input.value='';return;}
   if(files.some(file=>!validImageFileName(file.name)||file.size<1||file.size>MAX_QUESTION_IMAGE_BYTES)){fail('Choose PNG, JPEG or WebP images up to 2 MB each.');input.value='';return;}
   for(const file of files)images.push({file,url:URL.createObjectURL(file),alt:''});dirty=true;render();
  };
  area.append(label,input,node('p',`PNG, JPEG or WebP · 2 MB each · ${max===1?'1 numbered image':`up to ${max} images`}`,'hint'));
 }
 function render(){renderArea(questionArea,questionImages,false);explanationArea.hidden=detail?.type==='short_answer';if(detail?.type!=='short_answer')renderArea(explanationArea,explanationImages,true);}
 function fail(message:string){error.textContent=message;error.hidden=false;}
 async function open(id:number){
  if(!lecture.value)return;const target=lecture.value;notice.textContent='Opening question…';
  try{const data:Detail=await request({action:'get',type,lectureId:Number(target),id});if(lecture.value!==target)return;revoke();detail=data;editLecture=target;dirty=false;questionImages=data.images.map(reference=>({reference,alt:reference.alt||''}));explanationImages=data.explanationImages.map(reference=>({reference,alt:reference.alt||''}));text.textContent=data.question;hint.textContent=data.matching?`The numbered image will be updated for all ${data.groupSize} labels in this group. Saved answers and historical reviews stay unchanged.`:'Changes apply to this question. Saved answers, bookmarks and historical reviews stay unchanged.';error.hidden=true;progress.textContent='';render();dialog.showModal();notice.textContent='Question opened.';}catch(error){notice.textContent=(error as Error).message;}
 }
 async function persist(){
  if(!detail||saving)return;if(detail.matching&&questionImages.length!==1){fail('Matching questions need one numbered image. Add a replacement before saving.');return;}
  saving=true;fields.disabled=true;save.disabled=true;closeButton.disabled=true;error.hidden=true;
  try{
   const uploaded=new Map<File,QuestionImage>();
   async function references(images:EditableImage[]){const result:QuestionImage[]=[];for(const image of images){let reference=image.reference;
    if(image.file){reference=uploaded.get(image.file);if(!reference){progress.textContent='Uploading image to Telegram…';const response=await fetch('/api/mcq/image?name='+encodeURIComponent(image.file.name),{method:'POST',headers:{'Content-Type':'application/octet-stream','X-MedAtlas-Portal':'1'},body:image.file});const data=await response.json().catch(()=>({error:'Telegram image upload failed. Retry.'}));if(!response.ok)throw new Error(data.error||'Telegram image upload failed.');reference=data;uploaded.set(image.file,reference!);image.reference=reference;}}
    result.push({...reference!,alt:image.alt});}return result;}
   const images=await references(questionImages),explanation=await references(explanationImages);progress.textContent='Saving image references…';
   const result=await request({action:'save',type:detail.type,lectureId:Number(editLecture),id:detail.id,revision:detail.revision,images,explanationImages:explanation});dirty=false;revoke();dialog.close();await list(false);notice.textContent=`Images saved${result.updated>1?` for ${result.updated} matching labels`:''}. The question’s publication status was preserved.`;
  }catch(error){fail((error as Error).message);progress.textContent='Your changes are still here. Correct the issue, then retry.';}finally{saving=false;fields.disabled=false;save.disabled=false;closeButton.disabled=false;}
 }
}
