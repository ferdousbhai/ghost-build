import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  cloudflareAgentsSdk,
  cloudflareEmailService,
  cloudflarePlatform,
  cloudflareSandboxNext,
  cloudflareTurnstile,
  durableObjects,
  webPerf,
  workersBestPractices,
  wrangler,
} from './cloudflare.js';

type UpstreamSource = {
  id: string;
  repository: string;
  defaultBranch: string;
  license: {
    spdx: string;
    url: string;
  };
  trackedPaths: string[];
  discovery: {
    root: string;
    entrypoint: string;
    knownPaths: string[];
  };
  localReferences: string[];
  lastReviewedRelease: {
    id: number;
    tag: string;
    publishedAt: string;
    revision: string;
  } | null;
  lastReviewedRevision: string;
  lastReviewedAt: string;
  lastReviewOutcome: string;
};

const manifest = JSON.parse(readFileSync(new URL('./upstream-sources.json', import.meta.url), 'utf8')) as {
  version: number;
  sources: UpstreamSource[];
};

describe('upstream reference sources', () => {
  it('tracks every Cloudflare skill cited by the bundled guidance', () => {
    const source = manifest.sources.find(({ id }) => id === 'cloudflare-skills');
    expect(source).toBeDefined();

    const references = [
      cloudflarePlatform,
      cloudflareAgentsSdk,
      durableObjects,
      workersBestPractices,
      wrangler,
      cloudflareEmailService,
      cloudflareSandboxNext,
      cloudflareTurnstile,
      webPerf,
    ].join('\n');
    const citedPaths = [...references.matchAll(/github\.com\/cloudflare\/skills\/tree\/main\/(skills\/[a-z0-9-]+)/g)]
      .map((match) => match[1])
      .sort();

    expect(source?.repository).toBe('cloudflare/skills');
    expect(source?.defaultBranch).toBe('main');
    expect(source?.trackedPaths.toSorted()).toEqual(citedPaths);
  });

  it('keeps review checkpoints and local targets machine-readable', () => {
    expect(manifest.version).toBe(2);

    for (const source of manifest.sources) {
      expect(source.lastReviewedRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(source.lastReviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(source.lastReviewOutcome.trim()).not.toBe('');
      expect(source.license.spdx).toMatch(/^[A-Za-z0-9-.+]+$/);
      expect(source.license.url).toMatch(/^https:\/\/github\.com\//);
      if (source.lastReviewedRelease) {
        expect(source.lastReviewedRelease.id).toBeGreaterThan(0);
        expect(source.lastReviewedRelease.tag.trim()).not.toBe('');
        expect(Date.parse(source.lastReviewedRelease.publishedAt)).not.toBeNaN();
        expect(source.lastReviewedRelease.revision).toMatch(/^[0-9a-f]{40}$/);
        expect(source.lastReviewedRelease.revision).toBe(source.lastReviewedRevision);
      }
      expect(source.localReferences.length).toBeGreaterThan(0);
      expect(source.discovery.root).toMatch(/^[a-z0-9-]+$/);
      expect(source.discovery.entrypoint).toBe('SKILL.md');
      expect(source.discovery.knownPaths).toEqual(source.discovery.knownPaths.toSorted());
      expect(new Set(source.discovery.knownPaths).size).toBe(source.discovery.knownPaths.length);
      for (const trackedPath of source.trackedPaths) {
        expect(source.discovery.knownPaths).toContain(trackedPath);
      }
      for (const path of source.localReferences) {
        expect(path).toMatch(/^ghostbuild-agent\/references\/[A-Za-z0-9._-]+\.ts$/);
        expect(path.split('/')).not.toContain('..');
        expect(existsSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)))).toBe(true);
      }
    }
  });
});
