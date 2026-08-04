import { describe, expect, it } from 'vitest';
import { toolSuccess } from 'ghostbuild-agent/tool-result';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { cleanupAssistantMessages } from './message-conversion';

describe('cleanupAssistantMessages', () => {
  it('converts native tool success without a compatibility message shape', async () => {
    const messages = await cleanupAssistantMessages([
      assistantToolMessage({
        type: 'tool-read',
        toolCallId: 'read-1',
        state: 'output-available',
        input: { path: '/home/project/src/app.ts' },
        output: toolSuccess('Read file', { content: 'const answer = 42;' }),
      }),
    ]);

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'read-1',
            toolName: 'read',
            input: { path: '/home/project/src/app.ts' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'read-1',
            toolName: 'read',
            output: {
              type: 'json',
              value: toolSuccess('Read file', { content: 'const answer = 42;' }),
            },
          },
        ],
      },
    ]);
  });

  it('keeps output-error and output-denied typed through model conversion', async () => {
    const messages = await cleanupAssistantMessages([
      assistantToolMessage({
        type: 'tool-read',
        toolCallId: 'read-error',
        state: 'output-error',
        input: { path: '/home/project/missing.ts' },
        errorText: 'File not found',
      }),
      assistantToolMessage({
        type: 'tool-exec',
        toolCallId: 'exec-denied',
        state: 'output-denied',
        input: { command: 'dangerous' },
        approval: { id: 'approval-1', approved: false, reason: 'User denied execution' },
      }),
    ]);

    expect(messages).toContainEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'read-error',
          toolName: 'read',
          output: { type: 'error-text', value: 'File not found' },
        },
      ],
    });
    expect(messages).toContainEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId: 'approval-1',
          approved: false,
          reason: 'User denied execution',
        },
        {
          type: 'tool-result',
          toolCallId: 'exec-denied',
          toolName: 'exec',
          output: { type: 'error-text', value: 'User denied execution' },
        },
      ],
    });
  });
});

function assistantToolMessage(part: GhostbuildMessage['parts'][number]): GhostbuildMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [part],
  };
}
