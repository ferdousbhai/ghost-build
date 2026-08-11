import { describe, expect, it, vi } from 'vitest';
import { loadSystemVirtualDocs, PUBLISHED_CLOUDFLARE_WEEKLY_DOC_KEY } from './system-virtual-docs';

describe('system virtual documentation', () => {
  it('loads only a digest-bound published Cloudflare weekly document', async () => {
    const content = 'Reviewed Cloudflare guidance.';
    const namespace = kv(
      JSON.stringify({
        version: 1,
        docKey: 'cloudflareWeekly',
        sourceRevision: 'a'.repeat(40),
        contentSha256: await digest(content),
        content,
        publishedAt: Date.now(),
      }),
    );

    await expect(loadSystemVirtualDocs(namespace)).resolves.toEqual({ cloudflareWeekly: content });
    expect(namespace.get).toHaveBeenCalledWith(PUBLISHED_CLOUDFLARE_WEEKLY_DOC_KEY, 'text');
  });

  it('ignores malformed and digest-mismatched values', async () => {
    await expect(loadSystemVirtualDocs(kv('{'))).resolves.toEqual({});
    await expect(
      loadSystemVirtualDocs(
        kv(
          JSON.stringify({
            version: 1,
            docKey: 'cloudflareWeekly',
            sourceRevision: 'a'.repeat(40),
            contentSha256: 'b'.repeat(64),
            content: 'changed',
            publishedAt: Date.now(),
          }),
        ),
      ),
    ).resolves.toEqual({});
  });
});

function kv(value: string): KVNamespace {
  return { get: vi.fn(async () => value) } as unknown as KVNamespace;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
