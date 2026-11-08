import {randomUUID} from 'node:crypto';
import {imageForStorage} from './telegram-question-images.ts';
export function validateImpulseQuiz(input:any){
 if(!input||typeof input.title!=='string'||!input.title.trim()||input.title.length>180)throw Error('Add a quiz title (up to 180 characters).');
 if(!Array.isArray(input.questions)||!input.questions.length||input.questions.length>100)throw Error('Add between 1 and 100 questions.');
 const questions=input.questions.map((q:any,index:number)=>{
  const fail=(message:string):never=>{throw Error(`Question ${index+1}: ${message}`);};
  if(!q||!['mcq','short_answer'].includes(q.type)||typeof q.text!=='string'||!q.text.trim()||q.text.length>4000)fail('Choose a type and write the question (up to 4,000 characters).');
  let image;
  if(q.image){try{image=imageForStorage({...q.image,source:q.image.source?.replace('/api/impulse/media/','/api/question-images/')});}catch{fail('Upload a valid image first.');}}
  const base={id:typeof q.id==='string'&&/^[a-f0-9-]{36}$/i.test(q.id)?q.id:randomUUID(),type:q.type,text:q.text.trim(),...(image?{image}: {})};
  if(q.type==='mcq'){
   if(!Array.isArray(q.options)||q.options.length<2||q.options.length>6||q.options.some((o:any)=>typeof o!=='string'||!o.trim()||o.length>1000))fail('Enter 2–6 answer choices.');
   if(!Number.isInteger(q.correct)||q.correct<0||q.correct>=q.options.length)fail('Choose the correct answer.');
   if(q.explanation!==undefined&&(typeof q.explanation!=='string'||q.explanation.length>4000))fail('Explanation is too long.');
   return {...base,options:q.options.map((o:string)=>o.trim()),correct:q.correct,explanation:q.explanation||''};
  }
  if(!Array.isArray(q.rubric)||!q.rubric.length||q.rubric.length>15||q.rubric.some((p:any)=>typeof p.description!=='string'||!p.description.trim()||p.description.length>700||!Number.isInteger(p.marks)||p.marks<1||p.marks>10)||q.rubric.reduce((sum:number,p:any)=>sum+p.marks,0)>100)fail('Add 1–15 marking points, each worth 1–10 marks (maximum 100 total).');
  return {...base,rubric:q.rubric.map((p:any,i:number)=>({id:`p${i+1}`,description:p.description.trim(),marks:p.marks})),model_answer:q.rubric.map((p:any)=>p.description.trim()).join('\n')};
 });
 return {title:input.title.trim(),questions};
}
export function publicImpulseQuestion(q:any){return {id:q.id,type:q.type,text:q.text,...(q.type==='mcq'?{options:q.options}:{}),maxMarks:q.type==='mcq'?1:q.rubric.reduce((n:number,p:any)=>n+p.marks,0),hasImage:!!q.image};}
