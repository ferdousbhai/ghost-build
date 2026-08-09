import { describe, expect, it } from 'vitest';
import { isVirtualDocPath, readVirtualDoc, VIRTUAL_DOCS_ROOT } from './virtual-docs.js';

describe('virtual Ghostbuild documentation', () => {
  it('exposes a discoverable immutable index', () => {
    const result = readVirtualDoc({ path: `${VIRTUAL_DOCS_ROOT}/index.md` });

    expect(result?.content[0].text).toContain('cloudflarePlatform.md');
    expect(result?.content[0].text).toContain('frontendDesign.md');
    expect(result?.details.virtual).toBe(true);
  });

  it('reads named guidance with normal line pagination', () => {
    const result = readVirtualDoc({ path: `${VIRTUAL_DOCS_ROOT}/cloudflarePlatform.md`, limit: 5 });

    expect(result?.details.totalLines).toBeGreaterThan(5);
    expect(result?.content[0].text).toContain('Use offset=6 to continue');
  });

  it('returns null for project files and rejects unknown overlay paths', () => {
    expect(readVirtualDoc({ path: '/home/project/src/app.ts' })).toBeNull();
    expect(() => readVirtualDoc({ path: `${VIRTUAL_DOCS_ROOT}/missing.md` })).toThrow(`${VIRTUAL_DOCS_ROOT}/index.md`);
    expect(isVirtualDocPath(`${VIRTUAL_DOCS_ROOT}/index.md`)).toBe(true);
    expect(isVirtualDocPath('/home/project/src/app.ts')).toBe(false);
  });
});
