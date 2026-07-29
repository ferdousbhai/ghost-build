import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { builderTemplateSeedId, builderTemplateTotals, loadBuilderTemplate } from './builder-template';
import { BUILDER_TEMPLATE_SOURCE_SHA256 } from './builder-template.generated';

describe('server Builder template', () => {
  it('is generated from the same source revision as the browser mirror template', async () => {
    const snapshotManifest = JSON.parse(
      readFileSync(new URL('../../public/template-snapshot-manifest.json', import.meta.url), 'utf8'),
    ) as { sourceSha256: string };
    const entries = await loadBuilderTemplate();
    expect(BUILDER_TEMPLATE_SOURCE_SHA256).toBe(snapshotManifest.sourceSha256);
    expect(builderTemplateSeedId()).toBe(`template_${snapshotManifest.sourceSha256}`);
    expect(entries.some((entry) => entry.path === '/home/project/package.json')).toBe(true);
    expect(entries.some((entry) => entry.path === '/home/project/src/routes/index.tsx')).toBe(true);
    expect(builderTemplateTotals(entries)).toMatchObject({
      fileCount: entries.length,
      totalBytes: expect.any(Number),
    });
  });
});
