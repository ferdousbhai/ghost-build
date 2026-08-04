import { expect, test, describe } from 'vitest';
import { serializeMessageForStorage } from './messages';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

describe('serializeMessageForStorage', () => {
  test('preserves non-text parts', () => {
    const message: GhostbuildMessage = {
      id: 'test',
      role: 'user',
      parts: [
        {
          type: 'text',
          text: 'some content',
        },
      ],
      createdAt: new Date(),
    };

    const serialized = serializeMessageForStorage(message);

    expect(serialized.parts?.[0]).toEqual({
      type: 'text',
      text: 'some content',
    });
  });

  test('removes the ephemeral stale-send checkpoint from restored history', () => {
    const message = {
      id: 'test',
      role: 'user',
      parts: [{ type: 'text', text: 'some content' }],
      metadata: {
        ghostbuildTranscriptBase: { revision: 2 },
        retained: 'value',
      },
    } as GhostbuildMessage;

    const serialized = serializeMessageForStorage(message);

    expect(serialized.metadata).toEqual({ retained: 'value' });
  });
});
