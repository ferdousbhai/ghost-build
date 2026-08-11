import { describe, expect, test, vi } from 'vitest';
import upstreamSources from 'ghostbuild-agent/references/upstream-sources.json';
import {
  diffSkillInventory,
  diffTrees,
  discoverSkillPaths,
  runCloudflareSkillAudit,
  runOpenRouterCanary,
} from './upstream-skill-audit.server';

describe('Cloudflare skill inventory discovery', () => {
  test('finds only top-level skill entrypoints', () => {
    expect(
      discoverSkillPaths(
        [
          'skills/cloudflare/SKILL.md',
          'skills/sandbox-next/SKILL.md',
          'skills/cloudflare/references/nested/SKILL.md',
          'packages/example/SKILL.md',
        ],
        'skills',
        'SKILL.md',
      ),
    ).toEqual(['skills/cloudflare', 'skills/sandbox-next']);
  });

  test('reports both newly added and removed skills independently of cited paths', () => {
    expect(
      diffSkillInventory(['skills/cloudflare', 'skills/removed'], ['skills/cloudflare', 'skills/new-package']),
    ).toEqual({ added: ['skills/new-package'], removed: ['skills/removed'] });
  });

  test('skips model inference when the reviewed revision and inventory are current', async () => {
    const source = upstreamSources.sources[0];
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sha: source.lastReviewedRevision }))
      .mockResolvedValueOnce(
        Response.json({ tree: treeEntries(source.discovery.knownPaths.map((path) => `${path}/SKILL.md`)) }),
      );

    const getSecret = vi.fn(async () => 'unused');
    const result = await runCloudflareSkillAudit({ OPENROUTER_API_KEY: { get: getSecret } }, request);

    expect(result.assessment).toBeNull();
    expect(result.addedSkills).toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(getSecret).not.toHaveBeenCalled();
  });

  test('diffs complete tree inventories without relying on the capped compare API', () => {
    expect(
      diffTrees(
        treeEntries(['skills/cloudflare/SKILL.md', 'skills/removed/SKILL.md'], 0),
        treeEntries(['skills/cloudflare/SKILL.md', 'skills/added/SKILL.md'], 1),
      ),
    ).toEqual(['skills/added/SKILL.md', 'skills/cloudflare/SKILL.md', 'skills/removed/SKILL.md']);
  });

  test('detects an uncited skill and asks the pinned OpenRouter model to assess its bounded diff', async () => {
    const source = upstreamSources.sources[0];
    const head = 'b'.repeat(40);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sha: head }))
      .mockResolvedValueOnce(
        Response.json({
          tree: treeEntries(
            [...source.discovery.knownPaths.map((path) => `${path}/SKILL.md`), 'skills/new-package/SKILL.md'],
            1,
          ),
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          tree: treeEntries(
            source.discovery.knownPaths.map((path) => `${path}/SKILL.md`),
            1,
          ),
        }),
      )
      .mockResolvedValueOnce(Response.json({ content: btoa('untrusted evidence'), encoding: 'base64' }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"summary":"review"}' } }] }));

    const result = await runCloudflareSkillAudit(
      { OPENROUTER_API_KEY: { get: async () => 'openrouter-secret' } },
      request,
    );

    expect(result.addedSkills).toEqual(['skills/new-package']);
    expect(result.changedTrackedFiles).toEqual(['skills/new-package/SKILL.md']);
    expect(result.assessment).toBe('{"summary":"review"}');
    expect(request.mock.calls[4]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(String(request.mock.calls[4]?.[1]?.body));
    expect(body.model).toBe('~deepseek/deepseek-v4-flash-latest');
    expect(body.messages[0].content).toContain('untrusted evidence');
  });

  test('requires manual review instead of silently truncating a large relevant diff', async () => {
    const source = upstreamSources.sources[0];
    const head = 'b'.repeat(40);
    const changed = Array.from({ length: 101 }, (_, index) => `${source.trackedPaths[0]}/reference-${index}.md`);
    const skillPaths = source.discovery.knownPaths.map((path) => `${path}/SKILL.md`);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sha: head }))
      .mockResolvedValueOnce(Response.json({ tree: [...treeEntries(skillPaths), ...treeEntries(changed, 200)] }))
      .mockResolvedValueOnce(Response.json({ tree: [...treeEntries(skillPaths), ...treeEntries(changed, 400)] }));

    const result = await runCloudflareSkillAudit({ OPENROUTER_API_KEY: { get: async () => 'unused' } }, request);

    expect(result.changedTrackedFiles).toHaveLength(101);
    expect(result.requiresManualReview).toBe(true);
    expect(result.assessment).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  });

  test('checks both the stored OpenRouter key and the exact model alias without spending inference', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: { usage: 0 } }))
      .mockResolvedValueOnce(Response.json({ data: { endpoints: [{ name: 'provider' }] } }));

    await expect(
      runOpenRouterCanary({ OPENROUTER_API_KEY: { get: async () => 'openrouter-secret' } }, request),
    ).resolves.toEqual({
      model: '~deepseek/deepseek-v4-flash-latest',
      authorized: true,
      endpointCount: 1,
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://openrouter.ai/api/v1/auth/key',
      'https://openrouter.ai/api/v1/models/~deepseek/deepseek-v4-flash-latest/endpoints',
    ]);
  });
});

function treeEntries(paths: readonly string[], seed = 0) {
  return paths.map((path, index) => ({ path, type: 'blob', sha: shaFor(seed + index) }));
}

function shaFor(value: number): string {
  return value.toString(16).padStart(40, '0').slice(-40);
}
