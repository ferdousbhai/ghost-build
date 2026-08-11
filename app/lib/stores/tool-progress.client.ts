import { atom, map } from 'nanostores';

type ToolProgress = {
  toolCallId: string;
  toolName: string;
  result: unknown;
};

class ToolProgressStore {
  readonly progress = map<Record<string, ToolProgress>>({});
  readonly revision = atom(0);

  record(value: ToolProgress): void {
    this.progress.setKey(value.toolCallId, value);
    this.#bumpRevision();
  }

  clear(toolCallId?: string): void {
    if (toolCallId) {
      const current = this.progress.get();
      if (!(toolCallId in current)) {
        return;
      }
      const next = { ...current };
      delete next[toolCallId];
      this.progress.set(next);
      this.#bumpRevision();
      return;
    }
    if (Object.keys(this.progress.get()).length === 0) {
      return;
    }
    this.progress.set({});
    this.#bumpRevision();
  }

  #bumpRevision(): void {
    this.revision.set(this.revision.get() + 1);
  }
}

export const toolProgressStore = new ToolProgressStore();
