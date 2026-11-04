import { getSampleJsonTemplate, type JsonValidationReport, type JsonQuestionRow } from '../src/lib/json-import.ts';
import { parseSpecialTags } from '../src/lib/mcq-engine.ts';
import { expandMatchingQuestion } from '../src/lib/matching-questions.ts';
import {guidedUpload} from './guided-upload.ts';
import {destinationLabel} from '../src/lib/lecture-kinds.ts';
import {installDestinationCreator} from './destination-creator.ts';
import {installQuestionWorkflow} from './question-workflow.ts';
import { MAX_IMPORT_IMAGES, MAX_QUESTION_IMAGE_BYTES, validImageFileName, type QuestionImage } from '../src/lib/question-images.ts';

const element=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const source=element<HTMLTextAreaElement>('source'), lecture=element<HTMLSelectElement>('lecture');
const form=element<HTMLFieldSetElement>('import-form');
installQuestionWorkflow(lecture,'mcq');
const presets=['Old Exams','كتاب القسم','Important'];
type Asset={file:File;id:string;url:string};
type TagKey='specialTags'|'tags';
const assets=new Map<string,Asset>(), uploaded=new Map<string,QuestionImage>();
const overrides=new Map<number,{specialTags?:string;tags?:string}>(),expanded=new Set<number>();
let fileName='questions.json', revision=0, busy=false, pageSize=50;
let report:JsonValidationReport|null=null;
let lectures:Array<{id:number;title:string;subjectTitle:string;status:string;contentType?:string;lectureNumber?:number}>=[];

