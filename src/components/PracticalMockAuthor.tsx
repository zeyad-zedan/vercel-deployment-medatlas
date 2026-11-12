import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { maxPracticalMarkingPoints, maxPracticalStations, type PracticalStationUpload } from '../lib/practical-mock.ts';
import type { QuestionImage } from '../lib/question-images.ts';

type DraftStation = Omit<PracticalStationUpload, 'image'> & { key: number; file: File | null };
const newStation = (key: number): DraftStation => ({ key, file: null, question: '', modelAnswer: '', rubric: [{ description: '', marks: 1 }] });
const field = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm';
const label = 'block space-y-1 text-sm font-medium';

function PhotoPreview({ file }: { file: File | null }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    const url = file ? URL.createObjectURL(file) : '';
    setSrc(url);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [file]);
  return src ? <img src={src} alt="Station photo preview" className="max-h-56 max-w-full rounded-lg object-contain" /> : null;
}

export function PracticalMockAuthor({ onCancel, onPublished }: { onCancel: () => void; onPublished: () => void }) {
  const [title, setTitle] = useState('');
  const [stations, setStations] = useState(() => [newStation(0)]);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const nextKey = useRef(1);
  const uploaded = useRef(new WeakMap<File, QuestionImage>());
  const publicationId = useRef('');
  const change = (key: number, values: Partial<DraftStation>) =>
    setStations(current => current.map(station => station.key === key ? { ...station, ...values } : station));

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (progress) return;
    setError('');
    setProgress('Preparing photos…');
    try {
      const payload: PracticalStationUpload[] = [];
      for (const [index, station] of stations.entries()) {
        if (!station.file) throw new Error(`Choose a photo for station ${index + 1}.`);
        setProgress(`Uploading photo ${index + 1} of ${stations.length}…`);
        let image = uploaded.current.get(station.file);
        if (!image) {
          image = await api.uploadQuestionImage(station.file);
          uploaded.current.set(station.file, image);
        }
        payload.push({ image, question: station.question, modelAnswer: station.modelAnswer, rubric: station.rubric });
      }
      setProgress('Publishing exam…');
      publicationId.current ||= crypto.randomUUID();
      await api.publishPracticalMock(publicationId.current, title, payload);
      onPublished();
    } catch (error) { setError((error as Error).message); }
    finally { setProgress(''); }
  }

  return <form onSubmit={publish} className="space-y-5">
    <fieldset disabled={Boolean(progress)} className="space-y-5">
      <div className="ma-dashboard-panel space-y-3">
        <h2 className="text-lg font-bold">New practical mock exam</h2>
        <label className={label}>Exam name<input className={field} required minLength={3} maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label>
      </div>
      {stations.map((station, index) => <section key={station.key} className="ma-dashboard-panel space-y-4" aria-label={`Station ${index + 1}`}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-bold">Station {index + 1}</h3>
          {stations.length > 1 && <button type="button" className="ma-text-button min-h-9" onClick={() => setStations(list => list.filter(item => item.key !== station.key))}>Remove station</button>}
        </div>
        <label className={label}>Photo <span className="text-xs text-slate-500">PNG, JPEG or WebP, up to 2 MB</span>
          <input type="file" required accept="image/png,image/jpeg,image/webp" className={field} onChange={event => change(station.key, { file: event.target.files?.[0] ?? null })} />
        </label>
        <PhotoPreview file={station.file} />
        <label className={label}>Question<textarea className={field} required rows={2} maxLength={1200} value={station.question} onChange={event => change(station.key, { question: event.target.value })} /></label>
        <label className={label}>Model answer<textarea className={field} required rows={3} maxLength={1800} value={station.modelAnswer} onChange={event => change(station.key, { modelAnswer: event.target.value })} /></label>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-semibold">Marking points</legend>
          {station.rubric.map((point, pointIndex) => {
            const update = (values: Partial<typeof point>) => change(station.key, { rubric: station.rubric.map((item, i) => i === pointIndex ? { ...item, ...values } : item) });
            return <div className="flex flex-wrap items-end gap-2" key={pointIndex}>
              <label className={`${label} min-w-40 flex-1`}>Point {pointIndex + 1}<input className={field} required maxLength={240} value={point.description} onChange={event => update({ description: event.target.value })} /></label>
              <label className={`${label} w-20`}>Marks<input className={field} type="number" required min={1} max={10} value={point.marks || ''} onChange={event => update({ marks: Number(event.target.value) })} /></label>
              {station.rubric.length > 1 && <button type="button" className="ma-text-button min-h-9" onClick={() => change(station.key, { rubric: station.rubric.filter((_, i) => i !== pointIndex) })}>Remove point {pointIndex + 1}</button>}
            </div>;
          })}
          {station.rubric.length < maxPracticalMarkingPoints && <button type="button" className="ma-text-button min-h-9" onClick={() => change(station.key, { rubric: [...station.rubric, { description: '', marks: 1 }] })}>Add marking point</button>}
        </fieldset>
      </section>)}
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" className="rounded-lg bg-[var(--ma-brand)] px-4 py-2.5 text-sm font-semibold text-white">Publish exam</button>
        <button type="button" className="ma-text-button min-h-10" disabled={stations.length >= maxPracticalStations} onClick={() => { const key = nextKey.current++; setStations(list => [...list, newStation(key)]); }}>Add station</button>
        <button type="button" className="ma-text-button min-h-10" onClick={onCancel}>Cancel</button>
      </div>
    </fieldset>
    {progress && <p role="status" className="text-sm text-slate-600">{progress}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </form>;
}
