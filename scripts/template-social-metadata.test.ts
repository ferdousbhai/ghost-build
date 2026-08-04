import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('generated app social metadata fallback', () => {
  test('uses an absolute current-brand image instead of a bundled legacy asset', () => {
    const html = readFileSync(new URL('../template/src/routes/__root.tsx', import.meta.url), 'utf8');
    const imageUrl = 'https://ghostbuild.dev/social-preview-share-v2.png';

    expect(html.match(new RegExp(imageUrl.replaceAll('.', '\\.'), 'g'))).toHaveLength(2);
    expect(html).not.toContain('/og-preview.jpg');
    expect(existsSync(new URL('../template/public/og-preview.jpg', import.meta.url))).toBe(false);
  });
});
