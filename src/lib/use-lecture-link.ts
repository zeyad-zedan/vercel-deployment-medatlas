import {useEffect,useState} from 'react';
import {lectureIdFromSearch} from './lecture-links.ts';

export function useLectureLinkId(){
 const [id,setId]=useState<number|null>(()=>typeof window==='undefined'?null:lectureIdFromSearch(window.location.search));
 useEffect(()=>{
  const read=()=>setId(lectureIdFromSearch(window.location.search));
  window.addEventListener('popstate',read);window.addEventListener('hashchange',read);
  return()=>{window.removeEventListener('popstate',read);window.removeEventListener('hashchange',read);};
 },[]);
 return id;
}
export function useScrollToLecture(id:number|null,ready:boolean){
 useEffect(()=>{
  if(id&&ready)document.getElementById(`lecture-${id}`)?.scrollIntoView?.({block:'center'});
 },[id,ready]);
}
