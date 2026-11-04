import {installQuestionImageEditor} from './question-image-editor-client.ts';
/** One shared destination, two clear tasks. Switching modes does not erase the upload draft. */
export function installQuestionWorkflow(lecture:HTMLSelectElement,type:'mcq'|'short_answer'){
 installQuestionImageEditor(lecture,type);
 const upload=document.getElementById('mode-upload')! as HTMLButtonElement,manage=document.getElementById('mode-manage')! as HTMLButtonElement;
 function mode(edit:boolean){document.getElementById('upload-workflow')!.hidden=edit;document.getElementById('image-manager')!.hidden=!edit;for(const el of document.querySelectorAll<HTMLElement>('[data-upload-only]'))el.hidden=edit;upload.className='button '+(edit?'secondary':'primary');manage.className='button '+(edit?'primary':'secondary');upload.setAttribute('aria-pressed',String(!edit));manage.setAttribute('aria-pressed',String(edit));}
 upload.onclick=()=>mode(false);manage.onclick=()=>mode(true);
}
