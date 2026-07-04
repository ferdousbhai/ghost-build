import { expect, test, describe, vi } from 'vitest';
import { serializeMessageForStorage } from './messages';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

vi.mock('lz4-wasm', () => ({
  compress: (data: Uint8Array) => data,
  decompress: (data: Uint8Array) => data,
}));

describe('serializeMessageForStorage', () => {
  test('preserves non-text parts', () => {
    const message: GhostbuildMessage = {
      id: 'test',
      role: 'user',
      content: '',
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
});
