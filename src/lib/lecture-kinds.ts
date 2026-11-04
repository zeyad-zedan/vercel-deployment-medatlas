export type ContentType='lecture'|'practical';
export function destinationLabel(row:{title:string;subjectTitle?:string;contentType?:string;lectureNumber?:number}) {
  return `${row.subjectTitle?row.subjectTitle+' → ':''}${row.contentType==='practical'?`Section ${row.lectureNumber||1}: `:''}${row.title}`;
}
export function catalogByContentType(catalog:any,kind:ContentType) {
  const subjects=(catalog?.subjects||[]).map((subject:any)=>{
    const lectures=(subject.lectures||[]).filter((lecture:any)=>(lecture.contentType||'lecture')===kind);
    return {...subject,lectures,lectureCount:lectures.length,questionCount:lectures.reduce((total:number,lecture:any)=>total+(lecture.questionCount||0),0)};
  }).filter((subject:any)=>subject.lectures.length);
  return {...catalog,subjects,lectures:(catalog?.lectures||[]).filter((lecture:any)=>(lecture.contentType||'lecture')===kind)};
}
