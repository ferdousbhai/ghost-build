import { describe, expect, it } from 'vitest';
import { makePartId, type PartId } from 'ghostbuild-agent/partId';
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

  it('marks incomplete late parts aborted and ignores late results until the next turn', () => {
    const store = new ToolActivityStore();
    const firstPart = 'message:0' as PartId;
    const latePart = 'message:1' as PartId;
    const lateActivePart = 'message:2' as PartId;
    const movedLateActivePart = 'message:3' as PartId;

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
    store.record(lateActivePart, {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'tool-3',
      toolName: 'validateProject',
      input: {},
    });

    expect(store.activities.get()[firstPart]?.status).toBe('aborted');
    expect(store.activities.get()[latePart]).toBeUndefined();
    expect(store.activities.get()[lateActivePart]?.status).toBe('aborted');

    store.startTurn();
    store.record(lateActivePart, {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'tool-3',
      toolName: 'validateProject',
      input: {},
    });
    expect(store.activities.get()[lateActivePart]?.status).toBe('aborted');
    store.record(movedLateActivePart, {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'tool-3',
      toolName: 'validateProject',
      input: {},
    });
    expect(store.activities.get()[movedLateActivePart]?.status).toBe('aborted');

    store.record(latePart, {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'tool-2',
      toolName: 'edit',
      input: {},
    });
    expect(store.activities.get()[latePart]?.status).toBe('running');
  });

  it('does not downgrade a completed call when stale progress arrives', () => {
    const store = new ToolActivityStore();
    const partId = 'message:0' as PartId;
    store.record(partId, {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'tool-1',
      toolName: 'write',
      input: { path: '/home/project/src/index.tsx' },
      output: { ok: true },
    });
    store.abortActive();
    store.record(partId, {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'tool-1',
      toolName: 'write',
      input: { path: '/home/project/src/index.tsx' },
    });

    expect(store.activities.get()[partId]?.status).toBe('complete');
    expect(store.activities.get()[partId]?.invocation.state).toBe('output-available');
  });

  it('records a final tool result before stopping provider-ended incomplete calls', () => {
    const store = new ToolActivityStore();
    const completedPart = makePartId('message', 0);
    const incompletePart = makePartId('message', 1);
    store.record(completedPart, {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'tool-1',
      toolName: 'validateProject',
      input: {},
    });
    store.record(incompletePart, {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'tool-2',
      toolName: 'read',
      input: { path: '/home/project/src/index.tsx' },
    });

    store.finishTurn({
      id: 'message',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          state: 'output-available',
          toolCallId: 'tool-1',
          toolName: 'validateProject',
          input: {},
          output: { ok: true },
        },
      ],
    });

    expect(store.activities.get()[completedPart]?.status).toBe('complete');
    expect(store.activities.get()[incompletePart]?.status).toBe('aborted');
  });

  it('does not carry terminal tool-call IDs into another presentation', () => {
    const store = new ToolActivityStore();
    const firstPart = 'first-message:0' as PartId;
    const secondPart = 'second-message:0' as PartId;
    store.activateScope('first-presentation');
    store.startTurn();
    store.record(firstPart, {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'reused-tool-id',
      toolName: 'exec',
      input: { command: 'pnpm test' },
    });
    store.abortActive();

    store.activateScope('second-presentation');
    store.startTurn();
    store.record(secondPart, {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'reused-tool-id',
      toolName: 'exec',
      input: { command: 'pnpm test' },
    });

    expect(store.activities.get()[firstPart]).toBeUndefined();
    expect(store.activities.get()[secondPart]?.status).toBe('running');
  });
});
