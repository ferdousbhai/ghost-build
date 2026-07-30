import { describe, expect, it, vi } from 'vitest';
import { loadActiveUpstreamSkills } from './active-skill-content';
import { sha256Hex } from './skill-content';

describe('active synchronized skill loading', () => {
  it('loads and verifies requested upstream content', async () => {
    const content = `---
name: cloudflare
description: Current Cloudflare guidance.
---

# Current
`;
    const bytes = new TextEncoder().encode(content);
    const contentSha256 = await sha256Hex(bytes);
    const storageKey = `system/skills/blobs/${contentSha256}.md`;
    const manifest = {
      schemaVersion: 1,
      source: {
        id: 'cloudflare-skills',
        repository: 'cloudflare/skills',
        treeSha: 'a'.repeat(40),
      },
      activatedAt: 123,
      skills: {
        cloudflarePlatform: {
          storageKey,
          contentSha256,
          upstreamBlobSha: 'b'.repeat(40),
        },
      },
    };
    const get = vi.fn(async (key: string) =>
      key === 'system/skills/active.json'
        ? {
            size: JSON.stringify(manifest).length,
            json: async () => manifest,
          }
        : key === storageKey
          ? {
              size: bytes.byteLength,
              arrayBuffer: async () => bytes.buffer,
            }
          : null,
    );

    await expect(
      loadActiveUpstreamSkills({ APP_STORAGE: { get } as unknown as R2Bucket }, ['cloudflarePlatform']),
    ).resolves.toEqual({ cloudflarePlatform: content });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('uses no synchronized content when the active manifest is unavailable', async () => {
    const get = vi.fn(async () => null);

    await expect(
      loadActiveUpstreamSkills({ APP_STORAGE: { get } as unknown as R2Bucket }, ['cloudflarePlatform']),
    ).resolves.toEqual({});
    expect(get).toHaveBeenCalledOnce();
  });
});
