import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_DOCS_PUBLISHED_KEY, type SystemDocsBundle } from 'ghostbuild-agent/system-docs';
import { loadSystemDocs } from './system-docs';

describe('system documentation', () => {
  it('loads the minimal published document bundle', async () => {
    const published = bundle();
    const namespace = kv(JSON.stringify(published));

    await expect(loadSystemDocs(namespace)).resolves.toEqual(published);
    expect(namespace.get).toHaveBeenCalledWith(SYSTEM_DOCS_PUBLISHED_KEY, 'text');
  });

  it('rejects malformed, empty, and extended values', async () => {
    await expect(loadSystemDocs(kv('{'))).resolves.toBeNull();
    await expect(loadSystemDocs(kv(JSON.stringify({ version: 1, documents: [] })))).resolves.toBeNull();
    await expect(loadSystemDocs(kv(JSON.stringify({ ...bundle(), publishedAt: Date.now() })))).resolves.toBeNull();
  });
});

function kv(value: string): KVNamespace {
  return { get: vi.fn(async () => value) } as unknown as KVNamespace;
}

function bundle(): SystemDocsBundle {
  return {
    version: 1,
    documents: [
      {
        id: 'cloudflare-platform',
        description: 'Platform guidance.',
        content: 'Reviewed Cloudflare guidance.',
      },
    ],
  };
}
