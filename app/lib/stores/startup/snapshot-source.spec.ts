import { describe, expect, it } from 'vitest';
import { resolveContainerSnapshotSource } from './snapshot-source';

describe('resolveContainerSnapshotSource', () => {
  it('keeps stored project snapshots untrusted', () => {
    expect(resolveContainerSnapshotSource('https://example.com/project.bin', '/template.bin')).toEqual({
      snapshotUrl: 'https://example.com/project.bin',
      trustedTemplateDependencies: false,
    });
  });

  it('uses the accelerated trusted install only for the bundled template fallback', () => {
    expect(resolveContainerSnapshotSource(null, '/template.bin')).toEqual({
      snapshotUrl: '/template.bin',
      trustedTemplateDependencies: true,
    });
  });
});
