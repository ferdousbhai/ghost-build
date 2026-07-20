import { describe, expect, it } from 'vitest';
import { InvalidMultipartBodyError, readMultipartBodyWithLimits } from './bounded-multipart';

const fields = {
  messages: { kind: 'file', maximumBytes: 64 },
  firstMessage: { kind: 'text', maximumBytes: 64 },
} as const;

describe('readMultipartBodyWithLimits', () => {
  it('materializes only declared file and text fields', async () => {
    const form = new FormData();
    form.append('messages', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }));
    form.append('firstMessage', 'Build a calendar');

    const parts = await readMultipartBodyWithLimits(multipartRequest(form), {
      label: 'Chat backup',
      maximumBytes: 1024,
      fields,
    });

    expect(parts.get('firstMessage')).toBe('Build a calendar');
    const messages = parts.get('messages');
    expect(messages).toBeInstanceOf(Blob);
    await expect((messages as Blob).arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
  });

  it('rejects many duplicate allowed fields before materializing them', async () => {
    const form = new FormData();
    for (let index = 0; index < 500; index++) {
      form.append('firstMessage', '');
    }

    await expect(
      readMultipartBodyWithLimits(multipartRequest(form), {
        label: 'Chat backup',
        maximumBytes: 128 * 1024,
        fields,
      }),
    ).rejects.toBeInstanceOf(InvalidMultipartBodyError);
  });
});

function multipartRequest(body: FormData): Request {
  return new Request('https://ghostbuild.dev/upload', { method: 'POST', body });
}
