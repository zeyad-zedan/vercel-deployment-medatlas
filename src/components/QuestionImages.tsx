import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getAuthToken } from '../lib/api.ts';
import { QUESTION_IMAGE_PREFIX, type QuestionImage } from '../lib/question-images.ts';

type LoadedImage = {url?:string; error?:boolean};
type ImageLoader = {loaded:Record<string,LoadedImage>;ensure:(images:QuestionImage[],retry?:boolean)=>void};
const ImageContext=createContext<ImageLoader|null>(null);

function useImageLoader():ImageLoader {
  const [loaded,setLoaded]=useState<Record<string,LoadedImage>>({});
  const jobs=useRef(new Map<string,{image:QuestionImage;state:'queued'|'loading'|'done'|'error'}>());
  const alive=useRef(false), active=useRef(0), urls=useRef<string[]>([]), abort=useRef(new AbortController());
  const pump=useRef<()=>void>(()=>{});
  pump.current=()=>{
    if(!alive.current)return;
    for(const [id,job] of jobs.current){
      if(active.current>=4)break;
      if(job.state!=='queued')continue;
      job.state='loading';active.current++;
      const signal=abort.current.signal;
      void (async()=>{
        try{
          if(!job.image.source?.startsWith(QUESTION_IMAGE_PREFIX) &&
             !/^\/api\/impulse\/quiz\/[A-Za-z0-9_-]{20,64}\/image\/[a-f0-9-]{36}$/.test(job.image.source||''))throw new Error('Invalid image source');
          const token=getAuthToken();
          const response=await fetch(job.image.source!,{headers:token?{Authorization:`Bearer ${token}`}:{},signal,cache:'no-store'});
          if(!response.ok || !response.headers.get('content-type')?.startsWith('image/'))throw new Error('Image unavailable');
          const blob=await response.blob();
          if(signal.aborted)return;
          const url=URL.createObjectURL(blob);urls.current.push(url);job.state='done';
          setLoaded(old=>({...old,[id]:{url}}));
        }catch{
          if(!signal.aborted){job.state='error';setLoaded(old=>({...old,[id]:{error:true}}));}
        }finally{
          if(!signal.aborted){active.current--;pump.current();}
        }
      })();
    }
  };
  const ensure=useCallback((images:QuestionImage[],retry=false)=>{
    for(const image of images){
      const old=jobs.current.get(image.id);
      if(!old || (retry && old.state==='error')){
        jobs.current.set(image.id,{image,state:'queued'});
        if(retry)setLoaded(prev=>({...prev,[image.id]:{}}));
      }
    }
    pump.current();
  },[]);
  useEffect(()=>{
    alive.current=true;abort.current=new AbortController();active.current=0;
    for(const job of jobs.current.values())if(job.state==='loading')job.state='queued';
    pump.current();
    return ()=>{alive.current=false;abort.current.abort();urls.current.forEach(URL.revokeObjectURL);urls.current=[];};
  },[]);
  return {loaded,ensure};
}

export function useSessionImagePrefetch(questions: any[]) {
  const loader = useContext(ImageContext);
  useEffect(() => { loader?.ensure((questions || []).flatMap(q => [...(q.images || []), ...(q.explanationImages || [])])); }, [questions, loader?.ensure]);
}

/** Prefetch images only for question content fetched so far; reuse object URLs. */
export function QuestionImageProvider({questions,children}:{questions:any[];children:React.ReactNode}) {
  const loader=useImageLoader();
  useEffect(()=>{loader.ensure((questions || []).flatMap(q=>[...(q.images||[]),...(q.explanationImages||[])]));},[questions,loader.ensure]);
  return <ImageContext.Provider value={loader}>{children}</ImageContext.Provider>;
}
export function QuestionImages({images=[]}:{images?:QuestionImage[]}) {
  const context=useContext(ImageContext);
  if(!images.length)return null;
  return context ? <ImageList images={images} loader={context}/> : <StandaloneImages images={images}/>;
}
function StandaloneImages({images}:{images:QuestionImage[]}) {
  const loader=useImageLoader();return <ImageList images={images} loader={loader}/>;
}
function ImageList({images,loader}:{images:QuestionImage[];loader:ImageLoader}) {
  useEffect(()=>{loader.ensure(images);},[images,loader.ensure]);
  return <div className="my-4 grid gap-3" aria-label="Question figures">{images.map((image,index)=>{
    const state=loader.loaded[image.id];
    return <figure key={image.id+index} className="rounded-xl border border-slate-200 bg-white p-3">
      {state?.url ? <img src={state.url} alt={image.alt || `Question figure ${index+1}`} className="mx-auto max-h-[32rem] max-w-full rounded-lg object-contain"/> : state?.error ?
        <div className="p-4 text-center text-sm text-amber-800" role="alert">This figure could not load. <button type="button" className="font-semibold underline" onClick={()=>loader.ensure([image],true)}>Retry image</button></div> :
        <div role="status" className="animate-pulse rounded-lg bg-slate-50 p-6 text-center text-sm text-slate-500">Loading figure {index+1}…</div>}
      {image.alt && <figcaption className="mt-2 text-center text-xs text-slate-500">{image.alt}</figcaption>}
    </figure>;
  })}</div>;
}
