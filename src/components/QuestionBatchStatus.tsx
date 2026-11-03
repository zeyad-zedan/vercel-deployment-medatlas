import React from 'react';

export function QuestionBatchStatus({ error, retry }: { error: string | null; retry: () => unknown }) {
  return error ? <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
    {error} <button type="button" className="ml-2 font-semibold underline" onClick={() => { void retry(); }}>Retry loading questions</button>
  </div> : <p role="status" className="p-4 text-center text-sm text-slate-500">Loading questions… Your saved progress stays in place.</p>;
}
