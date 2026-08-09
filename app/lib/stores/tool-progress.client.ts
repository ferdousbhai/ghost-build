import { map } from 'nanostores';

type ToolProgress = {
  toolCallId: string;
  toolName: string;
  result: unknown;
};

class ToolProgressStore {
  readonly progress = map<Record<string, ToolProgress>>({});

  record(value: ToolProgress): void {
    this.progress.setKey(value.toolCallId, value);
  }

  clear(toolCallId?: string): void {
    if (toolCallId) {
      const next = { ...this.progress.get() };
      delete next[toolCallId];
      this.progress.set(next);
      return;
    }
    this.progress.set({});
  }
}

export const toolProgressStore = new ToolProgressStore();
