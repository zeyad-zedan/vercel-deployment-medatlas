import {validImageFileName,type QuestionImage} from './question-images.ts';
export type MarkingPoint={id:string;description:string;marks:number};
export type ShortAnswerDefinition={question_text:string;model_answer:string;rubric:MarkingPoint[];tags:string[];status:'draft'|'published';images?:QuestionImage[]};
export type ShortAnswerGrade={score:number;maxScore:number;feedback:string;points:Array<MarkingPoint&{awarded:number;feedback:string}>};
export function parseShortAnswerBatch(source:string):Array<ShortAnswerDefinition&{imageFiles?:Array<{file:string;alt:string}>}> {
  const root=JSON.parse(source),rows=Array.isArray(root)?root:root?.questions;
  if(!Array.isArray(rows)||!rows.length||rows.length>200)throw new Error('Use a questions array with 1–200 short-answer questions.');
  return rows.map((q:any,index:number)=>{
    const fail=(message:string):never=>{throw new Error(`Question ${index+1}: ${message}`);};
    if(!q||typeof q!=='object'||Array.isArray(q))fail('Use a question object.');
    if(Object.keys(q).some(key=>!['question_type','question_text','model_answer','rubric','tags','status','images'].includes(key)))fail('Unknown field. Use the short-answer template.');
    if(q.question_type!==undefined&&q.question_type!=='short_answer')fail('question_type must be short_answer.');
    for(const [field,limit] of [['question_text',4000],['model_answer',6000]] as const)if(typeof q[field]!=='string'||!q[field].trim()||q[field].length>limit)fail(`${field} must contain 1–${limit} characters.`);
    if(!Array.isArray(q.rubric)||!q.rubric.length||q.rubric.length>15)fail('Add 1–15 marking points.');
    const rubric=q.rubric.map((p:any,i:number)=>{
      if(!p||typeof p.description!=='string'||!p.description.trim()||p.description.length>700||!Number.isInteger(p.marks)||p.marks<1||p.marks>10||Object.keys(p).some(k=>!['description','marks'].includes(k)))fail('Each rubric point needs a description (up to 700 characters) and 1–10 integer marks.');
      return {id:`p${i+1}`,description:p.description.trim(),marks:p.marks};
    });
    if(rubric.reduce((sum:number,p:MarkingPoint)=>sum+p.marks,0)>100)fail('Maximum total is 100 marks.');
    if(q.tags!==undefined&&(!Array.isArray(q.tags)||q.tags.length>20||q.tags.some((t:any)=>typeof t!=='string'||!t.trim()||t.length>80)))fail('Use up to 20 text tags.');
    if(q.status!==undefined&&!['draft','published'].includes(q.status))fail('Choose draft or published.');
    if(q.images!==undefined&&(!Array.isArray(q.images)||q.images.length>4))fail('Use up to four question images.');
    const imageFiles=(q.images??[]).map((image:any)=>{
      const file=typeof image==='string'?image:image?.file,alt=typeof image==='string'?'':image?.alt??'';
      if(typeof file!=='string'||!validImageFileName(file)||typeof alt!=='string'||alt.length>500||(typeof image==='object'&&Object.keys(image).some(key=>!['file','alt'].includes(key))))fail('Images must be local PNG, JPEG or WebP filenames with optional alt text. Links and base64 are not accepted.');
      return {file,alt};
    });
    return {question_text:q.question_text.trim(),model_answer:q.model_answer.trim(),rubric,tags:q.tags??[],status:q.status??'draft',...(imageFiles.length?{imageFiles}: {})};
  });
}
export function validateShortAnswerGrade(value:any,rubric:MarkingPoint[]):ShortAnswerGrade {
  if(!value||typeof value.feedback!=='string'||value.feedback.length>1500||!Array.isArray(value.points)||value.points.length!==rubric.length)throw new Error('Invalid grading response.');
  const seen=new Set<string>();
  const points=value.points.map((point:any)=>{
    const rule=rubric.find(p=>p.id===point.id);
    if(!rule||seen.has(point.id)||!Number.isInteger(point.awarded)||point.awarded<0||point.awarded>rule.marks||typeof point.feedback!=='string'||point.feedback.length>700)throw new Error('Invalid marking point.');
    seen.add(point.id);return {...rule,awarded:point.awarded,feedback:point.feedback};
  });
  return {points,feedback:value.feedback,score:points.reduce((sum:number,p:any)=>sum+p.awarded,0),maxScore:rubric.reduce((sum,p)=>sum+p.marks,0)};
}
export const shortAnswerTemplate=JSON.stringify({questions:[{question_type:'short_answer',question_text:'Name three functions of bone.',model_answer:'Support, protection, and movement.',rubric:[{description:'Support of the body',marks:1},{description:'Protection of organs',marks:1},{description:'Movement through leverage and muscle attachment',marks:1}],tags:['Anatomy'],status:'draft'}]},null,2);