function make<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string):HTMLElementTagNameMap[K] {
  const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;
}
function button(label:string,action:()=>void,className='button secondary') {
  const node=make('button',label,className);node.type='button';node.addEventListener('click',action);return node;
}
function message(text:string,kind='info') {
  const status=element('status');status.textContent=text;status.className=kind;status.hidden=!text;
  if(kind==='error')status.setAttribute('role','alert');else status.setAttribute('role','status');
}
function setBusy(value:boolean,text='') {
  busy=value;form.disabled=value;element<HTMLButtonElement>('sample').disabled=value;
  element<HTMLButtonElement>('new-import').disabled=value;
  if(text)message(text,'busy');
}
function invalidate() {
  revision++;report=null;pageSize=50;overrides.clear();expanded.clear();
  element('preview').hidden=true;element('result').hidden=true;message('');
}
function manifest(){return [...assets].map(([name,asset])=>({name,id:asset.id}));}
async function request(path:string,body?:unknown):Promise<any> {
  const serialized=body===undefined?undefined:JSON.stringify(body);
  if(serialized && new TextEncoder().encode(serialized).length>4*1024*1024)throw new Error('This batch is too large to send. Split it into smaller JSON files.');
  const response=await fetch('/api/mcq/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json','X-MedAtlas-Portal':'1'},body:serialized});
  const data=await response.json().catch(()=>({error:'Could not reach the upload portal. Reopen your bot link and try again.'}));
  if(!response.ok)throw new Error(data.error || 'The request could not be completed.');return data;
}
function target(){return lecture.value?Number(lecture.value):undefined;}
function publication(){return element<HTMLSelectElement>('publication').value;}
function renderLectures() {
  const selected=lecture.value,query=element<HTMLInputElement>('lecture-search').value.trim().toLowerCase();
  const options=lectures.filter(l=>`${l.subjectTitle} ${l.title}`.toLowerCase().includes(query) || String(l.id)===selected);
  const automatic=make('option','Use JSON destinations (subject + lecture)');automatic.value='';lecture.replaceChildren(automatic);
  for(const row of options){const option=make('option',`${destinationLabel(row)}${row.status!=='published'?' ['+row.status+']':''}`);option.value=String(row.id);lecture.append(option);}
  lecture.value=selected;
}
async function loadLectures() {
  const data=await request('lectures');lectures=data.lectures;renderLectures();creator.setSubjects(data.subjects||[]);element('matching-preview-note').hidden=!data.matchingPreviewOnly;
}
function renderAssets() {
  element('asset-section').hidden=!assets.size;element('asset-count').textContent=`${assets.size} selected image${assets.size===1?'':'s'}`;
  const grid=element('assets');grid.replaceChildren();
  for(const [name,asset] of assets){
    const figure=make('figure',undefined,'asset'),img=make('img');img.src=asset.url;img.alt=name;
    figure.append(img,make('figcaption',`${name} · ${(asset.file.size/1024).toFixed(0)} KB`),button('Remove',()=>{if(busy)return;URL.revokeObjectURL(asset.url);assets.delete(name);invalidate();renderAssets();},''));grid.append(figure);
  }
  renderMatchingImages();
}
async function selectFiles(files:File[]) {
  if(busy || !files.length)return;
  setBusy(true,'Reading files and checking image fingerprints…');
  const additions:Asset[]=[];
  try {
    const json=files.filter(f=>f.name.toLowerCase().endsWith('.json'));
    const images=files.filter(f=>!f.name.toLowerCase().endsWith('.json'));
    if(json.length>1)throw new Error('Choose one JSON file per batch.');
    if(images.length && !crypto.subtle)throw new Error('Open the HTTPS portal link from your Telegram bot to upload images on this device.');
    if(json[0]?.size>4*1024*1024)throw new Error('The JSON file must be no larger than 4 MB.');
    if(images.some(f=>!validImageFileName(f.name)))throw new Error('Select a JSON file and PNG, JPEG, or WebP images.');
    if(images.some(f=>f.size>MAX_QUESTION_IMAGE_BYTES))throw new Error('Each image must be no larger than 2 MB.');
    if(new Set(images.map(f=>f.name)).size!==images.length)throw new Error('Selected images have duplicate filenames. Rename them and update the JSON.');
    if(new Set([...assets.keys(),...images.map(f=>f.name)]).size>MAX_IMPORT_IMAGES)throw new Error(`Select at most ${MAX_IMPORT_IMAGES} image files per batch.`);
    const text=json[0]?await json[0].text():null;
    for(const file of images){
      const data=await file.arrayBuffer(),hash=await crypto.subtle.digest('SHA-256',data);
      additions.push({file,id:Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join(''),url:URL.createObjectURL(file)});
    }
    for(const asset of additions){const old=assets.get(asset.file.name);if(old)URL.revokeObjectURL(old.url);assets.set(asset.file.name,asset);}
    if(text!==null){source.value=text;fileName=json[0].name;element('file-label').textContent=fileName;}
    invalidate();renderAssets();message('Files ready. Validate the batch to check filenames, questions, and duplicates.');
  }catch(error){for(const asset of additions)if(assets.get(asset.file.name)!==asset)URL.revokeObjectURL(asset.url);message((error as Error).message,'error');}
  finally{setBusy(false);}
}

