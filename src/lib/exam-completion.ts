/** One automatic completion per exam; failures require an explicit retry. */
export class ExamCompletionGate {
  private attempted = new Set<number>();
  private pending = new Set<number>();

  run<T>(sessionId: number, action: () => Promise<T>, retry = false): Promise<T> | undefined {
    if (this.pending.has(sessionId) || (!retry && this.attempted.has(sessionId))) return;
    this.attempted.add(sessionId);
    this.pending.add(sessionId);
    return Promise.resolve().then(action).finally(() => this.pending.delete(sessionId));
  }
}
