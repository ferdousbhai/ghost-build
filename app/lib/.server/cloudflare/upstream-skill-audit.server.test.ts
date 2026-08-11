import { describe, expect, test, vi } from 'vitest';
import upstreamSources from 'ghostbuild-agent/references/upstream-sources.json';
import { diffSkillInventory, discoverSkillPaths, runCloudflareSkillAudit } from './upstream-skill-audit.server';

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
        Response.json({ tree: source.discovery.knownPaths.map((path) => ({ path: `${path}/SKILL.md` })) }),
      );

    const getSecret = vi.fn(async () => 'unused');
    const result = await runCloudflareSkillAudit({ OPENROUTER_API_KEY: { get: getSecret } }, request);

    expect(result.assessment).toBeNull();
    expect(result.addedSkills).toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(getSecret).not.toHaveBeenCalled();
  });

  test('detects an uncited skill and asks the pinned OpenRouter model to assess its bounded diff', async () => {
    const source = upstreamSources.sources[0];
    const head = 'b'.repeat(40);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sha: head }))
      .mockResolvedValueOnce(
        Response.json({
          tree: [
            ...source.discovery.knownPaths.map((path) => ({ path: `${path}/SKILL.md` })),
            { path: 'skills/new-package/SKILL.md' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          files: [{ filename: 'skills/new-package/SKILL.md', status: 'added', patch: '+untrusted evidence' }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"summary":"review"}' } }] }));

    const result = await runCloudflareSkillAudit(
      { OPENROUTER_API_KEY: { get: async () => 'openrouter-secret' } },
      request,
    );

    expect(result.addedSkills).toEqual(['skills/new-package']);
    expect(result.changedTrackedFiles).toEqual(['skills/new-package/SKILL.md']);
    expect(result.assessment).toBe('{"summary":"review"}');
    expect(request.mock.calls[3]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(String(request.mock.calls[3]?.[1]?.body));
    expect(body.model).toBe('~deepseek/deepseek-v4-flash-latest');
    expect(body.messages[0].content).toContain('untrusted evidence');
  });
});
