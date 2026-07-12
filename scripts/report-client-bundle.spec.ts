import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assetsOverRawLimit,
  collectBundleAssets,
  summarizeBundleAssets,
  totalSizeLimitErrors,
} from './report-client-bundle.mjs';

type BundleAsset = {
  file: string;
  rawBytes: number;
  gzipBytes: number;
  brotliBytes: number;
};

describe('client bundle reporting', () => {
  it('measures reportable assets and ignores source maps', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ghostbuild-bundle-'));
    try {
      writeFileSync(join(directory, 'large.js'), 'a'.repeat(2_000));
      writeFileSync(join(directory, 'small.css'), 'b'.repeat(500));
      writeFileSync(join(directory, 'large.js.map'), 'c'.repeat(10_000));

      const assets = collectBundleAssets(directory) as BundleAsset[];

      expect(assets.map((asset) => asset.file)).toEqual(['large.js', 'small.css']);
      expect(assets[0]).toMatchObject({ rawBytes: 2_000 });
      expect(assets[0].gzipBytes).toBeLessThan(assets[0].rawBytes);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('summarizes assets and finds raw-size regressions', () => {
    const assets: BundleAsset[] = [
      { file: 'large.js', rawBytes: 510_000, gzipBytes: 100_000, brotliBytes: 90_000 },
      { file: 'small.js', rawBytes: 40_000, gzipBytes: 10_000, brotliBytes: 8_000 },
    ];

    expect(summarizeBundleAssets(assets)).toEqual({
      rawBytes: 550_000,
      gzipBytes: 110_000,
      brotliBytes: 98_000,
    });
    expect((assetsOverRawLimit(assets, 500) as BundleAsset[]).map((asset) => asset.file)).toEqual(['large.js']);
    expect(
      totalSizeLimitErrors(summarizeBundleAssets(assets), {
        maxTotalBrotliKilobytes: 90,
        maxTotalGzipKilobytes: 100,
      }),
    ).toEqual(['total gzip size exceeds 100 kB', 'total brotli size exceeds 90 kB']);
  });
});
