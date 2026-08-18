import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildBuilderSkillGeneration,
  discoverSkillPaths,
  hasSignificantSkillChanges,
  resolveSourceRevisions,
  selectedSkillPaths,
} from './generation';
import { BUILDER_SKILL_SOURCES } from './upstream-sources';

const revision = 'a'.repeat(40);

describe('builder skill mirror', () => {
  it('resolves every configured default branch to an exact commit', async () => {
    const request = async () =>
      Response.json({
        sha: revision,
        commit: { verification: { verified: true } },
      });
    await expect(resolveSourceRevisions(request as typeof fetch)).resolves.toEqual(
      BUILDER_SKILL_SOURCES.map(({ id, repository }) => ({
        id,
        repository,
        revision,
      })),
    );
  });

  it('asks for redirects unfollowed, because the Workers runtime rejects the request otherwise', async () => {
    const modes: (RequestRedirect | undefined)[] = [];
    const request = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      modes.push(init?.redirect);
      return Response.json({ sha: revision, commit: { verification: { verified: true } } });
    }) as typeof fetch;

    await resolveSourceRevisions(request);

    // `redirect: 'error'` is not implemented at the edge, so every daily sync failed on it.
    expect(modes.length).toBeGreaterThan(0);
    expect(modes.every((mode) => mode === 'manual')).toBe(true);
  });

  it('refuses a redirected upstream response instead of trusting its body', async () => {
    const request = (async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.invalid/' } })) as typeof fetch;

    await expect(resolveSourceRevisions(request)).rejects.toThrow(/redirected \(302\)/);
  });

  it('packs unchanged upstream files into the runtime-compatible generation format', async () => {
    const fixture = sourceFixture();
    const packed = await buildBuilderSkillGeneration(fixture.revisions, fixture.request);
    expect(packed.files).toHaveLength(BUILDER_SKILL_SOURCES.reduce((count, item) => count + item.skills.length * 2, 0));
    expect(packed.pointer.skills).toHaveLength(8);
    expect(packed.generation).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(packed.manifestSerialized)).toMatchObject({
      version: 1,
      generation: packed.generation,
    });
  });

  it('automatically selects new top-level Cloudflare skills without adopting named exclusions', async () => {
    const source = BUILDER_SKILL_SOURCES.find(({ id }) => id === 'cloudflare-skills')!;
    const contents = new Map([
      ['skills/durable-objects/SKILL.md', skill('durable-objects')],
      ['skills/new-package/SKILL.md', skill('new-package')],
    ]);
    const tree = ['skills/cloudflare/SKILL.md', ...contents.keys(), 'skills/cloudflare/references/SKILL.md'].map(
      (path) => treeEntry(path, contents.get(path) ?? skill('cloudflare')),
    );
    expect(discoverSkillPaths(tree, 'skills', 'SKILL.md')).toEqual([
      'skills/cloudflare',
      'skills/durable-objects',
      'skills/new-package',
    ]);
    const request = rawRequest(revision, contents);
    await expect(selectedSkillPaths(source, tree, revision, request)).resolves.toEqual([
      'skills/cloudflare',
      'skills/new-package',
    ]);
  });

  it('bounds discovered inventory before fetching candidate metadata', async () => {
    const source = BUILDER_SKILL_SOURCES.find(({ id }) => id === 'cloudflare-skills')!;
    const tree = Array.from({ length: 25 }, (_, index) =>
      treeEntry(`skills/candidate-${index}/SKILL.md`, skill(`candidate-${index}`)),
    );
    let rawFetches = 0;
    const request = (async () => {
      rawFetches += 1;
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    await expect(selectedSkillPaths(source, tree, revision, request)).rejects.toThrow(
      'discovery exceeds its inventory limit',
    );
    expect(rawFetches).toBe(0);
  });

  it('keeps an excluded skill excluded after a path rename', async () => {
    const source = BUILDER_SKILL_SOURCES.find(({ id }) => id === 'cloudflare-skills')!;
    const contents = new Map([['skills/durable-objects-v2/SKILL.md', skill('durable-objects')]]);
    const tree = [...contents].map(([path, content]) => treeEntry(path, content));
    await expect(selectedSkillPaths(source, tree, revision, rawRequest(revision, contents))).resolves.toEqual([]);
  });

  it('treats a newly discovered Cloudflare skill as significant', async () => {
    const previous = 'a'.repeat(40);
    const next = 'b'.repeat(40);
    const newSkill = skill('new-package');
    const observed = BUILDER_SKILL_SOURCES.map(({ id, repository }) => ({
      id,
      repository,
      revision: id === 'cloudflare-skills' ? next : previous,
    }));
    const request = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/git/trees/')) {
        return Response.json({
          truncated: false,
          tree: [
            treeEntry('skills/cloudflare/SKILL.md', skill('cloudflare')),
            ...(url.includes(next) ? [treeEntry('skills/new-package/SKILL.md', newSkill)] : []),
          ],
        });
      }
      return new Response(Uint8Array.from(newSkill));
    };
    await expect(
      hasSignificantSkillChanges(
        new Map(BUILDER_SKILL_SOURCES.map(({ id }) => [id, previous])),
        observed,
        request as typeof fetch,
      ),
    ).resolves.toBe(true);
  });

  it('allows an explicitly selected skill to be removed without blocking the remaining generation', async () => {
    const fixture = sourceFixture({ omitFirstExplicitSkill: true });
    await expect(buildBuilderSkillGeneration(fixture.revisions, fixture.request)).resolves.toMatchObject({
      pointer: {
        skills: expect.not.arrayContaining(['cloudflare']),
      },
    });
  });

  it('preflights file count before fetching resource bodies', async () => {
    const entrypoint = skill('cloudflare');
    let rawFetches = 0;
    const tree = [treeEntry('skills/cloudflare/SKILL.md', entrypoint)];
    for (let index = 0; index < 450; index += 1) {
      const content = new TextEncoder().encode(`resource ${index}`);
      tree.push(treeEntry(`skills/cloudflare/references/${index}.md`, content));
    }
    const request = async (input: RequestInfo | URL) => {
      if (String(input).includes('/git/trees/')) {
        return Response.json({ truncated: false, tree });
      }
      rawFetches += 1;
      return new Response(Uint8Array.from(entrypoint));
    };
    const revisions = BUILDER_SKILL_SOURCES.map(({ id, repository }) => ({
      id,
      repository,
      revision,
    }));
    await expect(buildBuilderSkillGeneration(revisions, request as typeof fetch)).rejects.toThrow('too many files');
    expect(rawFetches).toBeLessThanOrEqual(13);
  });

  it('rejects reader-incompatible catalog descriptions', async () => {
    const fixture = sourceFixture({ description: 'x'.repeat(16_000) });
    await expect(buildBuilderSkillGeneration(fixture.revisions, fixture.request)).rejects.toThrow(
      'system-prompt limit',
    );
  });

  it('rejects malformed UTF-8 in resources that the runtime reads as text', async () => {
    const fixture = sourceFixture({ malformedText: true });
    await expect(buildBuilderSkillGeneration(fixture.revisions, fixture.request)).rejects.toThrow('canonical UTF-8');
  });

  it('fails closed on truncated repository trees', async () => {
    const revisions = BUILDER_SKILL_SOURCES.map(({ id, repository }) => ({
      id,
      repository,
      revision,
    }));
    const request = async () => Response.json({ truncated: true, tree: [] });
    await expect(buildBuilderSkillGeneration(revisions, request as typeof fetch)).rejects.toThrow('incomplete tree');
  });
});

