import { describe, expect, it } from 'vitest';
import type { PartId } from 'ghostbuild-agent/partId';
import { ToolActivityStore } from './tool-activity.client';

describe('ToolActivityStore', () => {
  it('presents SDK tool progress without executing anything in the browser', () => {
    const store = new ToolActivityStore();
    const partId = 'message:0' as PartId;

    store.record(partId, {
      state: 'call',
      toolCallId: 'tool-1',
      toolName: 'write',
      args: { path: 'src/index.ts' },
    });
    expect(store.activities.get()[partId]?.status).toBe('running');

    store.record(partId, {
      state: 'result',
      toolCallId: 'tool-1',
      toolName: 'write',
      args: { path: 'src/index.ts' },
      result: { ok: true },
    });
    expect(store.activities.get()[partId]?.status).toBe('complete');
  });

  it('marks active tools aborted and ignores late parts until the next turn', () => {
    const store = new ToolActivityStore();
    const firstPart = 'message:0' as PartId;
    const latePart = 'message:1' as PartId;

    store.record(firstPart, {
      state: 'partial-call',
      toolCallId: 'tool-1',
      toolName: 'deploy',
      args: {},
    });
    store.abortActive();
    store.record(latePart, {
      state: 'result',
      toolCallId: 'tool-2',
      toolName: 'deploy',
      args: {},
      result: { ok: true },
    });

    expect(store.activities.get()[firstPart]?.status).toBe('aborted');
    expect(store.activities.get()[latePart]).toBeUndefined();

    store.startTurn();
    store.record(latePart, {
      state: 'call',
      toolCallId: 'tool-2',
      toolName: 'edit',
      args: {},
    });
    expect(store.activities.get()[latePart]?.status).toBe('running');
  });
});
