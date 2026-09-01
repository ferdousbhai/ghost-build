import { describe, expect, it } from 'vitest';
import { modelMessagesToPi } from './pi-message-conversion';

describe('modelMessagesToPi', () => {
  it('unwraps structured AI SDK tool output for Pi history', () => {
    const [message] = modelMessagesToPi([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'read-1',
            toolName: 'read',
            output: { type: 'json', value: { ok: true, summary: 'Read file' } },
          },
        ],
      },
    ]);

    expect(message).toMatchObject({
      role: 'toolResult',
      toolCallId: 'read-1',
      toolName: 'read',
      content: [{ type: 'text', text: '{"ok":true,"summary":"Read file"}' }],
      isError: false,
    });
  });

  it('marks a denied tool result as an error', () => {
    const [message] = modelMessagesToPi([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'exec-1',
            toolName: 'exec',
            output: { type: 'error-text', value: 'User denied execution' },
          },
        ],
      },
    ]);

    expect(message).toMatchObject({
      role: 'toolResult',
      toolCallId: 'exec-1',
      content: [{ type: 'text', text: 'User denied execution' }],
      isError: true,
    });
  });
});
