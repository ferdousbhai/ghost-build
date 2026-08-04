import { describe, expect, it } from 'vitest';
import type { PartId } from 'ghostbuild-agent/partId';
import { ToolActivityStore } from './tool-activity.client';

describe('ToolActivityStore', () => {
  it('presents SDK tool progress without executing anything in the browser', () => {
    const store = new ToolActivityStore();
    const partId = 'message:0' as PartId;

    store.record(partId, {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'tool-1',
      toolName: 'write',
      input: { path: 'src/index.ts' },
    });
    expect(store.activities.get()[partId]?.status).toBe('running');

    store.record(partId, {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'tool-1',
      toolName: 'write',
      input: { path: 'src/index.ts' },
      output: { ok: true },
    });
    expect(store.activities.get()[partId]?.status).toBe('complete');
  });

  it('marks active tools aborted and ignores late parts until the next turn', () => {
    const store = new ToolActivityStore();
    const firstPart = 'message:0' as PartId;
    const latePart = 'message:1' as PartId;

    store.record(firstPart, {
      type: 'dynamic-tool',
      state: 'input-streaming',
      toolCallId: 'tool-1',
      toolName: 'deploy',
      input: undefined,
    });
    store.abortActive();
    store.record(latePart, {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'tool-2',
      toolName: 'deploy',
      input: {},
      output: { ok: true },
    });

    expect(store.activities.get()[firstPart]?.status).toBe('aborted');
    expect(store.activities.get()[latePart]).toBeUndefined();

    store.startTurn();
    store.record(latePart, {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'tool-2',
      toolName: 'edit',
      input: {},
    });
    expect(store.activities.get()[latePart]?.status).toBe('running');
  });
});
