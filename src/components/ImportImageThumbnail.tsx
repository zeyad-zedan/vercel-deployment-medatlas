import { useEffect, useState } from 'react';
export function ImportImageThumbnail({file,onRemove,disabled=false}:{file:File;onRemove?:()=>void;disabled?:boolean}) {
  const [url,setUrl]=useState('');
  useEffect(()=>{const objectUrl=URL.createObjectURL(file);setUrl(objectUrl);return()=>URL.revokeObjectURL(objectUrl);},[file]);
  return <figure className="overflow-hidden rounded-xl border border-slate-200 bg-white p-2">
    {url && <img src={url} alt={file.name} className="h-24 w-full rounded-lg object-contain"/>}
    <figcaption className="mt-1 break-all text-[11px] text-slate-600">{file.name} · {(file.size/1024).toFixed(0)} KB</figcaption>
    {onRemove && <button type="button" disabled={disabled} onClick={onRemove} className="mt-1 text-[11px] text-red-700 underline">Remove</button>}
  </figure>;
}
