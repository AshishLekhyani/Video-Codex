// In-memory job progress store shared between the convert route (writer) and
// the SSE progress route (reader). Single-process only — fine for this app's
// single-instance deployment, not meant to survive a restart or scale out.

export type ProgressState = {
  stage: string;
  percent: number;
  done: boolean;
  error?: string;
};

const store = new Map<string, ProgressState>();

export function setProgress(id: string, patch: Partial<ProgressState>) {
  const prev = store.get(id) ?? { stage: '', percent: 0, done: false };
  store.set(id, { ...prev, ...patch });
}

export function getProgress(id: string): ProgressState | undefined {
  return store.get(id);
}

export function clearProgress(id: string) {
  store.delete(id);
}
