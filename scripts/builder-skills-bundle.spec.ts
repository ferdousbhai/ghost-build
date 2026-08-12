import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packBuilderSkills } from './lib/builder-skills.mjs';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('builder skill publication bundle', () => {
  it('preserves official skill trees and derives a deterministic generation', async () => {
    const directory = await fixture();
    const first = await packBuilderSkills(directory);
    const second = await packBuilderSkills(directory);

    expect(first.generation).toBe(second.generation);
    expect(first.manifestSerialized).toBe(second.manifestSerialized);
    expect(first.pointer).toEqual({ version: 1, generation: first.generation, skills: ['cloudflare'] });
    expect(first.entries.map(({ name, path }) => `${name}/${path}`).toSorted()).toEqual([
      'cloudflare/SKILL.md',
      'cloudflare/references/workers.md',
    ]);
    expect(new TextDecoder().decode(first.entries.find(({ path }) => path === 'SKILL.md')!.content)).toBe(
      skill('cloudflare'),
    );
  });

  it('rejects duplicate skill names and symlinks', async () => {
    const directory = await fixture();
    await mkdir(resolve(directory, 'duplicate'));
    await writeFile(resolve(directory, 'duplicate/SKILL.md'), skill('cloudflare'));

    await expect(packBuilderSkills(directory)).rejects.toThrow('duplicate name');
  });
});

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'builder-skills-test-'));
  directories.push(directory);
  await mkdir(resolve(directory, 'cloudflare/references'), { recursive: true });
  await writeFile(resolve(directory, 'cloudflare/SKILL.md'), skill('cloudflare'));
  await writeFile(resolve(directory, 'cloudflare/references/workers.md'), '# Workers\n');
  return directory;
}

function skill(name: string) {
  return `---\nname: ${name}\ndescription: Official ${name} guidance.\n---\n\n# ${name}\n`;
}
