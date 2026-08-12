import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packSystemDocsDirectory } from './lib/system-docs-bundle.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('system documentation bundle packer', () => {
  it('packs an owner-controlled directory into the minimal runtime contract', async () => {
    const directory = await fixture();
    const first = await packSystemDocsDirectory(directory);

    expect(first.bundle).toEqual({
      version: 1,
      documents: [{ id: 'cloudflare-platform', description: 'Platform guidance.', content: '# Platform\n' }],
    });
    expect(first.managedBundle.documents).toMatchObject([
      { id: 'cloudflare-platform', title: 'Cloudflare platform', content: '# Platform\n' },
    ]);
  });

  it('rejects missing and duplicate document inputs', async () => {
    const directory = await fixture({ duplicate: true });
    await expect(packSystemDocsDirectory(directory)).rejects.toThrow('duplicate document id');
  });
});

async function fixture(options: { duplicate?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ghostbuild-docs-test-'));
  temporaryDirectories.push(directory);
  const entry = {
    id: 'cloudflare-platform',
    title: 'Cloudflare platform',
    description: 'Platform guidance.',
  };
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      version: 1,
      sources: [
        {
          id: 'cloudflare-skills',
          title: 'Cloudflare skills',
          url: 'https://github.com/cloudflare/skills',
          revision: 'a'.repeat(40),
        },
      ],
      documents: options.duplicate ? [entry, entry] : [entry],
    }),
  );
  await writeFile(join(directory, 'cloudflare-platform.md'), '# Platform\n');
  return directory;
}
