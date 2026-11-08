import {getAuthToken} from './api.ts';
import type {SessionPlayerApi} from './session-player-api.tsx';

type State = {id:string;position:number;type:string;answered:boolean;choice:number|null;score:number|null;max_marks:number};
type Row = {id:string;position:number;question:any;answer:any;result:any;model_answer?:string;has_image:boolean;max_marks:number};
export type CourseSession = {attemptId:string;title:string;total:number;current:number;completed:boolean;studentUid:string;states:State[];questions:Row[]};
const option = (index:number) => String.fromCharCode(65+index);

export async function courseRequest(slug:string,path:string,body?:unknown,keepalive=false) {
  const response=await fetch(`/api/impulse/quiz/${slug}${path}`,{
    method:body===undefined?'GET':'POST',credentials:'same-origin',keepalive,
    signal:!keepalive&&typeof AbortSignal.timeout==='function'?AbortSignal.timeout(30000):undefined,
    headers:{Authorization:`Bearer ${getAuthToken()||''}`,...(body===undefined?{}:{'Content-Type':'application/json','X-Impulse-Request':'1'})},
    body:body===undefined?undefined:JSON.stringify(body),
  });
  const data=await response.json();
  if(!response.ok)throw Object.assign(Error(data.error||'Please try again.'),{status:response.status});
  return data;
}

