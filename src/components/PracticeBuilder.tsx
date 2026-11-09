import React, {useState} from 'react';

const control = 'rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus-visible:outline-2 focus-visible:outline-[var(--ma-brand)]';
const toggle = <T,>(value:T, values:T[]) => values.includes(value) ? values.filter(item => item !== value) : [...values,value];

/** All filters use the catalog already loaded by the workspace. */
export function PracticeBuilder({catalog,onStartSession}:{catalog:any;onStartSession:(params:any)=>any}) {
  const [subjects,setSubjects] = useState<number[]>([]);
  const [lectures,setLectures] = useState<number[]>([]);
  const [difficulty,setDifficulty] = useState('all');
  const [count,setCount] = useState(5);
  const [kind,setKind] = useState('all');
  const [mode,setMode] = useState('custom');
  const [shuffle,setShuffle] = useState(true);
  const [options,setOptions] = useState(true);
  const [recent,setRecent] = useState(true);
  const [mistakes,setMistakes] = useState(false);
  const [tag,setTag] = useState('');
  const [specialTags,setSpecialTags] = useState<string[]>([]);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const all = (catalog?.lectures||[]).filter((lecture:any) => kind==='all'||(lecture.contentType||'lecture')===kind);
  const visible = all.filter((lecture:any) => !subjects.length||subjects.includes(lecture.subjectId));
  const scope = lectures.length ? visible.filter((lecture:any) => lectures.includes(lecture.id)) : visible;
  const available = scope.reduce((sum:number,lecture:any) => sum+(difficulty==='all'?(lecture.questionCount||0):(lecture.difficultyBreakdown?.[difficulty]||0)),0);
  const tagLabels = new Map<string,string>();
  for (const lecture of scope) for (const label of Object.keys(lecture.specialTagBreakdown||{})) {
    const normalized = label.toLowerCase()==='old exam'?'old exams':label.toLowerCase();
    if (!tagLabels.has(normalized)) tagLabels.set(normalized,normalized==='old exams'?'Old Exams':label);
  }
  const selectedTags = specialTags.filter(label => tagLabels.has(label.toLowerCase()));
  const resetScope = () => {setLectures([]);setSpecialTags([]);};
  const start = async(event:React.FormEvent) => {
    event.preventDefault();
    if(busy||!available||!Number.isInteger(count)||count<1||count>100)return;
    setBusy(true);setError('');
    try {
      const started = await onStartSession({mode,title:mistakes?'Review mistakes':'Practice quiz',
        subjectIds:subjects.length?subjects:undefined,
        lectureIds:lectures.length?lectures:kind==='all'?undefined:visible.map((lecture:any)=>lecture.id),
        difficulties:difficulty==='all'?undefined:[difficulty],specialTags:selectedTags.length?selectedTags:undefined,
        requestedCount:count,shuffleQuestions:shuffle,shuffleOptions:options,avoidRecent:recent,onlyMistakes:mistakes,tagFilter:tag.trim()||undefined});
      if(started===false)setError('Could not start this quiz. Check the message above and try again.');
    } catch(error:any) {setError(error.message||'Could not start this quiz.');}
    finally {setBusy(false);}
  };
  return <section className="max-w-4xl space-y-5">
    <header><h1 className="text-2xl font-bold">Practice quizzes</h1><p className="mt-2 text-sm text-slate-600">Choose your material and quiz length. Extra settings are optional.</p></header>
    <form className="space-y-6 rounded-xl border border-slate-200 bg-white p-4 sm:p-6" onSubmit={start}>
      <fieldset className="space-y-3" disabled={busy}>
        <legend className="mb-3 text-sm font-semibold">1. Choose your material</legend>
        <label className="block text-sm">Content<select className={control+' ml-3 bg-white'} value={kind} onChange={event=>{setKind(event.target.value);setSubjects([]);resetScope();}}>
          <option value="all">Lectures and practical</option><option value="lecture">Lectures</option><option value="practical">Practical sections</option>
        </select></label>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={!subjects.length} className={control+(!subjects.length?' border-teal-600 bg-teal-50':' bg-white')} onClick={()=>{setSubjects([]);resetScope();}}>All subjects</button>
          {(catalog?.subjects||[]).filter((subject:any)=>all.some((lecture:any)=>lecture.subjectId===subject.id)).map((subject:any)=><button type="button" key={subject.id} aria-pressed={subjects.includes(subject.id)} className={control+(subjects.includes(subject.id)?' border-teal-600 bg-teal-50':' bg-white')} onClick={()=>{setSubjects(toggle(subject.id,subjects));resetScope();}}>{subject.title}</button>)}
        </div>
        <details><summary className="cursor-pointer text-sm font-medium">Choose specific lectures or sections ({lectures.length||'all'})</summary>
          <div className="mt-3 grid max-h-64 gap-2 overflow-auto sm:grid-cols-2">{visible.map((lecture:any)=><label key={lecture.id} className="flex items-center gap-2 rounded-lg border border-slate-200 p-3 text-sm">
            <input type="checkbox" checked={lectures.includes(lecture.id)} onChange={()=>{setLectures(toggle(lecture.id,lectures));setSpecialTags([]);}}/>
            <span>{lecture.title} <small className="text-slate-500">({lecture.contentType==='practical'?'Section':'Lecture'} · {lecture.questionCount||0} questions)</small></span>
          </label>)}{!visible.length&&<p className="text-sm text-slate-500">No published material in this selection yet.</p>}</div>
        </details>
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2" disabled={busy}><legend className="mb-3 text-sm font-semibold">2. Set your quiz</legend>
        <label className="text-sm">Number of questions<input type="number" className={control+' mt-2 block w-full bg-white'} required min={1} max={100} step={1} value={count} onChange={event=>setCount(Number(event.target.value))}/></label>
        <label className="text-sm">Difficulty<select className={control+' mt-2 block w-full bg-white'} value={difficulty} onChange={event=>setDifficulty(event.target.value)}>{['all','Easy','Medium','Hard'].map(value=><option key={value} value={value}>{value==='all'?'All difficulties':value}</option>)}</select></label>
      </fieldset>
      <details><summary className="cursor-pointer text-sm font-semibold">Advanced settings</summary><fieldset className="mt-4 grid gap-3 text-sm sm:grid-cols-2" disabled={busy}><legend className="sr-only">Optional quiz settings</legend>
        <label className="flex items-start gap-2"><input type="checkbox" checked={shuffle} onChange={event=>setShuffle(event.target.checked)}/>Shuffle questions</label>
        <label className="flex items-start gap-2"><input type="checkbox" checked={options} onChange={event=>setOptions(event.target.checked)}/>Shuffle answer choices</label>
        <label className="flex items-start gap-2"><input type="checkbox" checked={recent} onChange={event=>setRecent(event.target.checked)}/>Prefer questions I have not answered recently</label>
        <label className="flex items-start gap-2"><input type="checkbox" checked={mistakes} onChange={event=>setMistakes(event.target.checked)}/>Review my mistakes only</label>
        <label>Topic keyword<input className={control+' mt-2 block w-full bg-white'} value={tag} onChange={event=>setTag(event.target.value)}/></label>
        <label>Mode<select className={control+' mt-2 block w-full bg-white'} value={mode} onChange={event=>setMode(event.target.value)}><option value="custom">Study with feedback</option><option value="exam">Exam — answers after submission</option></select></label>
        {tagLabels.size>0&&<fieldset className="sm:col-span-2"><legend className="mb-2 font-medium">Question tags</legend><div className="flex flex-wrap gap-3">{[...tagLabels.values()].map(label=><label key={label} className="flex items-center gap-2"><input type="checkbox" checked={selectedTags.includes(label)} onChange={()=>setSpecialTags(toggle(label,selectedTags))}/>{label}</label>)}</div></fieldset>}
      </fieldset></details>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
        <p className="text-sm text-slate-600">{available} questions in your selection{tag||mistakes||selectedTags.length?' before advanced filters':''}{available>0&&available<count?' · We will use all available questions.':''}</p>
        <button disabled={busy||!available||!Number.isInteger(count)||count<1||count>100} className="rounded-lg bg-[var(--ma-brand)] px-5 py-3 font-semibold text-white hover:bg-[var(--ma-brand-hover)] disabled:opacity-50">{busy?'Starting…':'Start practice'}</button>
      </div>
      {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
    </form>
  </section>;
}
