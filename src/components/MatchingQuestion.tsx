import React from 'react';
import { QuestionImages } from './QuestionImages.tsx';
import { BookmarkButton } from './BookmarkButton.tsx';

export function MatchingQuestion({question,questions,choices={},completed=false,exam=false,onSelect,onBookmark}:
  {question:any;questions?:any[];choices?:Record<number,string>;completed?:boolean;exam?:boolean;
    onSelect:(question:any,choice:string)=>void;onBookmark?:(id:number,saved:boolean)=>void}) {
  const rows=(questions||[question]).filter(q=>q.matching?.groupId===question.matching?.groupId);
  return <section aria-label="Numbered image matching" className="space-y-4">
    <QuestionImages images={question.images}/>
    <p className="ma-question-stem font-serif-academic">{question.matching.prompt}</p>
    <p className="text-xs text-slate-500">Choose a name for each numbered label. Each label counts as one question.</p>
    <div className="space-y-3">{rows.map(q=>{
      const selected=choices[q.id]??q.matchingChoiceId??'';
      const locked=completed||(!exam&&q.submitted);
      const reveal=locked&&Boolean(q.matching.correctChoiceId);
      const correct=selected===q.matching.correctChoiceId;
      const answer=q.matching.choices.find((choice:any)=>choice.id===q.matching.correctChoiceId)?.text;
      return <div key={q.id} className={`rounded-lg border p-3 ${reveal&&selected?(correct?'border-emerald-200 bg-emerald-50':'border-rose-200 bg-rose-50'):'border-slate-200 bg-white'}`}>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-w-0 flex-1 items-center gap-3">
            <span className="min-w-12 text-sm font-bold">#{q.matching.number}</span>
            <span className="sr-only">Answer for label {q.matching.number}</span>
            <select value={selected} disabled={locked} onChange={e=>{if(e.target.value)onSelect(q,e.target.value);}}
              className="min-h-11 min-w-0 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 disabled:opacity-100">
              <option value="">Choose a structure…</option>
              {q.matching.choices.map((choice:any)=><option key={choice.id} value={choice.id}>{choice.text}</option>)}
            </select>
          </label>
          <BookmarkButton questionId={q.id} saved={Boolean(q.isBookmarked)} onSaved={saved=>onBookmark?.(q.id,saved)}/>
        </div>
        {reveal&&<p className={`mt-2 text-sm ${correct?'text-emerald-800':'text-rose-800'}`}>{!selected?'Unanswered':correct?'Correct match':'Needs review'} · Correct answer: <strong>{answer}</strong></p>}
        {reveal&&q.explanation&&<p className="mt-2 text-sm text-slate-600">{q.explanation}</p>}
      </div>;
    })}</div>
  </section>;
}

export function MatchingAnswerReview({matching,choiceId}:{matching:any;choiceId?:string|null}) {
  const answer=matching.choices.find((choice:any)=>choice.id===matching.correctChoiceId)?.text;
  const selected=matching.choices.find((choice:any)=>choice.id===choiceId)?.text;
  return <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
    <p>Label <strong>#{matching.number}</strong></p>
    <p>Your answer: <strong>{selected||'Not answered'}</strong></p>
    <p className="text-emerald-800">Correct answer: <strong>{answer}</strong></p>
  </div>;
}
