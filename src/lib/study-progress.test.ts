import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnswerSaveQueue, type AnswerToSave } from './answer-saves.ts';
import { getResumeQuestionIndex, readSessionDrafts, readSessionMatchingDrafts, rememberSessionQuestion } from './session-progress.ts';

test('rapid exam changes save in order and only acknowledge the latest selection', async () => {
  const requests: AnswerToSave[] = [];
  const acknowledge: Array<(value: unknown) => void> = [];
  const saved: string[] = [];
  const queue = new AnswerSaveQueue(answer => {
    requests.push(answer);
    return new Promise(resolve => acknowledge.push(resolve));
  }, (_result, answer) => saved.push(answer.selectedOption), () => {});
  queue.save({ questionId: 1, selectedOption: 'A', lockAnswer: false });
  queue.save({ questionId: 1, selectedOption: 'B', lockAnswer: false });
  queue.save({ questionId: 1, selectedOption: 'C', lockAnswer: false });
  assert.equal(requests.length, 1);
  assert.equal(queue.status, 'saving');
  acknowledge[0]({});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(answer => answer.selectedOption), ['A', 'C']);
  assert.deepEqual(saved, []);
  acknowledge[1]({});
  await queue.flush();
  assert.deepEqual(saved, ['C']);
  assert.equal(queue.status, 'saved');
});

test('a failed answer stays pending and blocks submission until a retry succeeds', async () => {
  let fail = true;
  let persisted: AnswerToSave[] = [];
  const queue = new AnswerSaveQueue(async () => { if (fail) throw Error('Offline'); return {}; }, () => {}, answers => { persisted = answers; });
  queue.save({ questionId: 2, selectedOption: 'B', lockAnswer: true });
  await assert.rejects(queue.flush(), /not been saved/);
  assert.equal(queue.status, 'error');
  assert.equal(persisted[0].selectedOption, 'B');
  fail = false;
  queue.retry();
  await queue.flush();
  assert.equal(queue.status, 'saved');
  assert.deepEqual(persisted, []);
});

test('different questions are saved sequentially so score responses cannot arrive out of order', async () => {
  const requests: number[] = [];
  const releases: Array<(value: unknown) => void> = [];
  const queue = new AnswerSaveQueue(answer => {
    requests.push(answer.questionId);
    return new Promise(resolve => releases.push(resolve));
  }, () => {}, () => {});
  queue.save({ questionId: 10, selectedOption: 'A', lockAnswer: true });
  queue.save({ questionId: 20, selectedOption: 'B', lockAnswer: true });
  assert.deepEqual(requests, [10]);
  releases[0]({});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, [10, 20]);
  releases[1]({});
  await queue.flush();
  assert.equal(queue.status, 'saved');
});

test('completion discards late autosave failures without showing a false error', async () => {
  let reject!: (error: Error) => void;
  let callbacks = 0;
  const queue = new AnswerSaveQueue(() => new Promise((_resolve, fail) => { reject = fail; }), () => { callbacks++; }, () => {});
  queue.save({ questionId: 3, selectedOption: 'D', lockAnswer: false });
  queue.finish();
  reject(Error('Session already completed'));
  await queue.flush();
  assert.equal(queue.status, 'saved');
  assert.equal(queue.unsavedCount, 0);
  assert.equal(callbacks, 0);
});

test('resume uses the exact question ID even when answered questions or ordering change', () => {
  const previous = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } } as Storage;
  try {
    const session = { id: 70, status: 'in_progress', questions: [{ id: 10, submitted: false }, { id: 20, submitted: true }] };
    rememberSessionQuestion(70, 20, 1);
    assert.equal(getResumeQuestionIndex(session), 1);
    assert.equal(getResumeQuestionIndex({ ...session, questions: [...session.questions].reverse() }), 0);
    assert.equal(getResumeQuestionIndex({ ...session, status: 'completed' }), 1);
    values.set('medatlas_session_curr_idx_71', '1');
    assert.equal(getResumeQuestionIndex({ ...session, id: 71 }), 1);
    assert.equal(getResumeQuestionIndex({ ...session, id: 72 }), 0);
    assert.equal(getResumeQuestionIndex({ ...session, questions: [] }), 0);
    values.set('medatlas_session_draft_answers_70', JSON.stringify({ 10: 'B', 20: 'A' }));
    assert.deepEqual(readSessionDrafts(session), { 10: 'B' });
    values.set('medatlas_session_draft_answers_70', JSON.stringify({ version: 1, answers: { 10: 'C', 999: 'D' } }));
    assert.deepEqual(readSessionDrafts({ ...session, mode: 'exam' }), { 10: 'C' });
    assert.deepEqual(readSessionDrafts({ ...session, status: 'completed' }), {});
  } finally { globalThis.localStorage = previous; }
});


test('converted short answers never replay former matching drafts',()=>{
 const previous=globalThis.localStorage;
 globalThis.localStorage={getItem:()=>JSON.stringify({version:1,answers:{1:'A',2:'B'},matchingChoices:{1:'c2'}})} as any;
 try{const session={id:1,mode:'study',status:'in_progress',questions:[{id:1,questionType:'short_answer',shortAnswerId:8},{id:2}]};assert.deepEqual(readSessionDrafts(session),{2:'B'});assert.deepEqual(readSessionMatchingDrafts(session),{});}finally{globalThis.localStorage=previous;}
});
