/** Small local wizard; content and validation stay with each question builder. */
export function guidedUpload(prefix:string,titles:string[],validate:(step:number)=>void,onStep?:(step:number)=>void) {
  const get=(suffix:string)=>document.getElementById(`${prefix}-${suffix}`)!;
  let step=0;
  const show=(value:number)=>{
    step=value;
    titles.forEach((_,index)=>{get(`step-${index}`).hidden=index!==step;});
    get('step-status').textContent=`Step ${step+1} of ${titles.length} · ${titles[step]}`;
    get('back').hidden=step===0;get('next').hidden=step===titles.length-1;get('finish').hidden=step!==titles.length-1;
    get('error').textContent='';get('error').hidden=true;onStep?.(step);
  };
  get('back').addEventListener('click',()=>show(step-1));
  get('next').addEventListener('click',()=>{try{validate(step);show(step+1);get('step-status').scrollIntoView({block:'nearest'});}catch(error){get('error').textContent=(error as Error).message;get('error').hidden=false;}});
  show(0);
  return {reset:()=>show(0)};
}
