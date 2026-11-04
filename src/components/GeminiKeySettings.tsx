import React,{useEffect,useState} from 'react';
import {api} from '../lib/api.ts';

export function GeminiKeySettings() {
  const [status,setStatus]=useState<Awaited<ReturnType<typeof api.getGeminiKeyStatus>>|null>(null);
  const [editing,setEditing]=useState(false),[key,setKey]=useState(''),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[confirmRemove,setConfirmRemove]=useState(false);
  const load=async()=>{setError('');try{setStatus(await api.getGeminiKeyStatus());}catch{setError('Could not load Gemini key settings.');}};
  useEffect(()=>{let active=true;api.getGeminiKeyStatus().then(value=>{if(active)setStatus(value);}).catch(()=>{if(active)setError('Could not load Gemini key settings.');});return()=>{active=false;};},[]);
  const save=async(event:React.FormEvent)=>{
    event.preventDefault();setBusy(true);setError('');setMessage('');
    try{setStatus(await api.saveGeminiKey(key));setKey('');setEditing(false);setMessage('API key saved securely. It has not been tested with Google.');}
    catch{setError('Could not save the key. Check that you pasted a complete Gemini API key and try again.');}
    finally{setBusy(false);}
  };
  const remove=async()=>{setBusy(true);setError('');setMessage('');try{setStatus(await api.removeGeminiKey());setKey('');setEditing(false);setConfirmRemove(false);setMessage('API key removed from your account. You can also revoke it in Google AI Studio.');}catch{setError('Could not remove the key. Please try again.');}finally{setBusy(false);}};
  return <section aria-labelledby="gemini-key-title" className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
    <div><h2 id="gemini-key-title" className="text-base font-bold text-slate-900">Gemini API key</h2>
      <p className="text-sm text-slate-600 mt-1">Save your own key once for use across devices. It is stored encrypted with your account.</p></div>
    <p className="text-xs text-slate-500">Saving a key does not contact Google or use your quota. Short-answer grading uses your Google project's quota and any applicable billing. <a href="/short-answers" className="underline">Open Short Answers</a></p>
    {error&&<div role="alert" className="text-sm text-red-700">{error}{!status&&<button type="button" onClick={load} className="ml-3 underline">Retry</button>}</div>}
    {message&&<p role="status" className="text-sm text-emerald-800">{message}</p>}
    {!status&&!error&&<p role="status" className="text-sm text-slate-500">Loading key settings…</p>}
    {status&&<>
      <p className="text-sm text-slate-700">{status.configured?`Saved key: ${status.maskedKey}`:'No API key saved.'}</p>
      {!status.available&&<p className="text-sm text-amber-800">Secure key storage is temporarily unavailable. You can still remove a saved key.</p>}
      {status.configured&&!editing&&<div className="flex flex-wrap gap-3"><button disabled={busy||!status.available} type="button" onClick={()=>{setEditing(true);setConfirmRemove(false);setMessage('');}} className="px-4 py-2 text-sm border border-slate-300 rounded-lg disabled:opacity-50">Replace key</button><button disabled={busy} type="button" onClick={()=>setConfirmRemove(true)} className="px-4 py-2 text-sm border border-red-200 text-red-700 rounded-lg">Remove key</button></div>}
      {confirmRemove&&<div className="space-y-3 text-sm"><p>Remove the saved key from your MedAtlas account?</p><div className="flex gap-3"><button type="button" disabled={busy} onClick={remove} className="px-4 py-2 rounded-lg bg-red-700 text-white">{busy?'Removing…':'Confirm removal'}</button><button type="button" disabled={busy} onClick={()=>setConfirmRemove(false)} className="px-4 py-2 border rounded-lg">Cancel</button></div></div>}
      {(!status.configured||editing)&&status.available&&<form onSubmit={save} className="space-y-3">
        <label htmlFor="student-gemini-key" className="block text-sm font-semibold text-slate-700">{status.configured?'New Gemini API key':'Gemini API key'}</label>
        <input id="student-gemini-key" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={key} onChange={event=>setKey(event.target.value)} disabled={busy} required maxLength={100} placeholder="Paste your API key" className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"/>
        <div className="flex flex-wrap items-center gap-3"><button type="submit" disabled={busy||!key.trim()} className="px-4 py-2 rounded-lg bg-[var(--ma-brand)] text-white text-sm disabled:opacity-50">{busy?'Saving…':status.configured?'Save replacement':'Save key'}</button>{editing&&<button type="button" disabled={busy} onClick={()=>{setKey('');setEditing(false);setError('');}} className="px-4 py-2 text-sm border rounded-lg">Cancel</button>}<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-sm underline text-[var(--ma-brand)]">Get a Gemini API key</a></div>
      </form>}
    </>}
  </section>;
}
