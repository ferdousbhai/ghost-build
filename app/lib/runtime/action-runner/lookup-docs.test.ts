import { describe, expect, it, vi } from 'vitest';
import { toolResultContent } from 'ghostbuild-agent/tool-result';
import { runLookupDocs } from './lookup-docs';

describe('lookupDocs synchronized skill fallback', () => {
  it('returns bundled guidance when Cloudflare storage has no active manifest', async () => {
    const get = vi.fn(async () => null);
    const result = await runLookupDocs(
      {
        state: 'call',
        toolCallId: 'tool-1',
        toolName: 'lookupDocs',
        args: { docs: ['cloudflarePlatform'] },
      },
      { APP_STORAGE: { get } as unknown as R2Bucket },
    );

    expect(toolResultContent(result)).toContain('Official Cloudflare skill: cloudflare');
    expect(toolResultContent(result)).not.toContain('Current upstream skill snapshot');
  });
});
