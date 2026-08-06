import { atom, map } from 'nanostores';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import type { PartId } from 'ghostbuild-agent/partId';
import { isToolActivityStatusActive, type ToolActivityStatus } from '~/lib/common/types';

type ToolActivity = {
  invocation: GhostbuildToolInvocation;
  status: ToolActivityStatus;
};

export class ToolActivityStore {
  readonly activities = map<Record<PartId, ToolActivity>>({});
  readonly revision = atom(0);
  #scope: string | null = null;
  #turnActive = true;

  activateScope(scope: string): void {
    if (this.#scope === scope) {
      return;
    }
    this.#scope = scope;
    this.#turnActive = false;
    if (Object.keys(this.activities.get()).length > 0) {
      this.activities.set({});
      this.#bumpRevision();
    }
  }

  record(partId: PartId, invocation: GhostbuildToolInvocation): void {
    const activities = this.activities.get();
    const current = activities[partId];
    const status = invocationStatus(invocation);
    const terminal = Object.values(activities).find(
      (activity) =>
        activity.invocation.toolCallId === invocation.toolCallId &&
        (activity.status === 'aborted' || (activity.status === 'complete' && isToolActivityStatusActive(status))),
    );
    if (terminal) {
      if (current !== terminal) {
        this.activities.setKey(partId, terminal);
        this.#bumpRevision();
      }
      return;
    }
    if (!this.#turnActive) {
      if (isToolActivityStatusActive(status)) {
        this.activities.setKey(partId, { invocation, status: 'aborted' });
        this.#bumpRevision();
      }
      return;
    }
    if (current?.invocation === invocation && current.status === status) {
      return;
    }
    this.activities.setKey(partId, { invocation, status });
    this.#bumpRevision();
  }

  startTurn(): void {
    this.#turnActive = true;
  }

  abortActive(): void {
    this.#turnActive = false;
    let changed = false;
    for (const [partId, activity] of Object.entries(this.activities.get()) as Array<[PartId, ToolActivity]>) {
      if (!isToolActivityStatusActive(activity.status)) {
        continue;
      }
      this.activities.setKey(partId, { ...activity, status: 'aborted' });
      changed = true;
    }
    if (changed) {
      this.#bumpRevision();
    }
  }

  #bumpRevision(): void {
    this.revision.set(this.revision.get() + 1);
  }
}

export function invocationStatus(invocation: GhostbuildToolInvocation): ToolActivityStatus {
  switch (invocation.state) {
    case 'input-streaming':
      return 'pending';
    case 'input-available':
    case 'approval-requested':
    case 'approval-responded':
      return 'running';
    case 'output-available':
    case 'output-error':
    case 'output-denied':
      return 'complete';
  }
  throw new Error(`Unsupported tool invocation state: ${String((invocation as { state?: unknown }).state)}`);
}

export const toolActivityStore = new ToolActivityStore();