function effective(row:JsonQuestionRow,key:TagKey):string{return overrides.get(row.rowNumber)?.[key] ?? row[key] ?? '';}
function setTag(row:JsonQuestionRow,key:TagKey,tag:string,remove=false) {
  const tags=parseSpecialTags(effective(row,key));
  const next=remove?tags.filter(t=>t.toLowerCase()!==tag.toLowerCase()):parseSpecialTags([...tags,tag].join(', '));
  overrides.set(row.rowNumber,{...overrides.get(row.rowNumber),[key]:next.join(', ')});
}
function tagKind(label:string) {
  const select=make('select');select.setAttribute('aria-label',label);
  for(const [value,text] of [['tags','Topic tag'],['specialTags','Source badge']]){const option=make('option',text);option.value=value;select.append(option);}
  return select;
}
function addBulk(tag:string,key:TagKey='specialTags') {
  if(busy || !report)return;
  if(!parseSpecialTags(tag).length)return;
  for(const row of report.rows)if(row.isValid)setTag(row,key,tag);
  renderRows();
}
function imageFigures(refs:Array<{file:string;alt:string}>,heading:string) {
  const container=make('div',undefined,'figures');
  for(const ref of refs){
    const figure=make('figure'),asset=assets.get(ref.file);
    if(asset){const img=make('img');img.src=asset.url;img.alt=ref.alt || ref.file;figure.append(img);}
    figure.append(make('figcaption',`${heading} · ${ref.file}${asset?'':' — missing file'}`));container.append(figure);
  }
  return container;
}
function rowDetails(row:JsonQuestionRow) {
  const details=make('details'),summary=make('summary','Preview answers, explanation & figures');details.append(summary);details.open=expanded.has(row.rowNumber);
  let populated=false;
  const populate=()=>{
    if(populated)return;populated=true;
    if(row.imageFiles.length)details.append(imageFigures(row.imageFiles,'Question figure'));
    const answers=make('div',undefined,'answers');
    if(row.matching)for(const choice of row.matching.choices)answers.append(make('div',`${choice.text}${row.matching.correctChoiceId===choice.id?' ✓ Correct match':''}`,`answer${row.matching.correctChoiceId===choice.id?' correct':''}`));
    else for(const key of ['A','B','C','D'] as const)answers.append(make('div',`${key}. ${row[`option${key}`]}${row.correctAnswer===key?' ✓ Correct answer':''}`,`answer${row.correctAnswer===key?' correct':''}`));
    details.append(answers,make('p',row.explanation,'explanation'));
    for(const key of ['A','B','C','D'] as const){const text=row[`explanation${key}`];if(text)details.append(make('p',`${key}: ${text}`,'explanation'));}
    if(row.explanationImageFiles.length)details.append(imageFigures(row.explanationImageFiles,'Explanation figure'));
  };
  details.addEventListener('toggle',()=>{if(details.open){expanded.add(row.rowNumber);populate();}else expanded.delete(row.rowNumber);});
  if(details.open)populate();return details;
}
function rowTags(row:JsonQuestionRow) {
  const container=make('fieldset',undefined,'row-tags');container.disabled=!row.isValid;
  container.append(make('legend',`Tags for question ${row.rowNumber}`,'visually-hidden'));
  for(const key of ['specialTags','tags'] as const){
    for(const tag of parseSpecialTags(effective(row,key))){const chip=button(`${tag} ×`,()=>{setTag(row,key,tag,true);renderRows();},'tag-chip selected');chip.title=`Remove ${key==='tags'?'topic tag':'source badge'} ${tag} from question ${row.rowNumber}`;container.append(chip);}
  }
  for(const tag of presets){if(!parseSpecialTags(effective(row,'specialTags')).some(t=>t.toLowerCase()===tag.toLowerCase()))container.append(button('+ '+tag,()=>{setTag(row,'specialTags',tag);renderRows();},'tag-chip'));}
  const kind=tagKind(`Tag type for question ${row.rowNumber}`),input=make('input');input.placeholder='Custom tag…';input.setAttribute('aria-label',`Custom tag for question ${row.rowNumber}`);
  const apply=()=>{if(!input.value.trim())return;setTag(row,kind.value as TagKey,input.value);renderRows();};
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();apply();}});
  container.append(kind,input,button('Add tag',apply));return container;
}
function renderRows() {
  const rows=element('rows');rows.replaceChildren();
  if(!report)return;
  for(const row of report.rows.slice(0,pageSize)){
    const state=row.isValid?'valid':row.isDuplicate?'duplicate':'invalid',card=make('article',undefined,'question '+state);
    const header=make('div',undefined,'row-heading');
    header.append(make('span',`Question ${row.rowNumber} · ${row.subject || 'Missing subject'} → ${row.lecture || 'Missing lecture'}`),make('span',row.isValid?`Ready · ${row.status}`:row.isDuplicate?'Duplicate · skipped':'Needs correction','row-status '+state));
    card.append(header,make('h3',row.questionText || '(Empty question stem)'));
    if(row.errors.length){const errors=make('ul',undefined,'errors');for(const error of row.errors)errors.append(make('li',error));card.append(errors);}
    card.append(rowDetails(row),rowTags(row));rows.append(card);
  }
  element('show-more').hidden=pageSize>=report.rows.length;
  element('show-more').textContent=`Show 50 more (${Math.min(pageSize,report.rows.length)} of ${report.rows.length} shown)`;
}
async function validate() {
  if(busy)return;
  if(!source.value.trim()){message('Select or paste your JSON questions first.','error');return;}
  setBusy(true,'Checking questions, image filenames, and duplicate content…');
  try {
    report=await request('preview',{jsonContent:source.value,targetLectureId:target(),publication:publication(),imageFiles:manifest()});
    overrides.clear();expanded.clear();pageSize=50;
    element('preview').hidden=false;element('result').hidden=true;
    element('counts').textContent=`${report!.totalRows} question${report!.totalRows===1?'':'s'} · ${report!.validCount} ready · ${report!.duplicateCount} duplicates · ${report!.invalidCount} invalid`;
    const errors=element('validation-errors');errors.textContent=report!.headerErrors.join(' ') || (report!.invalidCount?'Fix all invalid questions and missing files before importing.':'');errors.hidden=!errors.textContent;
    const unused=element('unused');unused.textContent=report!.unusedImages.length?'Unused images will be skipped: '+report!.unusedImages.join(', '):'';unused.hidden=!unused.textContent;
    element<HTMLButtonElement>('confirm').disabled=!report!.validCount || !!report!.invalidCount || !!report!.headerErrors.length;
    element('bulk-tags').hidden=!report!.validCount;renderRows();
    message(report!.validCount && !report!.invalidCount?'Preview ready. Check the figures and tags, then confirm the import.':'Review the validation results below.',report!.invalidCount || report!.headerErrors.length?'error':'info');
    element('preview').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){report=null;element('preview').hidden=true;message((error as Error).message,'error');}
  finally{setBusy(false);}
}
async function confirmImport() {
  if(busy || !report?.validCount || report.invalidCount || report.headerErrors.length)return;
  const snapshot=revision,jsonContent=source.value,targetLectureId=target(),imageFiles=manifest();
  const rowOverrides=Object.fromEntries(overrides),publicationMode=publication();
  const needed=new Set(report.rows.filter(r=>r.isValid).flatMap(r=>[...r.imageFiles,...r.explanationImageFiles].map(f=>f.file)));
  setBusy(true,'Preparing your import…');
  try {
    const uploadedImages:Record<string,QuestionImage>={};let done=0;
    for(const name of needed){
      if(revision!==snapshot)throw new Error('Your import changed. Validate it again.');
      const asset=assets.get(name);if(!asset)throw new Error(`Missing image: ${name}`);
      message(`Storing image ${++done} of ${needed.size} on Telegram: ${name}`,'busy');
      let reference=uploaded.get(asset.id);
      if(!reference){
        const response=await fetch('/api/mcq/image?name='+encodeURIComponent(name),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-MedAtlas-Portal':'1'},body:asset.file});
        const data=await response.json().catch(()=>({error:'The image upload was interrupted. Please retry.'}));
        if(!response.ok)throw new Error(data.error || 'Image upload failed.');
        if(data.id!==asset.id)throw new Error(`Image verification failed: ${name}`);
        reference=data;uploaded.set(asset.id,reference!);
      }
      uploadedImages[name]=reference!;
    }
    message('Saving your questions and tags…','busy');
    const result=await request('execute',{fileName,jsonContent,targetLectureId,imageFiles,uploadedImages,rowOverrides,publication:publicationMode});
    report=null;element('preview').hidden=true;element('result').hidden=false;
    element('result-title').textContent=`${result.batch.importedCount} question${result.batch.importedCount===1?'':'s'} imported`;
    element('result-detail').textContent=`${result.batch.skippedCount} duplicates skipped. ${needed.size} referenced image file${needed.size===1?'':'s'} stored on Telegram. ${publicationMode==='draft'?'Saved as drafts, hidden from students.':'Imported using the statuses in your JSON.'}`;
    const list=element('result-lectures');list.replaceChildren();
    for(const row of result.affectedLectures || [])list.append(make('p',`${row.subjectTitle || 'Subject'} → ${row.title}`));
    message('Import complete. You can upload another batch or attach PDF slide decks.','success');
    await loadLectures().catch(()=>{});
    element('result').scrollIntoView({behavior:'smooth',block:'center'});
  }catch(error){message((error as Error).message+' Successfully uploaded images will be reused when you retry.','error');}
  finally{setBusy(false);}
}

element<HTMLInputElement>('files').addEventListener('change',e=>{const input=e.target as HTMLInputElement;void selectFiles([...input.files || []]);input.value='';});
for(const name of ['dragenter','dragover'])element('dropzone').addEventListener(name,e=>{e.preventDefault();if(!busy)element('dropzone').classList.add('drag');});
for(const name of ['dragleave','drop'])element('dropzone').addEventListener(name,()=>element('dropzone').classList.remove('drag'));
element('dropzone').addEventListener('drop',e=>{e.preventDefault();void selectFiles([...(e as DragEvent).dataTransfer?.files || []]);});
source.addEventListener('input',invalidate);lecture.addEventListener('change',invalidate);element('publication').addEventListener('change',invalidate);
element('lecture-search').addEventListener('input',renderLectures);
element('sample').addEventListener('click',()=>{if(busy)return;invalidate();source.value=getSampleJsonTemplate();fileName='sample-questions.json';element('file-label').textContent=fileName;});
element('format').addEventListener('click',()=>{try{const next=JSON.stringify(JSON.parse(source.value),null,2);source.value=next;invalidate();}catch{message('This JSON cannot be formatted yet. Check its commas and quotes.','error');}});
element('clear-images').addEventListener('click',()=>{for(const asset of assets.values())URL.revokeObjectURL(asset.url);assets.clear();invalidate();renderAssets();});
element('validate').addEventListener('click',()=>void validate());element('confirm').addEventListener('click',()=>void confirmImport());
for(const tag of presets)element('bulk-presets').append(button('+ '+tag,()=>addBulk(tag),'tag-chip'));
const bulkKind=tagKind('Bulk tag type');element('bulk-custom').before(bulkKind);
element('bulk-add').addEventListener('click',()=>{const input=element<HTMLInputElement>('bulk-custom');addBulk(input.value,bulkKind.value as TagKey);input.value='';});
element('show-more').addEventListener('click',()=>{pageSize+=50;renderRows();});
element('new-import').addEventListener('click',()=>{if(busy)return;source.value='';fileName='questions.json';for(const asset of assets.values())URL.revokeObjectURL(asset.url);assets.clear();uploaded.clear();invalidate();renderAssets();element('file-label').textContent='Paste JSON or select a file above.';window.scrollTo({top:0,behavior:'smooth'});});
window.addEventListener('beforeunload',e=>{if(busy){e.preventDefault();e.returnValue='';}});
function renderMatchingImages() {
  const select=element<HTMLSelectElement>('matching-image'), previous=select.value;
  const empty=make('option','Choose an image…');empty.value='';select.replaceChildren(empty);
  for(const name of assets.keys()){const option=make('option',name);option.value=name;select.append(option);}
  select.value=assets.has(previous)?previous:assets.keys().next().value||'';
  const image=element<HTMLImageElement>('matching-image-preview'),asset=assets.get(select.value);
  image.hidden=!asset;if(asset)image.src=asset.url;else image.removeAttribute('src');
}
let matchingRowNumber=0;
function addMatchingLabel() {
  if(element('matching-pairs').children.length>=30){message('Use at most 30 numbered labels per image.','error');return;}
  const row=make('tr'),index=++matchingRowNumber;
  for(const [key,label,value] of [['number','Number',String(index)],['answer','Correct name',''],['explanation','Explanation','']]){
    const cell=make('td'),input=make('input');input.dataset.field=key;input.value=value;
    input.setAttribute('aria-label',`${label} for matching row ${index}`);input.maxLength=key==='number'?4:key==='answer'?300:30000;cell.append(input);row.append(cell);
  }
  const actions=make('td');actions.append(button('Remove',()=>row.remove(),'button subtle'));row.append(actions);element('matching-pairs').append(row);
}
const matchingWizard=guidedUpload('matching',['Image and instructions','Numbered answers','Choices and tags'],step=>{
  if(step===0){if(!assets.has(element<HTMLSelectElement>('matching-image').value))throw new Error('Choose your numbered image first.');if(!element<HTMLInputElement>('matching-instructions').value.trim())throw new Error('Add instructions for the student.');}
  if(step===1){const rows=[...element('matching-pairs').children],numbers=new Set<string>();if(!rows.length)throw new Error('Add at least one numbered label.');for(const row of rows){const number=row.querySelector<HTMLInputElement>('[data-field="number"]')!.value.trim().toUpperCase(),answer=row.querySelector<HTMLInputElement>('[data-field="answer"]')!.value.trim();if(!/^[1-9]\d{0,2}[A-Z]?$/.test(number)||numbers.has(number))throw new Error('Use unique numbers such as 1, 2, or 3A.');if(!answer)throw new Error(`Enter the correct name for label ${number}.`);numbers.add(number);}}
},step=>{if(step===2)element('matching-summary').textContent=`${element('matching-pairs').children.length} labels · ${element<HTMLSelectElement>('matching-image').value}`;});
element('open-matching').addEventListener('click',()=>{if(busy)return;element('matching-builder').hidden=false;if(!element('matching-pairs').children.length){addMatchingLabel();addMatchingLabel();}renderMatchingImages();matchingWizard.reset();element('matching-builder').scrollIntoView({behavior:'smooth',block:'start'});});
element('close-matching').addEventListener('click',()=>{element('matching-builder').hidden=true;});
element('matching-add-label').addEventListener('click',addMatchingLabel);
element('matching-image').addEventListener('change',renderMatchingImages);
element<HTMLInputElement>('matching-image-upload').addEventListener('change',async event=>{const input=event.target as HTMLInputElement;await selectFiles([...input.files||[]]);input.value='';});
element('matching-add-json').addEventListener('click',()=>{
  if(busy)return;
  try{
    const filename=element<HTMLSelectElement>('matching-image').value;
    if(!assets.has(filename))throw new Error('Choose the numbered image first.');
    const matches=Array.from(element('matching-pairs').children).map(row=>Object.fromEntries(Array.from(row.querySelectorAll<HTMLInputElement>('input[data-field]')).map(input=>[input.dataset.field,input.value.trim()])));
    const entry={question_type:'matching',question_text:element<HTMLInputElement>('matching-instructions').value.trim(),images:[filename],matches,
      distractors:element<HTMLTextAreaElement>('matching-distractors').value.split(/\r?\n/).map(text=>text.trim()).filter(Boolean),difficulty:'Medium',tags:parseSpecialTags(element<HTMLInputElement>('matching-tags').value),status:'draft'};
    expandMatchingQuestion(entry,'builder-preview');
    let root=source.value.trim()?JSON.parse(source.value):{questions:[]};
    if(Array.isArray(root))root={questions:root};
    if(!root||!Array.isArray(root.questions))throw new Error('The JSON source must contain a questions array before adding matching labels.');
    root.questions.push(entry);source.value=JSON.stringify(root,null,2);invalidate();element('matching-builder').hidden=true;
    element('file-label').textContent='Matching labels added to your JSON batch.';
    message(`${matches.length} matching labels added. Choose a lecture, then Validate & preview.`);
    element('source').scrollIntoView({behavior:'smooth',block:'center'});
  }catch(error){element('matching-error').textContent=(error as Error).message;element('matching-error').hidden=false;message((error as Error).message,'error');}
});
const creator=installDestinationCreator(lecture,async saved=>{await loadLectures();lecture.value=String(saved.id);invalidate();message(`${saved.contentType==='practical'?'Section':'Lecture'} created and selected. Add your questions next.`);});
void loadLectures().catch(error=>message(error.message,'error'));
if(new URLSearchParams(window.location.search).get('matching')==='1')element('open-matching').click();
