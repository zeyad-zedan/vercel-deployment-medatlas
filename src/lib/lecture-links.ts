export function lectureIdFromSearch(search:string):number|null {
 const value=new URLSearchParams(search).get('lecture');
 if(!value||!/^\d+$/.test(value))return null;
 const id=Number(value);return Number.isSafeInteger(id)&&id>0?id:null;
}
export function lectureHref(lecture:{id:number;contentType?:string}):string {
 if(!Number.isSafeInteger(lecture.id)||lecture.id<1)throw new Error('Invalid lecture link.');
 return `/${lecture.contentType==='practical'?'practical':'lectures'}?lecture=${lecture.id}#lecture-${lecture.id}`;
}
