import type { OptionKey } from './mcq-engine.ts';

export interface AnswerToSave {
  questionId: number;
  selectedOption: OptionKey;
  lockAnswer: boolean;
  elapsedSeconds?: number;
  matchingChoiceId?: string;
}

export type AnswerSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** Serialize session saves so older choices and score responses cannot overwrite newer ones. */
export class AnswerSaveQueue {
  private pending = new Map<number, AnswerToSave>();
  private running = new Map<number, Promise<void>>();
  private failed = new Set<number>();
  private listeners = new Set<() => void>();
  private completed = false;
  private acknowledged = false;

  constructor(
    private send: (answer: AnswerToSave) => Promise<unknown>,
    private onSaved: (result: any, answer: AnswerToSave) => void,
    private persist: (answers: AnswerToSave[], claim?: boolean) => void,
  ) {}

  get status(): AnswerSaveStatus {
    if (this.completed) return 'saved';
    if (this.failed.size) return 'error';
    if (this.pending.size || this.running.size) return 'saving';
    return this.acknowledged ? 'saved' : 'idle';
  }

  get unsavedCount() { return this.pending.size; }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(claim = false) {
    this.persist(Array.from(this.pending.values()), claim);
    for (const listener of this.listeners) listener();
  }

  save(answer: AnswerToSave) {
    if (this.completed) return;
    this.pending.set(answer.questionId, answer);
    this.failed.delete(answer.questionId);
    this.publish(true);
    this.start(answer.questionId);
  }

  private start(questionId: number) {
    if (this.running.size || this.failed.has(questionId) || this.completed) return;
    const task = this.drain(questionId).finally(() => {
      this.running.delete(questionId);
      const nextId = Array.from(this.pending.keys()).find(id => !this.failed.has(id));
      if (nextId !== undefined) this.start(nextId);
      this.publish();
    });
    this.running.set(questionId, task);
  }

  private async drain(questionId: number) {
    while (this.pending.has(questionId) && !this.completed) {
      const answer = this.pending.get(questionId)!;
      try {
        const result = await this.send(answer);
        if (this.completed) return;
        if (this.pending.get(questionId) === answer) {
          this.pending.delete(questionId);
          this.acknowledged = true;
          this.onSaved(result, answer);
          this.publish();
        }
      } catch {
        if (this.completed) return;
        if (this.pending.get(questionId) === answer) {
          this.failed.add(questionId);
          this.publish();
          return;
        }
      }
    }
  }

  retry() {
    const failedIds = Array.from(this.failed);
    this.failed.clear();
    for (const id of failedIds) this.start(id);
    this.publish(true);
  }

  async flush() {
    while (this.running.size) await Promise.all(this.running.values());
    if (this.pending.size) throw new Error('Some answers have not been saved. Select Retry before submitting.');
  }

  finish() {
    this.completed = true;
    this.pending.clear();
    this.failed.clear();
    this.acknowledged = true;
    this.publish();
  }
}