/** Translate private, versioned attempts into the existing lecture player's contract. */
export function createCourseSession(slug:string,initial:CourseSession,onFailure:(error:any)=>void) {
  let data=initial,position=initial.current,queue:Promise<unknown>=Promise.resolve();
  const rows=new Map(initial.questions.map(row=>[row.id,row]));
  const sessionId=`course-${initial.studentUid}-${initial.attemptId}`;
  const stateFor=(id:number)=>{const state=data.states.find(s=>s.position===id-1);if(!state)throw Error('Question not available.');return state;};
  const serial=<T>(operation:()=>Promise<T>):Promise<T>=>{
    const pending=queue.catch(()=>{}).then(operation);queue=pending;
    return pending.catch(error=>{if(error.status===401)onFailure(error);throw error;});
  };
  const attempt=(row:Row)=>({answer:row.answer??'',status:row.result?'graded':'saved',result:row.result,
    maxScore:Number(row.max_marks),modelAnswer:row.model_answer||''});
  const summary=()=>{
    const answered=data.states.filter(s=>s.answered),graded=data.states.filter(s=>s.score!==null);
    const earned=graded.reduce((sum,s)=>sum+Number(s.score),0),maximum=data.states.reduce((sum,s)=>sum+Number(s.max_marks),0);
    const short=data.states.filter(s=>s.type==='short_answer');
    return {id:sessionId,title:data.title,privateQuiz:true,mode:'study',status:data.completed?'completed':'in_progress',
      totalQuestions:data.total,resumeIndex:position,elapsedSeconds:0,
      correctCount:graded.filter(s=>Number(s.score)===Number(s.max_marks)).length,
      incorrectCount:graded.filter(s=>Number(s.score)<Number(s.max_marks)).length,unansweredCount:data.total-answered.length,
      scorePercentage:maximum?Math.round(earned/maximum*100):0,
      quizScore:{shortAnswerCount:short.length,earnedMarks:earned,maxMarks:maximum,
        pendingGradingCount:short.filter(s=>s.answered&&s.score===null).length,
        partiallyCorrectCount:graded.filter(s=>Number(s.score)>0&&Number(s.score)<Number(s.max_marks)).length},
    };
  };
  const question=(state:State,row?:Row)=>({id:state.position+1,index:state.position,courseQuestionId:state.id,
    questionType:state.type,lectureTitle:data.title,contentLoaded:Boolean(row),maxMarks:Number(state.max_marks),
    answerCorrect:state.score===null?null:Number(state.score)===Number(state.max_marks),
    hasSavedAnswer:state.answered,submitted:state.type==='mcq'?state.score!==null:state.answered,selectedDisplayed:state.type==='mcq'&&state.choice!==null?option(state.choice):state.answered?(state.score===null?'C':Number(state.score)===Number(state.max_marks)?'A':'B'):null,
    ...(row?{questionText:row.question.text,options:Object.fromEntries((row.question.options||[]).map((text:string,index:number)=>[option(index),text])),
      correctDisplayedOption:Number.isInteger(row.result?.correctOption)?option(row.result.correctOption):undefined,
      explanation:row.result?.feedback||'',shortAnswerAttempt:state.type==='short_answer'&&state.answered?attempt(row):null,
      images:row.has_image?[{id:`course-${slug}-${row.id}`,alt:'Question image',source:`/api/impulse/quiz/${slug}/image/${row.id}`}]:[],
    }:{}),
  });
  const snapshot=(batchRows:Row[]=data.questions)=>({...summary(),questionBatch:{size:6},questions:data.states.map(state=>question(state,batchRows.find(row=>row.id===state.id)))});
  const update=(state:State,answer:any,result:any,modelAnswer?:string)=>{
    state.answered=true;state.choice=state.type==='mcq'?answer:null;state.score=result?.score??null;
    const row=rows.get(state.id);
    if(row){row.answer=answer;row.result=result;if(modelAnswer!==undefined)row.model_answer=modelAnswer;}
    return row;
  };
  const persistPosition=()=>{const savedPosition=position;return serial(async()=>{if(!data.completed)await courseRequest(slug,'/progress',{position:savedPosition},true);return {success:true};});};
  const service:SessionPlayerApi={
    getSessionQuestionBatch:(_id,offset)=>serial(async()=>{
      const next:CourseSession=await courseRequest(slug,`/session?offset=${offset}`);
      data={...data,...next,states:next.states||data.states,current:position};
      next.questions.forEach(row=>{rows.set(row.id,row);const state=data.states.find(s=>s.id===row.id);if(state){state.answered=row.answer!==null;state.choice=state.type==='mcq'?row.answer:null;state.score=row.result?.score??null;}});
      return {session:snapshot(next.questions)};
    }),
    submitQuestionAnswer:(_id,id,selected)=>serial(async()=>{
      const state=stateFor(id),answer=(selected||'').charCodeAt(0)-65;
      if(state.type!=='mcq'||!Number.isInteger(answer)||answer<0||answer>5)throw Error('Choose a valid answer.');
      const saved=await courseRequest(slug,`/answer/${state.id}`,{answer},true);
      const row=update(state,answer,saved.result);
      return {session:{...summary(),questionUpdate:question(state,row)}};
    }),
    saveQuizShortAnswer:(_id,id,answer)=>serial(async()=>{
      const state=stateFor(id);if(state.type!=='short_answer')throw Error('Question not available.');
      const text=answer.trim().normalize('NFC'),row=rows.get(state.id),same=row?.answer===text;
      await courseRequest(slug,`/answer/${state.id}`,{answer:text},true);
      const saved=update(state,text,same?row?.result:null);
      return {session:summary(),attempt:saved?attempt(saved):{answer:text,status:'saved',maxScore:Number(state.max_marks)}};
    }),
    gradeQuizShortAnswer:(_id,id)=>serial(async()=>{
      const state=stateFor(id),row=rows.get(state.id);if(!row)throw Error('Load this question before grading.');
      const graded=await courseRequest(slug,`/grade/${state.id}`,{});
      update(state,row.answer,graded.result,graded.modelAnswer);
      return {session:summary(),attempt:attempt(row)};
    }),
    syncSessionProgress:persistPosition,
    completeSession:()=>serial(async()=>{
      await courseRequest(slug,'/submit',{});
      const next:CourseSession=await courseRequest(slug,`/session?offset=${Math.floor(position/6)*6}&states=1`);
      data=next;next.questions.forEach(row=>rows.set(row.id,row));
      return {session:snapshot(next.questions)};
    }),
  };

  // Preserve unsent responses from the previous player. Never erase originals.
  if(!initial.completed)for(const state of initial.states)try{
    const raw=localStorage.getItem(`impulse-answer-${initial.studentUid}-${slug}-${state.id}`);
    if(raw===null)continue;const value=JSON.parse(raw),id=state.position+1;
    const marker=`medatlas_course_draft_migrated_${sessionId}_${id}`;
    if(localStorage.getItem(marker)===raw)continue;
    if(state.type==='short_answer'&&typeof value==='string'){
      const key=`medatlas_quiz_short_${sessionId}_${id}`;
      if(localStorage.getItem(key)===null)localStorage.setItem(key,value);
    }else if(state.type==='mcq'&&Number.isInteger(value)&&value>=0&&value<=5&&!state.answered){
      const key=`medatlas_session_draft_answers_${sessionId}`,draft=JSON.parse(localStorage.getItem(key)||'{}');
      draft.version=1;draft.answers={...draft.answers,[id]:option(value)};localStorage.setItem(key,JSON.stringify(draft));
    }
    localStorage.setItem(marker,raw);
  }catch{}

  return {service,initialSession:snapshot(),snapshot:()=>snapshot([...rows.values()]),
    onPositionChange:(next:number)=>{if(next===position||data.completed)return;position=next;void persistPosition().catch(onFailure);},
  };
}
