/** Shared creation form for the MCQ/matching and short-answer upload pages. */
export function installDestinationCreator(target:HTMLSelectElement,onCreated:(saved:any)=>Promise<void>) {
 const details=document.createElement('details');details.className='guided-builder';details.dataset.uploadOnly='';
 const summary=document.createElement('summary');summary.textContent='Create a new lecture or practical section';details.append(summary);
 const fields=document.createElement('fieldset');details.append(fields);
 function field(label:string,input:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement){const id='destination-'+label.toLowerCase().replace(/[^a-z]+/g,'-');input.id=id;const caption=document.createElement('label');caption.htmlFor=id;caption.textContent=label;fields.append(caption,input);return caption;}
 const subject=document.createElement('select');field('Subject',subject);
 const kind=document.createElement('select');kind.append(new Option('Practical — Section','practical'),new Option('Lecture','lecture'));field('Content type',kind);
 const number=document.createElement('input');number.type='number';number.min='1';number.step='1';number.value='1';const numberLabel=field('Section number',number);
 const title=document.createElement('input');title.maxLength=200;const titleLabel=field('Section title',title);
 const description=document.createElement('textarea');description.rows=2;description.maxLength=4000;field('Description (optional)',description);
 const status=document.createElement('select');status.append(new Option('Draft — hidden from students','draft'),new Option('Published — visible to students','published'));field('Publication status',status);
 const hint=document.createElement('p');hint.className='hint';hint.textContent='Start as a draft, upload the questions, then publish from Admin Console → Lectures & Sections. The questions also need to be published.';fields.append(hint);
 const notice=document.createElement('p');notice.className='hint';notice.setAttribute('role','status');fields.append(notice);
 const create=document.createElement('button');create.type='button';create.className='button primary';create.textContent='Create section';fields.append(create);
 kind.onchange=()=>{const section=kind.value==='practical';numberLabel.textContent=section?'Section number':'Lecture number';titleLabel.textContent=section?'Section title':'Lecture title';create.textContent=section?'Create section':'Create lecture';};
 create.onclick=async()=>{
  if(!subject.value||!title.value.trim()||!Number.isInteger(Number(number.value))||Number(number.value)<1){notice.textContent='Choose a subject, enter a title and use a positive whole number.';return;}
  fields.disabled=true;notice.textContent='Creating…';
  try{const response=await fetch('/api/mcq/destinations',{method:'POST',headers:{'Content-Type':'application/json','X-MedAtlas-Portal':'1'},body:JSON.stringify({subjectId:Number(subject.value),contentType:kind.value,lectureNumber:Number(number.value),title:title.value.trim(),description:description.value.trim(),status:status.value})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not create this entry.');await onCreated(data.lecture);notice.textContent=`${kind.value==='practical'?'Section':'Lecture'} created and selected for upload.`;title.value='';description.value='';details.open=false;}catch(error){notice.textContent=(error as Error).message;}finally{fields.disabled=false;}
 };
 target.insertAdjacentElement('afterend',details);
 return {setSubjects:(subjects:Array<{id:number;title:string;status?:string}>)=>{const selected=subject.value;subject.replaceChildren(new Option('Choose a subject…',''));for(const row of subjects)subject.append(new Option(row.title+(row.status&&row.status!=='published'?` [${row.status}]`:''),String(row.id)));subject.value=selected;}};
}
