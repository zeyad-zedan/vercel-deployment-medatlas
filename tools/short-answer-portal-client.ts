import {shortAnswerTemplate,parseShortAnswerBatch} from '../src/lib/short-answer-model.ts';
import {guidedUpload} from './guided-upload.ts';
import {installDestinationCreator} from './destination-creator.ts';
import {installQuestionWorkflow} from './question-workflow.ts';
import {destinationLabel} from '../src/lib/lecture-kinds.ts';
import {validImageFileName,MAX_QUESTION_IMAGE_BYTES,type QuestionImage} from '../src/lib/question-images.ts';
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const source=el<HTMLTextAreaElement>('source'),lecture=el<HTMLSelectElement>('lecture'),form=el<HTMLFieldSetElement>('sa-form');
installQuestionWorkflow(lecture,'short_answer');
let previewSource='',previewLecture='',previewMode='';
type ImageAsset={file:File;id:string;url:string};
const imageAssets=new Map<string,ImageAsset>(),uploadedImages=new Map<string,QuestionImage>();
let guideImageNames:string[]=[];
const manifest=()=>[...imageAssets].map(([name,asset])=>({name,id:asset.id}));
function imagePreview(name:string,remove?:()=>void){
 const asset=imageAssets.get(name),figure=document.createElement('figure');figure.className='sa-image-preview';if(!asset)return figure;
 const img=document.createElement('img');img.src=asset.url;img.alt=name;const caption=document.createElement('figcaption');caption.textContent=name;figure.append(img,caption);
 if(remove){const button=document.createElement('button');button.type='button';button.className='button subtle';button.textContent='Remove image';button.onclick=remove;figure.append(button);}return figure;
}
function renderImageAssets(){el('sa-guide-images').replaceChildren(...guideImageNames.map(name=>imagePreview(name,()=>{guideImageNames=guideImageNames.filter(n=>n!==name);renderImageAssets();})));el('sa-batch-images').replaceChildren(...[...imageAssets.keys()].map(name=>imagePreview(name)));}
async function selectImages(files:File[],forGuide:boolean){
 const additions:ImageAsset[]=[];form.disabled=true;
 try{
  if(new Set(files.map(f=>f.name)).size!==files.length)throw new Error('Use unique image filenames.');
  if(forGuide&&new Set([...guideImageNames,...files.map(f=>f.name)]).size>4)throw new Error('Use at most four images per question.');
  if(new Set([...imageAssets.keys(),...files.map(f=>f.name)]).size>100)throw new Error('Use at most 100 selected images per batch.');
  if(!crypto.subtle)throw new Error('Use the HTTPS bot portal link, or localhost, to select images.');
  for(const file of files){if(!validImageFileName(file.name)||!file.size||file.size>MAX_QUESTION_IMAGE_BYTES)throw new Error('Choose PNG, JPEG or WebP images up to 2 MB each.');const bytes=await file.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes),id=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(imageAssets.has(file.name)&&imageAssets.get(file.name)!.id!==id)throw new Error(`Rename ${file.name}: this batch already uses that filename for another image.`);additions.push({file,id,url:URL.createObjectURL(file)});}
  for(const asset of additions){const old=imageAssets.get(asset.file.name);if(old)URL.revokeObjectURL(old.url);imageAssets.set(asset.file.name,asset);}
  if(forGuide)guideImageNames=[...new Set([...guideImageNames,...files.map(f=>f.name)])];clear();renderImageAssets();message('Images selected. They will be stored on Telegram when you confirm the import.');
 }catch(error){for(const asset of additions)if(imageAssets.get(asset.file.name)!==asset)URL.revokeObjectURL(asset.url);message((error as Error).message);if(forGuide){el('sa-guide-error').textContent=(error as Error).message;el('sa-guide-error').hidden=false;}}finally{form.disabled=false;}
}
const message=(text:string)=>{el('status').textContent=text;el('status').hidden=false;};
const clear=()=>{el('preview').hidden=true;previewSource='';};
const request=async(action:string,stored?:Record<string,QuestionImage>)=>{const response=await fetch('/api/sa-portal/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-MedAtlas-Portal':'1'},body:JSON.stringify({jsonContent:source.value,lectureId:Number(lecture.value),publication:el<HTMLSelectElement>('publication').value,imageFiles:manifest(),uploadedImages:stored})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Request failed.');return data;};
const creator=installDestinationCreator(lecture,async saved=>{await loadDestinations();lecture.value=String(saved.id);clear();message(`${saved.contentType==='practical'?'Section':'Lecture'} created and selected. Add your questions next.`);});
async function loadDestinations(){const response=await fetch('/api/mcq/lectures');if(!response.ok)throw new Error('Could not load lectures or sections.');const data=await response.json();const selected=lecture.value;lecture.replaceChildren();lecture.append(new Option('Choose a lecture or section…',''));for(const l of data.lectures)lecture.append(new Option(destinationLabel(l)+(l.status!=='published'?` [${l.status}]`:''),String(l.id)));lecture.value=selected;creator.setSubjects(data.subjects||[]);}
void loadDestinations().catch(()=>message('Could not load lectures or sections. Refresh to retry.'));
el('sample').onclick=()=>{source.value=shortAnswerTemplate;clear();};
el('download').onclick=()=>{const url=URL.createObjectURL(new Blob([shortAnswerTemplate],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='short-answer-questions.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
el('file').onchange=async()=>{const file=el<HTMLInputElement>('file').files?.[0];if(!file)return;if(file.size>1024*1024){message('Choose a JSON file under 1 MB.');return;}source.value=await file.text();clear();};
source.oninput=clear;lecture.onchange=clear;el('publication').onchange=clear;
el('validate').onclick=async()=>{form.disabled=true;clear();try{const data=await request('preview');el('rows').replaceChildren();for(const [i,q] of data.questions.entries()){const article=document.createElement('article');article.className='card';const heading=document.createElement('h3');heading.textContent=`${i+1}. ${q.question_text} · ${q.maxScore} marks · ${q.status}`;article.append(heading);for(const image of q.imageFiles||[])article.append(imagePreview(image.file));for(const text of [`Model answer: ${q.model_answer}`,`Tags: ${q.tags.join(', ')||'None'}`,...q.rubric.map((p:any)=>`${p.marks} mark(s): ${p.description}`)]){const p=document.createElement('p');p.textContent=text;article.append(p);}el('rows').append(article);}previewSource=source.value;previewLecture=lecture.value;previewMode=el<HTMLSelectElement>('publication').value;el('preview').hidden=false;message(`${data.questions.length} questions ready. Check the model answers and marking points.`);}catch(error){message((error as Error).message);}finally{form.disabled=false;}};
el('confirm').onclick=async()=>{if(!previewSource||previewSource!==source.value||previewLecture!==lecture.value||previewMode!==el<HTMLSelectElement>('publication').value){clear();message('Your batch changed. Validate it again.');return;}form.disabled=true;try{const needed=new Set(parseShortAnswerBatch(source.value).flatMap(q=>(q.imageFiles||[]).map(image=>image.file))),stored:Record<string,QuestionImage>={};let done=0;for(const name of needed){const asset=imageAssets.get(name);if(!asset)throw new Error(`Select the missing image: ${name}`);message(`Storing image ${++done} of ${needed.size} on Telegram…`);let reference=uploadedImages.get(asset.id);if(!reference){const response=await fetch('/api/mcq/image?name='+encodeURIComponent(name),{method:'POST',headers:{'Content-Type':'application/octet-stream','X-MedAtlas-Portal':'1'},body:asset.file});const data=await response.json();if(!response.ok||data.id!==asset.id)throw new Error('Image upload failed. Check the file and retry.');reference=data;uploadedImages.set(asset.id,reference!);}stored[name]=reference!;}const result=await request('execute',stored);clear();message(`${result.imported} questions imported; ${result.duplicates} duplicates skipped.`);}catch(error){message((error as Error).message);}finally{form.disabled=false;}};
let pointNumber=0;
function updateTotal(){const total=[...el('sa-rubric').querySelectorAll<HTMLInputElement>('[data-marks]')].reduce((sum,input)=>sum+(Number(input.value)||0),0);el('sa-total').textContent=`Total: ${total} ${total===1?'mark':'marks'}`;}
function addPoint(){
 if(el('sa-rubric').children.length>=15){message('Use at most 15 marking points.');return;}
 const number=++pointNumber,row=document.createElement('div');row.className='guided-point';
 const description=document.createElement('textarea');description.rows=2;description.maxLength=700;description.dataset.description='';description.id=`sa-point-${number}`;
 const label=document.createElement('label');label.htmlFor=description.id;label.textContent=`Marking point ${number}`;
 const marks=document.createElement('input');marks.type='number';marks.min='1';marks.max='10';marks.step='1';marks.value='1';marks.dataset.marks='';marks.id=`sa-marks-${number}`;marks.oninput=updateTotal;
 const marksLabel=document.createElement('label');marksLabel.htmlFor=marks.id;marksLabel.textContent=`Marks for point ${number}`;
 const remove=document.createElement('button');remove.type='button';remove.className='button subtle';remove.textContent='Remove point';remove.onclick=()=>{row.remove();updateTotal();};
 row.append(label,description,marksLabel,marks,remove);el('sa-rubric').append(row);updateTotal();
}
function guidedQuestion(){return {question_type:'short_answer',question_text:el<HTMLTextAreaElement>('sa-question').value.trim(),model_answer:el<HTMLTextAreaElement>('sa-model-answer').value.trim(),rubric:[...el('sa-rubric').children].map(row=>({description:row.querySelector<HTMLTextAreaElement>('[data-description]')!.value.trim(),marks:Number(row.querySelector<HTMLInputElement>('[data-marks]')!.value)})),tags:el<HTMLInputElement>('sa-tags').value.split(',').map(t=>t.trim()).filter(Boolean),status:'draft',...(guideImageNames.length?{images:guideImageNames}: {})};}
const wizard=guidedUpload('sa-guide',['Question and model answer','Marking points','Review and tags'],step=>{
 if(step===0){if(!el<HTMLTextAreaElement>('sa-question').value.trim())throw new Error('Write the question first.');if(!el<HTMLTextAreaElement>('sa-model-answer').value.trim())throw new Error('Add the complete model answer.');}
 if(step===1)parseShortAnswerBatch(JSON.stringify({questions:[{...guidedQuestion(),tags:[]}]}));
},step=>{if(step===2){const question=guidedQuestion();el('sa-guide-summary').textContent=`${question.question_text}\nModel answer: ${question.model_answer}\n${question.rubric.length} marking points · ${question.rubric.reduce((sum,p)=>sum+p.marks,0)} total marks`;}});
el('open-sa-guide').onclick=()=>{el('sa-guide').hidden=false;if(!el('sa-rubric').children.length)addPoint();wizard.reset();el('sa-guide').scrollIntoView({block:'start',behavior:'smooth'});};
el('close-sa-guide').onclick=()=>{el('sa-guide').hidden=true;};el('sa-add-point').onclick=addPoint;
el('sa-image-files').onchange=async()=>{const input=el<HTMLInputElement>('sa-image-files');await selectImages([...input.files||[]],true);input.value='';};
el('sa-json-images').onchange=async()=>{const input=el<HTMLInputElement>('sa-json-images');await selectImages([...input.files||[]],false);input.value='';};
el('sa-guide-finish').onclick=()=>{
 try{
  const question=guidedQuestion();parseShortAnswerBatch(JSON.stringify({questions:[question]}));
  let root=source.value.trim()?JSON.parse(source.value):{questions:[]};if(Array.isArray(root))root={questions:root};if(!root||!Array.isArray(root.questions))throw new Error('Your JSON must contain a questions array.');
  const next={...root,questions:[...root.questions,question]};parseShortAnswerBatch(JSON.stringify(next));source.value=JSON.stringify(next,null,2);clear();el('sa-guide').hidden=true;
  for(const id of ['sa-question','sa-model-answer','sa-tags'])el<HTMLInputElement>(id).value='';el('sa-rubric').replaceChildren();pointNumber=0;
  guideImageNames=[];renderImageAssets();
  message(`${next.questions.length} question(s) in your batch. Build another question, or choose Validate & preview.`);
 }catch(error){el('sa-guide-error').textContent=(error as Error).message;el('sa-guide-error').hidden=false;}
};
