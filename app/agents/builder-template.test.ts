import { describe, expect, it } from 'vitest';
import { builderTemplateSeedId, builderTemplateTotals, loadBuilderTemplate } from './builder-template';
import { BUILDER_TEMPLATE_SOURCE_SHA256 } from './builder-template.generated';

describe('server Builder template', () => {
  it('initializes the durable workspace from the bundled server template', async () => {
    const entries = await loadBuilderTemplate();
    expect(builderTemplateSeedId()).toBe(`template_${BUILDER_TEMPLATE_SOURCE_SHA256}`);
    expect(entries.some((entry) => entry.path === '/home/project/package.json')).toBe(true);
    expect(entries.some((entry) => entry.path === '/home/project/src/routes/index.tsx')).toBe(true);
    expect(builderTemplateTotals(entries)).toMatchObject({
      fileCount: entries.length,
      totalBytes: expect.any(Number),
    });
  });
});