function sourceFixture(
  options: {
    omitFirstExplicitSkill?: boolean;
    description?: string;
    malformedText?: boolean;
  } = {},
) {
  const revisions = BUILDER_SKILL_SOURCES.map(({ id, repository }) => ({
    id,
    repository,
    revision,
  }));
  const files = new Map<string, Uint8Array>();
  const trees = new Map<string, ReturnType<typeof treeEntry>[]>();
  for (const source of BUILDER_SKILL_SOURCES) {
    const entries: ReturnType<typeof treeEntry>[] = [];
    for (const [index, skillPath] of source.skills.entries()) {
      if (options.omitFirstExplicitSkill && source.id === 'cloudflare-skills' && index === 0) {
        continue;
      }
      const name = skillPath.split('/').at(-1)!;
      const entrypoint = skill(name, options.description);
      const reference =
        options.malformedText && source.id === 'cloudflare-skills' && index === 0
          ? Uint8Array.from([0xff, 0xfe])
          : new TextEncoder().encode(`# ${name} reference ${index}\n`);
      for (const [path, bytes] of [
        [`${skillPath}/SKILL.md`, entrypoint],
        [`${skillPath}/references/info.md`, reference],
      ] as const) {
        files.set(`${source.repository}/${path}`, bytes);
        entries.push(treeEntry(path, bytes));
      }
    }
    trees.set(source.repository, entries);
  }
  const request = async (input: RequestInfo | URL) => {
    const url = String(input);
    const source = BUILDER_SKILL_SOURCES.find(({ repository }) => url.includes(repository));
    if (!source) {
      return new Response(null, { status: 404 });
    }
    if (url.includes('/git/trees/')) {
      return Response.json({
        truncated: false,
        tree: trees.get(source.repository),
      });
    }
    const marker = `/${revision}/`;
    const path = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length));
    const bytes = files.get(`${source.repository}/${path}`);
    return bytes ? new Response(Uint8Array.from(bytes)) : new Response(null, { status: 404 });
  };
  return { revisions, request: request as typeof fetch };
}

function rawRequest(targetRevision: string, contents: Map<string, Uint8Array>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const marker = `/${targetRevision}/`;
    const path = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length));
    const bytes = contents.get(path);
    return bytes ? new Response(Uint8Array.from(bytes)) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

function skill(name: string, description = 'Example guidance.'): Uint8Array {
  return new TextEncoder().encode(`---\nname: ${name}\ndescription: ${description}\n---\n\n# Example\n`);
}

function treeEntry(path: string, bytes: Uint8Array) {
  return {
    path,
    sha: gitBlobSha(bytes),
    type: 'blob' as const,
    mode: '100644' as const,
    size: bytes.byteLength,
  };
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}
